# p8 Multi-Repo VCS Support via Plugin Extension Point

**Date**: 2026-07-01
**Status**: draft

## Context

OpenCode's web app Review feature (`packages/app`) shows diffs from a single git repository. The Review tab calls `sdk().client.vcs.diff({ mode })`, which flows through the HTTP API (`GET /vcs/diff`) to `Vcs.Service` in `packages/opencode/src/project/vcs.ts`, which runs `git diff` against `ctx.directory`.

The PonyAI engineering workspace (`/home/zubingtan/work/ponyai`) is a p8 multi-repo workspace: the workspace root is **not** a git repository. Instead, `.sub-repos/<name>/` (common, perception, pnc, map, sensors, etc.) contains 10+ independent git repositories, with symlinks from the workspace root into `.sub-repos/common/`.

`Project.resolve()` (`packages/core/src/project.ts:110`) traverses upward looking for `.git`. At the workspace root it finds none, so the project is marked `vcs: undefined`, and every `Vcs.Service` method early-returns empty (`vcs.ts:307,350,376,389,402`). The Review tab shows nothing.

This fork (`zubingtan/opencode`, upstream `anomalyco/opencode`) needs to:

1. Make Review work on p8 multi-repo workspaces
2. Keep CI (unit tests + Playwright e2e + typecheck) running on every PR
3. Stay syncable with upstream releases

## Goals

- Web app Review tab shows aggregated diffs across all sub-repos in a p8 workspace
- p8 multi-repo logic lives entirely in a plugin (zero upstream conflict, maintainable, extensible)
- Core gets a generic VCS provider extension point (additive, upstreamable, benefits any multi-repo or non-git workspace)
- All existing git-only behavior is unchanged
- CI runs all unit tests + Playwright e2e + typecheck on every PR using GitHub-hosted runners
- Upstream sync via merge remains low-conflict

## Design

### Architecture & Layering

Dependency direction follows the repo rule (`Schema -> Core -> Protocol -> Server`):

```
Schema (packages/schema)
  └─ Project.Vcs union: "git" | "custom"
       (src/project.ts:11 — Schema.Literal("git") -> Schema.Union)

Core (packages/core)
  ├─ VcsProvider interface + VcsProviderRegistry  [NEW FILE: src/vcs-provider.ts]
  └─ Project.resolve fallback: git not found -> query registry  [src/project.ts:110]

Plugin (packages/plugin)
  └─ PluginContext.vcs hook: ctx.vcs.register(provider)  [src/v2/effect/context.ts]

Server (packages/opencode)
  └─ Vcs.Service dispatch: vcs.type==="custom" -> registry.get(provider)  [src/project/vcs.ts]

p8-repo plugin [NEW PACKAGE]
  └─ implements VcsProvider, registers via ctx.vcs.register()
```

### Core Extension Point

#### 1. Schema: extend `Project.Vcs` (`packages/schema/src/project.ts:11`)

Current:

```ts
export const Vcs = Schema.Literal("git").annotate({ identifier: "Project.Vcs" })
```

After:

```ts
export const Vcs = Schema.Union([
  Schema.Literal("git"),
  Schema.Struct({ type: Schema.Literal("custom"), provider: Schema.String }),
]).annotate({ identifier: "Project.Vcs" })
```

The `custom` variant is generic: `provider` is a string id (e.g. `"p8-repo"`) that the registry dispatches on. This keeps Schema browser-safe (no runtime imports) and lets any plugin register a custom VCS.

**Two Vcs schemas, both extended.** There are two distinct Vcs schemas that both need the `custom` variant:

- **Schema package** (`packages/schema/src/project.ts:11`): `Project.Vcs = Schema.Literal("git")` — the public wire type on `Project.Info.vcs`. Just the string `"git"`. Extended to `Union([Literal("git"), Struct({ type: Literal("custom"), provider: String })])`. This changes the wire type from `string` to `string | object`, but `Project.Info.vcs` is not exposed as a typed client API (the web app queries `GET /vcs/diff`, not `Project.Info` directly), so no SDK regen is needed.

- **Core package** (`packages/core/src/project/schema.ts:10`): `ProjectSchema.Vcs = Schema.Union([Struct({ type: "git", store: AbsolutePath })])` — the internal resolved type returned by `Project.resolve`. Extended to:

```ts
export const Vcs = Schema.Union([
  Schema.Struct({ type: Schema.Literal("git"), store: AbsolutePath }),
  Schema.Struct({ type: Schema.Literal("custom"), provider: Schema.String }),
])
```

#### 2. Core: `VcsProvider` interface + registry (`packages/core/src/vcs-provider.ts` — new file)

```ts
import { Context, Effect } from "effect"
import type { AbsolutePath } from "./schema"
import type { FileDiff, FileStatus, Mode, DiffOptions, ApplyInput, ApplyResult, PatchApplyError } from "./vcs-types"

export interface VcsProvider {
  readonly id: string
  match: (directory: string) => Effect.Effect<boolean>
  branch: (directory: string) => Effect.Effect<string | undefined>
  defaultBranch: (directory: string) => Effect.Effect<string | undefined>
  status: (directory: string) => Effect.Effect<FileStatus[]>
  diff: (directory: string, mode: Mode, options?: DiffOptions) => Effect.Effect<FileDiff[]>
  diffRaw: (directory: string) => Effect.Effect<string>
  apply: (directory: string, input: ApplyInput) => Effect.Effect<ApplyResult, PatchApplyError>
}

export interface VcsProviderRegistry {
  register: (provider: VcsProvider) => Effect.Effect<void>
  match: (directory: string) => Effect.Effect<VcsProvider | undefined>
  get: (providerId: string) => Effect.Effect<VcsProvider | undefined>
}

export class VcsProviderRegistryService extends Context.Service<VcsProviderRegistryService, VcsProviderRegistry>()(
  "@opencode/VcsProviderRegistry",
) {}
```

The shared VCS types (`FileDiff`, `FileStatus`, `Mode`, `DiffOptions`, `ApplyInput`, `ApplyResult`, `PatchApplyError`) currently live in `packages/opencode/src/project/vcs.ts`. They need to move to `packages/core/src/vcs-types.ts` (new file) so Core can reference them without importing Server. This is a pure move + re-export; the Server file keeps `export * from "@opencode-ai/core/vcs-types"` for backward compatibility.

**Plugin framework dependency constraint.** `packages/plugin` does not depend on `packages/core` (it's a lightweight framework for external plugin authors). The `VcsProvider` interface lives in Core, but the plugin hook in `packages/plugin` cannot import it. Solution: `packages/plugin/src/v2/effect/vcs.ts` defines a structural `VcsProviderLike` interface (same shape as Core's `VcsProvider`, but without importing Core). TypeScript structural typing means a plugin implementing `VcsProviderLike` automatically satisfies Core's `VcsProvider`. The p8-repo plugin (which depends on both `@opencode-ai/plugin` and `@opencode-ai/core`) implements Core's `VcsProvider` directly; the plugin framework's `VcsProviderLike` is only for the hook signature.

#### 3. Core: `Project.resolve` fallback (`packages/core/src/project.ts:110-122`)

Current:

```ts
const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
  const repo = yield* git.repo.discover(input)
  if (!repo) return { id: ID.global, directory: ..., vcs: undefined }
  // ... git path
})
```

After (additive fallback):

```ts
const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
  const repo = yield* git.repo.discover(input)
  if (repo) {
    // existing git path — unchanged
    const previous = yield* cached(repo.commonDirectory)
    const id = (yield* remote(repo)) ?? previous ?? (yield* root(repo))
    return {
      previous,
      id: id ?? ID.global,
      directory: repo.worktree,
      vcs: { type: "git" as const, store: repo.commonDirectory },
    }
  }

  // fallback: query registered VCS providers
  const registry = yield* VcsProviderRegistryService
  const provider = yield* registry.match(input)
  if (provider)
    return {
      id: ID.make(Hash.fast(`custom-vcs:${provider.id}:${input}`)),
      directory: input,
      vcs: { type: "custom" as const, provider: provider.id },
    }

  return { id: ID.global, directory: AbsolutePath.make(path.parse(input).root), vcs: undefined }
})
```

The `Project.Service` layer gains `VcsProviderRegistryService` as a dependency. When no providers are registered (default), `registry.match` always returns `undefined` and behavior is identical to today.

#### 4. Plugin: `PluginContext.vcs` hook (`packages/plugin/src/v2/effect/context.ts`)

Add a `vcs` hook to `PluginContext`:

```ts
import type { VcsProviderHooks } from "./vcs.js"

export interface PluginContext {
  readonly options: PluginOptions
  readonly agent: AgentHooks & Reload
  readonly aisdk: AISDKHooks
  readonly catalog: CatalogHooks & Reload
  readonly command: CommandHooks & Reload
  readonly integration: IntegrationHooks & Reload
  readonly plugin: PluginDomain
  readonly reference: ReferenceHooks & Reload
  readonly skill: SkillHooks & Reload
  readonly vcs: VcsProviderHooks // NEW
}
```

New file `packages/plugin/src/v2/effect/vcs.ts`:

```ts
export interface VcsProviderHooks {
  register: (provider: VcsProviderLike) => void
}
```

The plugin effect receives `ctx.vcs.register(provider)` and calls it during setup. The registry is backed by a simple in-memory map populated during plugin initialization (before `Vcs.Service` init, per `bootstrap.ts:37-45` ordering).

#### 5. Server: `Vcs.Service` dispatch (`packages/opencode/src/project/vcs.ts:298-419`)

Each method gains a `custom` branch alongside the existing `git` guard. Example for `diff`:

```ts
diff: Effect.fn("Vcs.diff")(function* (mode: Mode, options?: DiffOptions) {
  const value = yield* InstanceState.get(state)
  const ctx = yield* InstanceState.context
  if (ctx.project.vcs?.type === "custom") {
    const registry = yield* VcsProviderRegistryService
    const provider = yield* registry.get(ctx.project.vcs.provider)
    if (!provider) return []
    return yield* provider.diff(ctx.directory, mode, options)
  }
  if (ctx.project.vcs !== "git") return []  // existing guard, unchanged
  // ... existing git diff logic, unchanged
}),
```

The same pattern applies to `init`, `branch`, `defaultBranch`, `status`, `diffRaw`, `apply`. The `custom` branch is inserted before the existing `!== "git"` guard, so git-only projects never touch it.

### p8-repo Plugin

**Location**: `packages/plugin-p8-repo` (new workspace package, or a local plugin at `.opencode/plugins/p8-repo/`). New package is preferred — zero upstream sync conflict.

**Detection (`match`)**:

- Directory contains `.sub-repos/` whose subdirectories include `.git` -> claim
- Or explicit config: `opencode.json` `plugin: [["p8-repo", { root: ".sub-repos" }]]` forces claim

**diff/status implementation**:

1. Scan `<directory>/.sub-repos/*/` for subdirectories containing `.git`
2. For each sub-repo, reuse Core's `Git.Service` to run `git status` / `git diff` (each with `cwd` set to the sub-repo directory)
3. Merge results into a single `FileDiff[]` / `FileStatus[]`
4. Path prefixing: each file path is prefixed with the repo name, e.g. `perception/src/foo.cc`. This natural prefix lets the Review UI group by repo and avoids path collisions across repos.

**branch**: p8 workspaces have no unified branch. Return the first sub-repo's current branch (for display), or `undefined`. The `branch` VCS mode in the web app is de-prioritized for p8; `git` mode (working tree vs HEAD) is the primary use case.

**apply**: Parse the patch to determine which sub-repo it targets (by path prefix), then route `git apply` to that sub-repo's directory.

**Config** (`ponyai/.sub-repos/config.json` or workspace `opencode.json`):

```jsonc
{
  "plugin": [["p8-repo", { "root": ".sub-repos" }]],
}
```

When `root` is omitted, defaults to `.sub-repos`.

### Web App Impact

**Expected: zero code changes in `packages/app`.**

The Review tab (`packages/app/src/pages/session.tsx:385-403`) calls `sdk().client.vcs.diff({ mode })` and receives `VcsFileDiff[]`. The server now returns a merged list from all sub-repos. The `SessionReviewTab` component renders diffs from this array without caring about repo origin — the repo name is embedded in the file path prefix.

Optional future enhancement (out of scope for v1): visually group diffs by repo in the Review sidebar. This is a cosmetic change in `SessionReviewTab` and can be done later.

### SDK Generation

**No SDK regeneration needed.** The `GET /vcs/diff` endpoint signature and `VcsFileDiff[]` response type are unchanged. The `Project.Vcs` schema change is internal to Schema/Core/Server — it is not part of the public `HttpApi` surface that the SDK is generated from. The `vcs` field on `Project.Info` is already `optional(Vcs)` and is not exposed as a typed client API.

## CI Fixes

### Runner Replacement

All 26 workflows use Blacksmith runners (`blacksmith-4vcpu-ubuntu-2404`, `blacksmith-4vcpu-windows-2025`, `blacksmith-4vcpu-ubuntu-2404-arm`). Replace with GitHub-hosted equivalents:

| Blacksmith label                   | GitHub-hosted label |
| ---------------------------------- | ------------------- |
| `blacksmith-4vcpu-ubuntu-2404`     | `ubuntu-22.04`      |
| `blacksmith-4vcpu-windows-2025`    | `windows-latest`    |
| `blacksmith-4vcpu-ubuntu-2404-arm` | `ubuntu-22.04-arm`  |

A script (`script/fix-runners.ts`) performs the replacement across all `.github/workflows/*.yml` files. After upstream sync, re-run the script to re-apply.

### Workflow Categorization

| Category                        | Workflows                                                                                                                                                                                                                                                                                                                                                                   | Action                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Test/Build (keep active)**    | `test.yml`, `typecheck.yml`, `generate.yml`, `storybook.yml`, `nix-eval.yml`, `nix-hashes.yml`, `containers.yml`, `opencode.yml`                                                                                                                                                                                                                                            | Replace runners, keep fully active. Every PR runs unit tests + Playwright e2e + typecheck + generated client check + HttpApi exerciser. |
| **Org-internal (skip on fork)** | `notify-discord.yml`, `pr-management.yml`, `compliance-close.yml`, `triage.yml`, `duplicate-issues.yml`, `close-issues.yml`, `close-prs.yml`, `deploy.yml`, `publish.yml`, `publish-vscode.yml`, `publish-github-action.yml`, `release-github-action.yml`, `beta.yml`, `docs-locale-sync.yml`, `docs-update.yml`, `pr-standards.yml`, `stats.yml`, `publish-python-sdk.yml` | Add `if: github.repository_owner == 'anomalyco'` to each job. They skip cleanly on the fork instead of failing.                         |

### Playwright e2e

Already present in `test.yml` (lines 82-151): the `e2e` job runs `bun --cwd packages/app test:e2e:local` with Playwright chromium, triggered on PR and push to `dev`. Caches Playwright browsers. No changes needed beyond runner replacement.

## Upstream Sync Strategy

### Remote Setup

```
git remote add upstream https://github.com/anomalyco/opencode
```

### Sync Flow

```
git fetch upstream
git merge upstream/dev  # or a release tag
# Resolve conflicts (expected in ~4 files, all additive)
bun run script/fix-runners.ts  # re-apply runner labels
```

### Conflict Hotspots

| File                                       | Change type                             | Conflict risk                              | Resolution                 |
| ------------------------------------------ | --------------------------------------- | ------------------------------------------ | -------------------------- |
| `packages/schema/src/project.ts`           | Vcs union: 3 lines added                | Low — additive to a 1-line definition      | Merge union                |
| `packages/core/src/project/schema.ts`      | Vcs union: 3 lines added                | Low — additive                             | Merge union                |
| `packages/core/src/project.ts`             | resolve fallback: ~5 lines added        | Low — new branch after existing return     | Re-apply fallback          |
| `packages/opencode/src/project/vcs.ts`     | dispatch branches: ~7 methods x 4 lines | Medium — if upstream refactors Vcs.Service | Re-apply dispatch branches |
| `packages/plugin/src/v2/effect/context.ts` | 1 field added                           | Low — additive                             | Merge field                |
| `packages/core/src/vcs-provider.ts`        | New file                                | None — new file                            | No conflict                |
| `packages/plugin-p8-repo/`                 | New package                             | None — new directory                       | No conflict                |
| `.github/workflows/*.yml`                  | Runner labels + owner guards            | Medium — upstream may add/modify workflows | Re-run `fix-runners.ts`    |

### Sync Frequency

Follow upstream release commits (e.g. `afff74eb2 sync release versions for v1.17.12`). Merge the release tag or `upstream/dev` into the fork's `dev` branch.

## Testing Strategy

### Unit Tests

1. **VcsProvider registry**: register, match (claim/no-claim), get by id, empty registry returns undefined
2. **Project.resolve fallback**: git repo found -> git path (unchanged); no git + no provider -> global; no git + provider match -> custom vcs
3. **Vcs.Service dispatch**: `vcs.type === "custom"` routes to provider; `vcs.type === "git"` routes to git (unchanged); `vcs === undefined` returns empty (unchanged)
4. **p8-repo plugin**: mock `.sub-repos/` with 2 fake git repos, verify diff merges both, paths are prefixed, status aggregates

### Integration Test

Create a temp directory structure:

```
test-workspace/
  .sub-repos/
    repo-a/.git/
    repo-b/.git/
```

Run opencode against `test-workspace/`, call `GET /vcs/diff`, verify response includes files from both repos.

### Playwright e2e

Existing e2e suite continues to pass (single-repo scenarios unchanged). A new e2e test for multi-repo Review can be added once the feature is stable.

### Verification Per PR

Every PR triggers:

- `bun turbo test` (unit tests across all packages)
- `bun typecheck` (typecheck across all packages)
- `bun run check:generated` (generated client consistency)
- `bun run test:httpapi` (HttpApi exerciser)
- `bun --cwd packages/app test:e2e:local` (Playwright e2e)

## Implementation Tasks

### Phase 1: CI Foundation (do first, unblocks all PRs)

- [ ] Add `upstream` remote
- [ ] Create `script/fix-runners.ts` to replace Blacksmith labels with GitHub-hosted labels
- [ ] Run fix-runners on all workflows
- [ ] Add `if: github.repository_owner == 'anomalyco'` guard to org-internal workflows
- [ ] Push to `dev`, verify `test.yml` + `typecheck.yml` pass on the fork
- [ ] Commit: `chore(ci): switch to github-hosted runners for fork`

### Phase 2: Core Extension Point

- [ ] Move VCS shared types (`FileDiff`, `FileStatus`, `Mode`, `DiffOptions`, `ApplyInput`, `ApplyResult`, `PatchApplyError`) to `packages/core/src/vcs-types.ts`; re-export from `packages/opencode/src/project/vcs.ts`
- [ ] Create `packages/core/src/vcs-provider.ts` (VcsProvider interface + VcsProviderRegistryService)
- [ ] Extend `packages/schema/src/project.ts` Vcs union with `custom` variant
- [ ] Extend `packages/core/src/project/schema.ts` Vcs union with `custom` variant
- [ ] Add `VcsProviderRegistryService` dependency to `Project.Service` layer
- [ ] Add resolve fallback in `packages/core/src/project.ts:110`
- [ ] Add `PluginContext.vcs` hook in `packages/plugin/src/v2/effect/context.ts`
- [ ] Wire registry population in plugin init (before Vcs.Service init)
- [ ] Add dispatch branches in `packages/opencode/src/project/vcs.ts` (7 methods)
- [ ] Unit tests for registry, resolve fallback, dispatch
- [ ] Run `bun typecheck` from `packages/opencode`
- [ ] Run `bun turbo test`
- [ ] Commit: `feat(core): add VCS provider extension point for custom VCS plugins`

### Phase 3: p8-repo Plugin

- [ ] Create `packages/plugin-p8-repo/` package (package.json, tsconfig.json, src/index.ts)
- [ ] Implement `match()`: detect `.sub-repos/` with git sub-repos
- [ ] Implement `status()`: scan sub-repos, run `git status`, merge with repo-prefix paths
- [ ] Implement `diff()`: scan sub-repos, run `git diff`, merge `FileDiff[]` with repo-prefix paths
- [ ] Implement `diffRaw()`: aggregate raw patches
- [ ] Implement `branch()` / `defaultBranch()`: return first sub-repo's branch
- [ ] Implement `apply()`: route patch to correct sub-repo by path prefix
- [ ] Register provider via `ctx.vcs.register(...)` in plugin effect
- [ ] Add to workspace `package.json` workspaces array
- [ ] Unit tests with mock `.sub-repos/` structure
- [ ] Commit: `feat(plugin): add p8-repo multi-repo VCS plugin`

### Phase 4: Integration & Validation

- [ ] Configure `opencode.json` in ponyai workspace to enable p8-repo plugin
- [ ] Start opencode server against ponyai workspace, verify `GET /vcs/diff` returns merged diffs
- [ ] Open web app, verify Review tab shows diffs across sub-repos
- [ ] Run full `bun turbo test` + `bun typecheck` + Playwright e2e
- [ ] Commit: `test: add p8 multi-repo integration test`

### Phase 5: Sync Hardening

- [ ] Document sync runbook in `docs/superpowers/specs/`
- [ ] Ensure `fix-runners.ts` is idempotent and can be re-run after merge
- [ ] Test a dry-run upstream merge to identify conflict surface

## Risks & Open Questions

1. **Vcs.Service refactor risk**: If upstream refactors `Vcs.Service` significantly between releases, the 7 dispatch branches need manual re-application. Mitigation: keep branches minimal and uniform (4 lines each, same pattern).

2. **VCS types relocation**: Moving `FileDiff` etc. from Server to Core is a cross-package refactor. If any downstream code imports these types from `packages/opencode/src/project/vcs.ts`, the re-export must cover them. Verify with `bun typecheck` after the move.

3. **p8 workspace git identity**: The p8 workspace root has no `.git`, so `Project.resolve` currently returns `ID.global`. With the custom provider, the project ID becomes `Hash.fast("custom-vcs:p8-repo:<directory>")`. This is stable and unique per workspace, but existing sessions created under the old `global` ID will not automatically migrate. Acceptable for a fork.

4. **Snapshot system**: `packages/opencode/src/snapshot/index.ts:66-73` keys snapshots by `Hash.fast(ctx.worktree)`. For p8, `ctx.worktree` is the workspace root, so snapshots capture the full tree. This should work, but snapshot diffing might need testing with the multi-repo structure. Out of scope for v1; revisit if snapshot issues arise.

5. **Performance**: Scanning 10+ sub-repos for `git diff` on every Review tab open may be slow. Mitigation: parallelize with `Effect.forEach(..., { concurrency: "unbounded" })` and cache results in `InstanceState`.
