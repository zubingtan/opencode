# p8 Multi-Repo VCS Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make opencode's web app Review feature work on p8 multi-repo workspaces by adding a generic VCS provider extension point in Core and implementing a p8-repo plugin, plus fix CI to run on the fork.

**Architecture:** Core gets a generic `VcsProvider` interface + registry (additive, upstreamable). A new `p8-repo` plugin implements it by scanning `.sub-repos/*/` git repos and merging diffs. `Vcs.Service` dispatches to registered providers when `project.vcs.type === "custom"`. CI switches from Blacksmith runners to GitHub-hosted runners.

**Tech Stack:** TypeScript, Effect v4, Bun, Schema, SolidJS (web app unchanged), GitHub Actions

## Global Constraints

- Bun 1.3+ (packageManager: `bun@1.3.14`)
- Run typecheck from package dirs: `bun typecheck` (never `tsc` directly)
- Run tests from package dirs (e.g. `packages/opencode`), never from repo root (guard: `do-not-run-tests-from-root`)
- Dependency direction: `Schema -> Core -> Protocol -> Server`; Client depends on Schema + Protocol only
- `packages/plugin` does NOT depend on `packages/core` or `packages/opencode` (lightweight framework)
- `packages/plugin` cannot import Core types — use structural types
- After changing public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`
- Do not edit `src/generated` or `src/generated-effect` directly
- Default branch is `dev`
- Use `bunfig.toml` for test config; tests use `bun:test`
- Effect v4: `Effect.fork` / `Effect.forkDaemon` do not exist — use `Effect.forkIn(scope)`
- Use `Bun.file()` for file I/O when possible

---

## File Structure

### New Files

| File                                                  | Responsibility                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/core/src/vcs-types.ts`                      | Shared VCS types moved from opencode (FileDiff, FileStatus, Mode, etc.) |
| `packages/core/src/vcs-provider.ts`                   | VcsProvider interface + VcsProviderRegistryService                      |
| `packages/plugin/src/v2/effect/vcs.ts`                | VcsProviderHooks (structural type, no Core import)                      |
| `packages/plugin-p8-repo/package.json`                | Package manifest                                                        |
| `packages/plugin-p8-repo/tsconfig.json`               | TypeScript config                                                       |
| `packages/plugin-p8-repo/src/index.ts`                | Plugin entry — registers VcsProvider                                    |
| `packages/plugin-p8-repo/src/provider.ts`             | P8 VcsProvider implementation                                           |
| `packages/plugin-p8-repo/src/git.ts`                  | Git command helpers via Bun.spawn                                       |
| `packages/plugin-p8-repo/test/provider.test.ts`       | Unit tests                                                              |
| `script/fix-runners.ts`                               | CI runner label replacement script                                      |
| `packages/opencode/test/project/vcs-provider.test.ts` | VcsProvider registry + dispatch tests                                   |
| `packages/core/test/vcs-provider.test.ts`             | Registry unit tests                                                     |

### Modified Files

| File                                          | Change                                                       |
| --------------------------------------------- | ------------------------------------------------------------ |
| `packages/schema/src/project.ts:11`           | Vcs union: add `custom` variant                              |
| `packages/core/src/project/schema.ts:10-15`   | Vcs union: add `custom` variant                              |
| `packages/core/src/project.ts:110-122`        | resolve(): add provider fallback                             |
| `packages/opencode/src/project/vcs.ts`        | Re-export types from Core; add dispatch branches (7 methods) |
| `packages/plugin/src/v2/effect/context.ts`    | Add `vcs: VcsProviderHooks` field                            |
| `packages/core/src/plugin/internal.ts:81-106` | Add VcsProviderRegistryService to provides chain             |
| `.github/workflows/*.yml`                     | Replace runners + add owner guards                           |
| `package.json`                                | Add `packages/plugin-p8-repo` to workspaces (auto via glob)  |

---

## Phase 1: CI Foundation

### Task 1: Create runner replacement script

**Files:**

- Create: `script/fix-runners.ts`

**Interfaces:**

- Produces: `script/fix-runners.ts` — a script that replaces Blacksmith runner labels with GitHub-hosted labels across all `.github/workflows/*.yml` files. Idempotent (safe to re-run after upstream sync).

- [ ] **Step 1: Write the script**

```ts
import { $, file, write } from "bun"
import { glob } from "glob"

const replacements: Record<string, string> = {
  "blacksmith-4vcpu-ubuntu-2404": "ubuntu-22.04",
  "blacksmith-4vcpu-windows-2025": "windows-latest",
  "blacksmith-4vcpu-ubuntu-2404-arm": "ubuntu-22.04-arm",
}

const files = await glob(".github/workflows/*.yml")
let changed = 0

for (const filePath of files) {
  const original = await file(filePath).text()
  let updated = original
  for (const [from, to] of Object.entries(replacements)) {
    updated = updated.replaceAll(from, to)
  }
  if (updated !== original) {
    await write(filePath, updated)
    changed++
    console.log(`Updated: ${filePath}`)
  }
}

console.log(`Done. ${changed} file(s) changed.`)
```

- [ ] **Step 2: Run the script**

Run: `bun run script/fix-runners.ts`
Expected: Output listing updated workflow files (all 26 files with `blacksmith-*` references).

- [ ] **Step 3: Verify no Blacksmith labels remain**

Run: `grep -r "blacksmith" .github/workflows/ || echo "CLEAN"`
Expected: `CLEAN`

- [ ] **Step 4: Commit**

```bash
git add script/fix-runners.ts .github/workflows/
git commit -m "chore(ci): replace blacksmith runners with github-hosted"
```

---

### Task 2: Add owner guards to org-internal workflows

**Files:**

- Modify: `.github/workflows/{notify-discord,pr-management,compliance-close,triage,duplicate-issues,close-issues,close-prs,deploy,publish,publish-vscode,publish-github-action,release-github-action,beta,docs-locale-sync,docs-update,pr-standards,stats,publish-python-sdk}.yml`

**Interfaces:**

- Consumes: Task 1 (runners already replaced)
- Produces: All org-internal workflows skip cleanly on `zubingtan/opencode` fork

- [ ] **Step 1: Write a script to add owner guards**

Create `script/add-owner-guards.ts`:

```ts
import { file, write } from "bun"
import { glob } from "glob"

const orgInternal = [
  "notify-discord",
  "pr-management",
  "compliance-close",
  "triage",
  "duplicate-issues",
  "close-issues",
  "close-prs",
  "deploy",
  "publish",
  "publish-vscode",
  "publish-github-action",
  "release-github-action",
  "beta",
  "docs-locale-sync",
  "docs-update",
  "pr-standards",
  "stats",
  "publish-python-sdk",
]

const guard = "    if: github.repository_owner == 'anomalyco'\n"

for (const name of orgInternal) {
  const filePath = `.github/workflows/${name}.yml`
  const text = await file(filePath).text()
  if (text.includes("github.repository_owner")) {
    console.log(`Skip (already guarded): ${filePath}`)
    continue
  }
  // Insert guard after the first "runs-on:" line's job defaults
  // Find "  <job-name>:" then "    runs-on:" and add guard before "    runs-on:"
  const updated = text.replace(/(\n    runs-on:)/, `\n${guard.trimEnd()}$1`)
  await write(filePath, updated)
  console.log(`Updated: ${filePath}`)
}

console.log("Done.")
```

- [ ] **Step 2: Run the script**

Run: `bun run script/add-owner-guards.ts`
Expected: Output listing updated workflow files.

- [ ] **Step 3: Verify guards were added**

Run: `grep -l "github.repository_owner" .github/workflows/*.yml | wc -l`
Expected: At least 18 (the org-internal workflows).

- [ ] **Step 4: Commit**

```bash
git add script/add-owner-guards.ts .github/workflows/
git commit -m "chore(ci): skip org-internal workflows on fork"
```

---

### Task 3: Add upstream remote and verify CI

**Files:**

- No file changes — git remote config only

- [ ] **Step 1: Add upstream remote**

Run: `git remote add upstream https://github.com/anomalyco/opencode`
Expected: No output (success).

- [ ] **Step 2: Fetch upstream**

Run: `git fetch upstream`
Expected: Fetches upstream refs.

- [ ] **Step 3: Push to fork dev branch**

Run: `git push origin dev`
Expected: Push succeeds.

- [ ] **Step 4: Verify CI triggers on GitHub**

Check GitHub Actions tab on `zubingtan/opencode`. The `test` and `typecheck` workflows should trigger on the push. Wait for them to complete.

Expected: `test` (unit + e2e) and `typecheck` workflows pass on `ubuntu-22.04` / `windows-latest` runners.

- [ ] **Step 5: Create a test PR to verify PR triggers**

Create a trivial PR (e.g. add a comment to a file). Verify `test` + `typecheck` trigger on the PR.

Expected: Both workflows run on PR.

---

## Phase 2: Core Extension Point

### Task 4: Move VCS shared types to Core

**Files:**

- Create: `packages/core/src/vcs-types.ts`
- Modify: `packages/opencode/src/project/vcs.ts:234-279` (re-export from Core)
- Test: `packages/core/test/vcs-types.test.ts`

**Interfaces:**

- Produces: `@opencode-ai/core/vcs-types` exports `Mode`, `FileDiff`, `FileStatus`, `ApplyInput`, `ApplyResult`, `PatchApplyError`, `DiffOptions`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/vcs-types.test.ts`:

```ts
import { describe, expect, it } from "bun:test"
import { VcsTypes } from "../src/vcs-types"

describe("VcsTypes", () => {
  it("Mode includes git and branch", () => {
    expect(VcsTypes.Mode.literals).toContain("git")
    expect(VcsTypes.Mode.literals).toContain("branch")
  })

  it("FileDiff has expected fields", () => {
    const fields = Object.keys(VcsTypes.FileDiff.fields)
    expect(fields).toContain("file")
    expect(fields).toContain("patch")
    expect(fields).toContain("additions")
    expect(fields).toContain("deletions")
    expect(fields).toContain("status")
  })

  it("FileStatus has expected fields", () => {
    const fields = Object.keys(VcsTypes.FileStatus.fields)
    expect(fields).toContain("file")
    expect(fields).toContain("additions")
    expect(fields).toContain("deletions")
    expect(fields).toContain("status")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/core`): `bun test test/vcs-types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the types file**

Create `packages/core/src/vcs-types.ts`:

```ts
import { Schema } from "effect"

export const Mode = Schema.Literals(["git", "branch"])
export type Mode = Schema.Schema.Type<typeof Mode>

export type DiffOptions = {
  readonly context?: number
}

export const FileDiff = Schema.Struct({
  file: Schema.String,
  patch: Schema.optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "VcsFileDiff" })
export type FileDiff = Schema.Schema.Type<typeof FileDiff>

export const FileStatus = Schema.Struct({
  file: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.Literals(["added", "deleted", "modified"]),
}).annotate({ identifier: "VcsFileStatus" })
export type FileStatus = Schema.Schema.Type<typeof FileStatus>

export const ApplyInput = Schema.Struct({
  patch: Schema.String,
})
export type ApplyInput = Schema.Schema.Type<typeof ApplyInput>

export const ApplyResult = Schema.Struct({
  applied: Schema.Boolean,
})
export type ApplyResult = Schema.Schema.Type<typeof ApplyResult>

export class PatchApplyError extends Schema.TaggedErrorClass<PatchApplyError>()("VcsPatchApplyError", {
  message: Schema.String,
  reason: Schema.Literals(["non-git", "not-clean"]),
}) {}

export * as VcsTypes from "."
```

- [ ] **Step 4: Update opencode vcs.ts to re-export from Core**

In `packages/opencode/src/project/vcs.ts`, replace the type definitions (lines 234-279) with re-exports. Add import at top:

```ts
import { VcsTypes } from "@opencode-ai/core/vcs-types"
```

Replace the `Mode`, `FileDiff`, `FileStatus`, `ApplyInput`, `ApplyResult`, `PatchApplyError` definitions (lines 234-279) with:

```ts
export const Mode = VcsTypes.Mode
export type Mode = VcsTypes.Mode
export const FileDiff = VcsTypes.FileDiff
export type FileDiff = VcsTypes.FileDiff
export const FileStatus = VcsTypes.FileStatus
export type FileStatus = VcsTypes.FileStatus
export const ApplyInput = VcsTypes.ApplyInput
export type ApplyInput = VcsTypes.ApplyInput
export const ApplyResult = VcsTypes.ApplyResult
export type ApplyResult = VcsTypes.ApplyResult
export const PatchApplyError = VcsTypes.PatchApplyError
```

Keep `Event`, `Info` in vcs.ts (they depend on VcsEvent from schema).

- [ ] **Step 5: Run test to verify it passes**

Run (from `packages/core`): `bun test test/vcs-types.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify opencode still typechecks**

Run (from `packages/opencode`): `bun typecheck`
Expected: PASS — no type errors from the re-export.

- [ ] **Step 7: Verify existing vcs tests still pass**

Run (from `packages/opencode`): `bun test test/project/vcs.test.ts`
Expected: All existing Vcs tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/vcs-types.ts packages/core/test/vcs-types.test.ts packages/opencode/src/project/vcs.ts
git commit -m "refactor(core): move VCS shared types to core"
```

---

### Task 5: Create VcsProvider interface + registry

**Files:**

- Create: `packages/core/src/vcs-provider.ts`
- Test: `packages/core/test/vcs-provider.test.ts`

**Interfaces:**

- Consumes: `VcsTypes` from Task 4 (FileDiff, FileStatus, Mode, DiffOptions, ApplyInput, ApplyResult, PatchApplyError)
- Produces: `VcsProvider` interface, `VcsProviderRegistryService` Context tag, `VcsProviderRegistry` interface with `register`, `match`, `get` methods

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/vcs-provider.test.ts`:

```ts
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { VcsProvider, VcsProviderRegistryService } from "../src/vcs-provider"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.effectDiscard(Effect.void))

const makeProvider = (id: string, matches: boolean): VcsProvider => ({
  id,
  match: () => Effect.succeed(matches),
  branch: () => Effect.succeed(undefined),
  defaultBranch: () => Effect.succeed(undefined),
  status: () => Effect.succeed([]),
  diff: () => Effect.succeed([]),
  diffRaw: () => Effect.succeed(""),
  apply: () => Effect.succeed({ applied: true }),
})

describe("VcsProviderRegistry", () => {
  it.effect("register and get by id", () =>
    Effect.gen(function* () {
      const registry = yield* VcsProviderRegistryService
      const provider = makeProvider("test-provider", true)
      registry.register(provider)
      const found = yield* registry.get("test-provider")
      expect(found).toBeDefined()
      expect(found?.id).toBe("test-provider")
    }),
  )

  it.effect("match returns provider that claims directory", () =>
    Effect.gen(function* () {
      const registry = yield* VcsProviderRegistryService
      registry.register(makeProvider("claimer", true))
      registry.register(makeProvider("non-claimer", false))
      const found = yield* registry.match("/some/dir")
      expect(found).toBeDefined()
      expect(found?.id).toBe("claimer")
    }),
  )

  it.effect("match returns undefined when no provider claims", () =>
    Effect.gen(function* () {
      const registry = yield* VcsProviderRegistryService
      registry.register(makeProvider("nope", false))
      const found = yield* registry.match("/some/dir")
      expect(found).toBeUndefined()
    }),
  )

  it.effect("get returns undefined for unknown id", () =>
    Effect.gen(function* () {
      const registry = yield* VcsProviderRegistryService
      const found = yield* registry.get("nonexistent")
      expect(found).toBeUndefined()
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/core`): `bun test test/vcs-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the VcsProvider module**

Create `packages/core/src/vcs-provider.ts`:

```ts
import { Context, Effect, Ref } from "effect"
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
  readonly register: (provider: VcsProvider) => void
  readonly match: (directory: string) => Effect.Effect<VcsProvider | undefined>
  readonly get: (providerId: string) => Effect.Effect<VcsProvider | undefined>
}

export class VcsProviderRegistryService extends Context.Service<VcsProviderRegistryService, VcsProviderRegistry>()(
  "@opencode/VcsProviderRegistry",
) {}

export const VcsProviderRegistryLive = Layer.effect(
  VcsProviderRegistryService,
  Effect.gen(function* () {
    const providers = yield* Ref.make<Map<string, VcsProvider>>(new Map())
    return VcsProviderRegistryService.of({
      register: (provider) => Ref.update(providers, (map) => new Map(map).set(provider.id, provider)),
      match: (directory) =>
        Effect.gen(function* () {
          const map = yield* Ref.get(providers)
          for (const provider of map.values()) {
            if (yield* provider.match(directory)) return provider
          }
          return undefined
        }),
      get: (providerId) =>
        Effect.gen(function* () {
          const map = yield* Ref.get(providers)
          return map.get(providerId)
        }),
    })
  }),
)

export * as VcsProviderModule from "."
```

- [ ] **Step 4: Provide the registry layer in the test**

Update `packages/core/test/vcs-provider.test.ts` to include the live layer:

```ts
const it = testEffect(Layer.provideMerge(VcsProviderRegistryLive, Layer.effectDiscard(Effect.void)))
```

Add import:

```ts
import { VcsProviderRegistryLive } from "../src/vcs-provider"
```

- [ ] **Step 5: Run test to verify it passes**

Run (from `packages/core`): `bun test test/vcs-provider.test.ts`
Expected: PASS — all 4 tests pass.

- [ ] **Step 6: Verify typecheck**

Run (from `packages/core`): `bun typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/vcs-provider.ts packages/core/test/vcs-provider.test.ts
git commit -m "feat(core): add VcsProvider interface and registry"
```

---

### Task 6: Extend Vcs schema and add resolve fallback

**Files:**

- Modify: `packages/schema/src/project.ts:11`
- Modify: `packages/core/src/project/schema.ts:10-15`
- Modify: `packages/core/src/project.ts:110-122`
- Test: `packages/core/test/project.test.ts` (add test)

**Interfaces:**

- Consumes: `VcsProviderRegistryService` from Task 5
- Produces: `Project.Vcs` union includes `custom` variant; `Project.resolve()` falls back to registry

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/project.test.ts` (or create if it doesn't exist):

```ts
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Project } from "../src/project"
import { VcsProviderRegistryLive, VcsProviderRegistryService } from "../src/vcs-provider"
import { testEffect } from "./lib/effect"
import { tmpdirScoped } from "./lib/tmpdir"

const it = testEffect(Layer.provideMerge(VcsProviderRegistryLive, Layer.effectDiscard(Effect.void)))

describe("Project.resolve custom VCS fallback", () => {
  it.live("returns custom vcs when provider matches", () =>
    Effect.gen(function* () {
      const registry = yield* VcsProviderRegistryService
      registry.register({
        id: "test-custom",
        match: () => Effect.succeed(true),
        branch: () => Effect.succeed(undefined),
        defaultBranch: () => Effect.succeed(undefined),
        status: () => Effect.succeed([]),
        diff: () => Effect.succeed([]),
        diffRaw: () => Effect.succeed(""),
        apply: () => Effect.succeed({ applied: true }),
      })

      const dir = yield* tmpdirScoped()
      const result = yield* Project.Service.use((p) => p.resolve(dir))
      expect(result.vcs).toBeDefined()
      expect(result.vcs?.type).toBe("custom")
      expect(result.vcs?.provider).toBe("test-custom")
    }),
  )

  it.live("returns undefined vcs when no provider matches", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const result = yield* Project.Service.use((p) => p.resolve(dir))
      expect(result.vcs).toBeUndefined()
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/core`): `bun test test/project.test.ts`
Expected: FAIL — `vcs?.type` is `undefined` (no custom fallback yet), or type error.

- [ ] **Step 3: Extend Schema package Vcs**

In `packages/schema/src/project.ts:11`, replace:

```ts
export const Vcs = Schema.Literal("git").annotate({ identifier: "Project.Vcs" })
```

with:

```ts
export const Vcs = Schema.Union([
  Schema.Literal("git"),
  Schema.Struct({ type: Schema.Literal("custom"), provider: Schema.String }),
]).annotate({ identifier: "Project.Vcs" })
```

- [ ] **Step 4: Extend Core Vcs schema**

In `packages/core/src/project/schema.ts:10-15`, replace:

```ts
export const Vcs = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("git"),
    store: AbsolutePath,
  }),
])
```

with:

```ts
export const Vcs = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("git"),
    store: AbsolutePath,
  }),
  Schema.Struct({
    type: Schema.Literal("custom"),
    provider: Schema.String,
  }),
])
```

- [ ] **Step 5: Add resolve fallback in Project.resolve**

In `packages/core/src/project.ts:110-122`, replace the `resolve` function body. After the git path `if (repo) { ... }` block, before the `return { id: ID.global, ... }`, add:

```ts
// fallback: query registered VCS providers
const registry = yield * VcsProviderRegistryService
const provider = yield * registry.match(input)
if (provider) {
  return {
    id: ID.make(Hash.fast(`custom-vcs:${provider.id}:${input}`)),
    directory: input,
    vcs: { type: "custom" as const, provider: provider.id },
  }
}
```

Add imports at the top of `packages/core/src/project.ts`:

```ts
import { Hash } from "effect"
import { VcsProviderRegistryService } from "./vcs-provider"
```

Add `VcsProviderRegistryLive` to the Project layer dependencies. In the `layer` definition (around line 129):

```ts
export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Git.node, ProjectDirectories.node, VcsProviderRegistryLive],
})
```

Wait — `makeGlobalNode` takes `LayerNode` deps, not raw layers. Check how other services add deps. The `VcsProviderRegistryLive` is a `Layer`, so it needs to be composed. Add it to the layer's `Layer.provideMerge` or compile it as a dependency:

```ts
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.provideMerge(layer, VcsProviderRegistryLive),
  deps: [FSUtil.node, Git.node, ProjectDirectories.node],
})
```

- [ ] **Step 6: Run test to verify it passes**

Run (from `packages/core`): `bun test test/project.test.ts`
Expected: PASS — both custom vcs and undefined vcs tests pass.

- [ ] **Step 7: Verify typecheck across packages**

Run (from `packages/schema`): `bun typecheck`
Run (from `packages/core`): `bun typecheck`
Run (from `packages/opencode`): `bun typecheck`
Expected: All pass.

- [ ] **Step 8: Verify existing tests still pass**

Run (from `packages/core`): `bun test`
Run (from `packages/opencode`): `bun test test/project/vcs.test.ts`
Expected: All pass — git-only behavior unchanged.

- [ ] **Step 9: Commit**

```bash
git add packages/schema/src/project.ts packages/core/src/project/schema.ts packages/core/src/project.ts packages/core/test/project.test.ts
git commit -m "feat(core): add custom VCS variant and provider fallback in Project.resolve"
```

---

### Task 7: Add VcsProvider hook to plugin context

**Files:**

- Create: `packages/plugin/src/v2/effect/vcs.ts`
- Modify: `packages/plugin/src/v2/effect/context.ts`
- Modify: `packages/core/src/plugin/internal.ts:81-106` (add registry to provides chain)

**Interfaces:**

- Consumes: `VcsProviderRegistryService` from Task 5
- Produces: `ctx.vcs.register(provider)` available in V2 plugin effects

- [ ] **Step 1: Create the plugin vcs hook type**

Create `packages/plugin/src/v2/effect/vcs.ts`:

```ts
export interface VcsProviderLike {
  readonly id: string
  match: (directory: string) => { [Symbol.iterator]: () => Iterator<unknown> } | Promise<boolean> | boolean
}

export interface VcsProviderHooks {
  readonly register: (provider: VcsProviderLike) => void
}
```

Note: `VcsProviderLike` is a structural type that doesn't import Core. A plugin implementing Core's `VcsProvider` is structurally compatible. The `match` return type is loose because the plugin framework can't import Effect types — the actual runtime type is `Effect.Effect<boolean>`, which at runtime is just an object. The registry calls `Effect.runPromise` or treats it as an Effect.

Actually, since `VcsProviderLike` is only used for the hook signature and the actual registration goes through `VcsProviderRegistryService.register(provider)` which expects Core's `VcsProvider`, the structural compatibility handles the bridge. Let me simplify — use `unknown` for the provider type in the hook, and let the registry cast:

```ts
export interface VcsProviderHooks {
  readonly register: (provider: unknown) => void
}
```

This is the simplest approach. The p8 plugin (which depends on Core) passes a properly typed `VcsProvider`. The hook just forwards it to the registry.

- [ ] **Step 2: Add vcs hook to PluginContext**

In `packages/plugin/src/v2/effect/context.ts`, add:

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
  readonly vcs: VcsProviderHooks
}
```

- [ ] **Step 3: Wire registry into plugin provides chain**

In `packages/core/src/plugin/internal.ts`, add `VcsProviderRegistryService` to the `Requirements` type (line 37-52):

```ts
import { VcsProviderRegistryService } from "../vcs-provider"

export type Requirements =
  | AgentV2.Service
  // ... existing
  | VcsProviderRegistryService
```

In the `add` function (line 81-106), add the registry to the provides chain:

```ts
const vcsRegistry = yield* VcsProviderRegistryService
// ...
const add = <R>(input: Plugin<R>) => {
  const loaded = {
    id: input.id,
    effect: (context: PluginContext) =>
      input.effect(context).pipe(
        // ... existing provides
        Effect.provideService(VcsProviderRegistryService, vcsRegistry),
      ),
  }
```

Also, construct the `context` with a `vcs` hook that calls `registry.register`. Since `register` returns `void` (synchronous, uses a plain Map), the hook is simple:

```ts
const vcsRegistry = yield* VcsProviderRegistryService

const context: PluginContext = {
  options: {}, // filled per-plugin
  agent: ..., // existing hooks
  // ... existing hooks
  vcs: {
    register: (provider) => {
      vcsRegistry.register(provider as VcsProvider)
    },
  },
}
```

The `VcsProviderRegistryLive` layer (from Task 5) already uses a plain `Map` for synchronous `register`. No changes needed to the registry implementation.

- [ ] **Step 4: Verify typecheck**

Run (from `packages/plugin`): `bun typecheck`
Run (from `packages/core`): `bun typecheck`
Expected: PASS.

- [ ] **Step 5: Verify tests still pass**

Run (from `packages/core`): `bun test test/vcs-provider.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin/src/v2/effect/vcs.ts packages/plugin/src/v2/effect/context.ts packages/core/src/plugin/internal.ts packages/core/src/vcs-provider.ts packages/core/test/vcs-provider.test.ts
git commit -m "feat(plugin): add VcsProvider hook to plugin context"
```

---

### Task 8: Add Vcs.Service dispatch branches

**Files:**

- Modify: `packages/opencode/src/project/vcs.ts:298-419` (add custom dispatch to 7 methods)
- Test: `packages/opencode/test/project/vcs-provider.test.ts`

**Interfaces:**

- Consumes: `VcsProviderRegistryService` from Task 5/7, `Project.Vcs` custom variant from Task 6
- Produces: `Vcs.Service` dispatches to custom provider when `vcs.type === "custom"`

- [ ] **Step 1: Write the failing test**

Create `packages/opencode/test/project/vcs-provider.test.ts`:

```ts
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Git } from "../../src/git"
import { Vcs } from "@/project/vcs"
import { VcsProviderRegistryLive, VcsProviderRegistryService } from "@opencode-ai/core/vcs-provider"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import type { VcsProvider } from "@opencode-ai/core/vcs-provider"

const layer = LayerNode.compile(
  LayerNode.group([Vcs.node, Git.node, EventV2Bridge.node, FSUtil.node, CrossSpawnSpawner.node]),
)
const it = testEffect(Layer.mergeAll(layer, VcsProviderRegistryLive, testInstanceStoreLayer))

const mockProvider: VcsProvider = {
  id: "test-mock",
  match: () => Effect.succeed(true),
  branch: () => Effect.succeed("mock-branch"),
  defaultBranch: () => Effect.succeed("main"),
  status: () => Effect.succeed([{ file: "test/file.ts", additions: 5, deletions: 2, status: "modified" as const }]),
  diff: () =>
    Effect.succeed([
      { file: "test/file.ts", patch: "@@ diff @@", additions: 5, deletions: 2, status: "modified" as const },
    ]),
  diffRaw: () => Effect.succeed("mock raw diff"),
  apply: () => Effect.succeed({ applied: true }),
}

describe("Vcs.Service custom dispatch", () => {
  it.instance("diff() dispatches to custom provider", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const registry = yield* VcsProviderRegistryService
        registry.register(mockProvider)

        const vcs = yield* Vcs.Service
        yield* vcs.init()
        const diffs = yield* vcs.diff("git")
        expect(diffs).toHaveLength(1)
        expect(diffs[0].file).toBe("test/file.ts")
      }),
    ),
  )

  it.instance("status() dispatches to custom provider", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const registry = yield* VcsProviderRegistryService
        registry.register(mockProvider)

        const vcs = yield* Vcs.Service
        yield* vcs.init()
        const status = yield* vcs.status()
        expect(status).toHaveLength(1)
        expect(status[0].file).toBe("test/file.ts")
      }),
    ),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/opencode`): `bun test test/project/vcs-provider.test.ts`
Expected: FAIL — `diffs` is empty (dispatch not implemented, falls through to `vcs !== "git"` return `[]`).

- [ ] **Step 3: Add dispatch branches to Vcs.Service**

In `packages/opencode/src/project/vcs.ts`, add import:

```ts
import { VcsProviderRegistryService } from "@opencode-ai/core/vcs-provider"
```

Add `VcsProviderRegistryService` to the layer dependencies (line 298):

```ts
const layer: Layer.Layer<Service, never, Git.Service | EventV2Bridge.Service | VcsProviderRegistryService> = Layer.effect(
```

In each method, add a `custom` branch before the existing `!== "git"` guard. For `diff` (line 373-386):

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
  if (ctx.project.vcs !== "git") return []
  // ... existing git diff logic unchanged
}),
```

Apply the same pattern to `init` (line 339-341), `branch` (line 342-344), `defaultBranch` (line 345-347), `status` (line 348-372), `diffRaw` (line 387-399), `apply` (line 400-416).

For `init`:

```ts
init: Effect.fn("Vcs.init")(function* () {
  const ctx = yield* InstanceState.context
  if (ctx.project.vcs?.type === "custom") return
  yield* InstanceState.get(state).pipe(Effect.forkIn(scope))
}),
```

For `branch`:

```ts
branch: Effect.fn("Vcs.branch")(function* () {
  const ctx = yield* InstanceState.context
  if (ctx.project.vcs?.type === "custom") {
    const registry = yield* VcsProviderRegistryService
    const provider = yield* registry.get(ctx.project.vcs.provider)
    return provider ? yield* provider.branch(ctx.directory) : undefined
  }
  return yield* InstanceState.use(state, (x) => x.current)
}),
```

For `defaultBranch`:

```ts
defaultBranch: Effect.fn("Vcs.defaultBranch")(function* () {
  const ctx = yield* InstanceState.context
  if (ctx.project.vcs?.type === "custom") {
    const registry = yield* VcsProviderRegistryService
    const provider = yield* registry.get(ctx.project.vcs.provider)
    return provider ? yield* provider.defaultBranch(ctx.directory) : undefined
  }
  return yield* InstanceState.use(state, (x) => x.root?.name)
}),
```

For `status`:

```ts
status: Effect.fn("Vcs.status")(function* () {
  const ctx = yield* InstanceState.context
  if (ctx.project.vcs?.type === "custom") {
    const registry = yield* VcsProviderRegistryService
    const provider = yield* registry.get(ctx.project.vcs.provider)
    if (!provider) return []
    return yield* provider.status(ctx.directory)
  }
  if (ctx.project.vcs !== "git") return []
  // ... existing logic unchanged
}),
```

For `diffRaw`:

```ts
diffRaw: Effect.fn("Vcs.diffRaw")(function* () {
  const ctx = yield* InstanceState.context
  if (ctx.project.vcs?.type === "custom") {
    const registry = yield* VcsProviderRegistryService
    const provider = yield* registry.get(ctx.project.vcs.provider)
    if (!provider) return ""
    return yield* provider.diffRaw(ctx.directory)
  }
  if (ctx.project.vcs !== "git") return ""
  // ... existing logic unchanged
}),
```

For `apply`:

```ts
apply: Effect.fn("Vcs.apply")(function* (input: ApplyInput) {
  const ctx = yield* InstanceState.context
  if (ctx.project.vcs?.type === "custom") {
    const registry = yield* VcsProviderRegistryService
    const provider = yield* registry.get(ctx.project.vcs.provider)
    if (!provider) {
      return yield* new PatchApplyError({
        message: "Custom VCS provider not found",
        reason: "non-git",
      })
    }
    return yield* provider.apply(ctx.directory, input)
  }
  if (ctx.project.vcs !== "git") {
    // ... existing non-git error
  }
  // ... existing git apply logic unchanged
}),
```

Add `VcsProviderRegistryLive` to the Vcs node dependencies. In the `node` export (end of file):

```ts
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.provideMerge(layer, VcsProviderRegistryLive),
  deps: [Git.node, EventV2Bridge.node],
})
```

Import `VcsProviderRegistryLive`:

```ts
import { VcsProviderRegistryLive } from "@opencode-ai/core/vcs-provider"
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `packages/opencode`): `bun test test/project/vcs-provider.test.ts`
Expected: PASS — both `diff()` and `status()` dispatch to mock provider.

- [ ] **Step 5: Verify existing vcs tests still pass**

Run (from `packages/opencode`): `bun test test/project/vcs.test.ts`
Expected: All existing tests pass (git-only behavior unchanged).

- [ ] **Step 6: Verify typecheck**

Run (from `packages/opencode`): `bun typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/project/vcs.ts packages/opencode/test/project/vcs-provider.test.ts
git commit -m "feat(core): dispatch Vcs.Service to custom VCS providers"
```

---

## Phase 3: p8-repo Plugin

### Task 9: Scaffold p8-repo package and implement match()

**Files:**

- Create: `packages/plugin-p8-repo/package.json`
- Create: `packages/plugin-p8-repo/tsconfig.json`
- Create: `packages/plugin-p8-repo/src/index.ts`
- Create: `packages/plugin-p8-repo/src/provider.ts`
- Create: `packages/plugin-p8-repo/test/provider.test.ts`

**Interfaces:**

- Consumes: `VcsProvider` from `@opencode-ai/core/vcs-provider`, `PluginContext` from `@opencode-ai/plugin/v2/effect`
- Produces: p8-repo plugin that registers a VcsProvider detecting `.sub-repos/` workspaces

- [ ] **Step 1: Create package.json**

Create `packages/plugin-p8-repo/package.json`:

```json
{
  "name": "@opencode-ai/plugin-p8-repo",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsgo --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@opencode-ai/core": "workspace:*",
    "@opencode-ai/plugin": "workspace:*",
    "effect": "catalog:"
  },
  "devDependencies": {
    "@types/bun": "catalog:",
    "typescript": "catalog:"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `packages/plugin-p8-repo/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "types": ["bun-types"]
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 3: Write the failing test for match()**

Create `packages/plugin-p8-repo/test/provider.test.ts`:

```ts
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdir, mkdtemp as mkdtempOrig, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { match } from "../src/provider"

const mkdtemp = (prefix: string) => mkdtempOrig(join(tmpdir(), prefix))

describe("p8-repo provider match()", () => {
  it("returns true for directory with .sub-repos containing git repos", async () => {
    const tmp = await mkdtemp("p8-test-")
    await mkdir(join(tmp, ".sub-repos", "repo-a", ".git"), { recursive: true })
    await mkdir(join(tmp, ".sub-repos", "repo-b", ".git"), { recursive: true })
    const result = await Effect.runPromise(match(tmp))
    expect(result).toBe(true)
  })

  it("returns false for directory without .sub-repos", async () => {
    const tmp = await mkdtemp("p8-test-")
    const result = await Effect.runPromise(match(tmp))
    expect(result).toBe(false)
  })

  it("returns false for .sub-repos with no git repos inside", async () => {
    const tmp = await mkdtemp("p8-test-")
    await mkdir(join(tmp, ".sub-repos", "not-a-repo"), { recursive: true })
    const result = await Effect.runPromise(match(tmp))
    expect(result).toBe(false)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run (from `packages/plugin-p8-repo`): `bun test`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement provider with match()**

Create `packages/plugin-p8-repo/src/provider.ts`:

```ts
import { Effect } from "effect"
import { file, stat } from "fs/promises"
import { join } from "path"
import type { VcsProvider } from "@opencode-ai/core/vcs-provider"
import type {
  FileDiff,
  FileStatus,
  Mode,
  DiffOptions,
  ApplyInput,
  ApplyResult,
  PatchApplyError,
} from "@opencode-ai/core/vcs-types"
import { execGit } from "./git"

const SUB_REPOS_DIR = ".sub-repos"

export const match = (directory: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const subReposPath = join(directory, SUB_REPOS_DIR)
    const exists = yield* Effect.tryPromise(() =>
      stat(subReposPath)
        .then(() => true)
        .catch(() => false),
    )
    if (!exists) return false

    const entries = yield* Effect.tryPromise(() => readdir(subReposPath))
    for (const entry of entries) {
      const gitDir = join(subReposPath, entry, ".git")
      const hasGit = yield* Effect.tryPromise(() =>
        stat(gitDir)
          .then(() => true)
          .catch(() => false),
      )
      if (hasGit) return true
    }
    return false
  })

export const provider: VcsProvider = {
  id: "p8-repo",
  match,
  branch: () => Effect.succeed(undefined),
  defaultBranch: () => Effect.succeed(undefined),
  status: () => Effect.succeed([]),
  diff: () => Effect.succeed([]),
  diffRaw: () => Effect.succeed(""),
  apply: () => Effect.succeed({ applied: true } as ApplyResult),
}
```

Create `packages/plugin-p8-repo/src/git.ts` (placeholder for now):

```ts
import { Effect } from "effect"
import { spawn } from "child_process"

export const execGit = (cwd: string, args: string[]): Effect.Effect<string> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(
      () =>
        new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
          const proc = spawn("git", ["-C", cwd, ...args], { maxBuffer: 10 * 1024 * 1024 })
          let stdout = ""
          let stderr = ""
          proc.stdout.on("data", (d) => (stdout += d))
          proc.stderr.on("data", (d) => (stderr += d))
          proc.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }))
          proc.on("error", reject)
        }),
    )
    if (result.exitCode !== 0) {
      return yield* Effect.fail(new Error(`git ${args.join(" ")} failed: ${result.stderr}`))
    }
    return result.stdout
  })
```

Create `packages/plugin-p8-repo/src/index.ts`:

```ts
import { Effect } from "effect"
import { provider } from "./provider"

export const Plugin = {
  id: "p8-repo",
  effect: (ctx) =>
    Effect.gen(function* () {
      ctx.vcs.register(provider)
    }),
}
```

- [ ] **Step 6: Run test to verify it passes**

Run (from `packages/plugin-p8-repo`): `bun test`
Expected: PASS — all 3 match tests pass.

- [ ] **Step 7: Verify typecheck**

Run (from `packages/plugin-p8-repo`): `bun typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/plugin-p8-repo/
git commit -m "feat(plugin): scaffold p8-repo plugin with match() detection"
```

---

### Task 10: Implement diff() and status() for p8-repo

**Files:**

- Modify: `packages/plugin-p8-repo/src/provider.ts`
- Modify: `packages/plugin-p8-repo/src/git.ts`
- Test: `packages/plugin-p8-repo/test/provider.test.ts`

**Interfaces:**

- Consumes: `execGit` from Task 9
- Produces: `provider.diff()` returns merged `FileDiff[]` across all sub-repos with repo-prefixed paths

- [ ] **Step 1: Write failing tests for diff() and status()**

Add to `packages/plugin-p8-repo/test/provider.test.ts`:

```ts
import { provider } from "../src/provider"

describe("p8-repo provider diff()", () => {
  it("returns merged diffs from multiple repos with prefixed paths", async () => {
    const tmp = await mkdtemp("p8-test-")
    // Set up two git repos with changes
    await setupGitRepo(join(tmp, ".sub-repos", "repo-a"), "file-a.ts", "content-a")
    await setupGitRepo(join(tmp, ".sub-repos", "repo-b"), "file-b.ts", "content-b")
    await makeChange(join(tmp, ".sub-repos", "repo-a", "file-a.ts"), "modified-a")
    await makeChange(join(tmp, ".sub-repos", "repo-b", "file-b.ts"), "modified-b")

    const diffs = await Effect.runPromise(provider.diff(tmp, "git"))
    expect(diffs).toHaveLength(2)
    const paths = diffs.map((d) => d.file).sort()
    expect(paths).toContain("repo-a/file-a.ts")
    expect(paths).toContain("repo-b/file-b.ts")
  })
})

describe("p8-repo provider status()", () => {
  it("returns merged status from multiple repos", async () => {
    const tmp = await mkdtemp("p8-test-")
    await setupGitRepo(join(tmp, ".sub-repos", "repo-a"), "file-a.ts", "content-a")
    await makeChange(join(tmp, ".sub-repos", "repo-a", "file-a.ts"), "modified-a")

    const status = await Effect.runPromise(provider.status(tmp))
    expect(status).toHaveLength(1)
    expect(status[0].file).toBe("repo-a/file-a.ts")
  })
})
```

Add helper functions to the test file (after existing imports, the `mkdtemp` helper is already defined):

```ts
import { execSync } from "child_process"

const setupGitRepo = async (dir: string, file: string, content: string) => {
  await mkdir(dir, { recursive: true })
  execSync("git init", { cwd: dir })
  execSync("git config user.email test@test.com", { cwd: dir })
  execSync("git config user.name test", { cwd: dir })
  await writeFile(join(dir, file), content)
  execSync("git add .", { cwd: dir })
  execSync("git commit -m init", { cwd: dir })
}

const makeChange = async (file: string, content: string) => {
  await writeFile(file, content)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/plugin-p8-repo`): `bun test`
Expected: FAIL — `diff()` returns `[]`, `status()` returns `[]`.

- [ ] **Step 3: Implement scanSubRepos helper**

In `packages/plugin-p8-repo/src/provider.ts`, add:

```ts
const scanSubRepos = (directory: string): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const subReposPath = join(directory, SUB_REPOS_DIR)
    const entries = yield* Effect.tryPromise(() => readdir(subReposPath, { withFileTypes: true }))
    const repos: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const gitDir = join(subReposPath, entry.name, ".git")
      const hasGit = yield* Effect.tryPromise(() =>
        stat(gitDir)
          .then(() => true)
          .catch(() => false),
      )
      if (hasGit) repos.push(join(subReposPath, entry.name))
    }
    return repos
  })
```

- [ ] **Step 4: Implement status()**

Replace the `status` stub in `provider`:

```ts
status: (directory: string): Effect.Effect<FileStatus[]> =>
  Effect.gen(function* () {
    const repos = yield* scanSubRepos(directory)
    const results = yield* Effect.forEach(repos, (repoDir) =>
      Effect.gen(function* () {
        const repoName = basename(dirname(repoDir))
        const output = yield* execGit(repoDir, ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z"])
        const items = parseStatus(output)
        return items.map((item) => ({
          file: `${repoName}/${item.file}`,
          additions: item.additions,
          deletions: item.deletions,
          status: item.status,
        }))
      }),
    , { concurrency: "unbounded" })
    return results.flat()
  }),
```

Add status parsing helper:

```ts
const parseStatus = (
  output: string,
): { file: string; code: string; status: "added" | "deleted" | "modified"; additions: number; deletions: number }[] => {
  const items: {
    file: string
    code: string
    status: "added" | "deleted" | "modified"
    additions: number
    deletions: number
  }[] = []
  const entries = output.split("\0").filter(Boolean)
  for (const entry of entries) {
    const code = entry.slice(0, 2)
    const file = entry.slice(3)
    const status =
      code[0] === "?" || code[1] === "?" ? "added" : code[0] === "D" || code[1] === "D" ? "deleted" : "modified"
    items.push({ file, code, status, additions: 0, deletions: 0 })
  }
  return items
}
```

- [ ] **Step 5: Implement diff()**

Replace the `diff` stub in `provider`:

```ts
diff: (directory: string, mode: Mode, options?: DiffOptions): Effect.Effect<FileDiff[]> =>
  Effect.gen(function* () {
    const repos = yield* scanSubRepos(directory)
    const results = yield* Effect.forEach(repos, (repoDir) =>
      Effect.gen(function* () {
        const repoName = basename(dirname(repoDir))
        const hasHead = yield* execGit(repoDir, ["rev-parse", "--verify", "HEAD"]).pipe(
          Effect.map(() => true),
          Effect.catchAll(() => Effect.succeed(false)),
        )
        const ref = hasHead ? "HEAD" : undefined
        const statusOutput = yield* execGit(repoDir, ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z"])
        const items = parseStatus(statusOutput)

        const diffs: FileDiff[] = []
        for (const item of items) {
          const prefixedFile = `${repoName}/${item.file}`
          let patch = ""
          if (item.code === "??" || !ref) {
            patch = yield* execGit(repoDir, ["diff", "--no-index", "/dev/null", item.file]).pipe(
              Effect.map((p) => p),
              Effect.catchAll(() => Effect.succeed("")),
            )
          } else {
            patch = yield* execGit(repoDir, ["diff", "--no-ext-diff", "--no-renames", ref, "--", item.file]).pipe(
              Effect.catchAll(() => Effect.succeed("")),
            )
          }
          const additions = (patch.match(/^\+/gm) || []).length
          const deletions = (patch.match(/^\-/gm) || []).length
          diffs.push({
            file: prefixedFile,
            patch,
            additions,
            deletions,
            status: item.status,
          })
        }
        return diffs
      }),
    , { concurrency: "unbounded" })
    return results.flat()
  }),
```

- [ ] **Step 6: Run tests to verify they pass**

Run (from `packages/plugin-p8-repo`): `bun test`
Expected: PASS — all tests pass.

- [ ] **Step 7: Verify typecheck**

Run (from `packages/plugin-p8-repo`): `bun typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/plugin-p8-repo/src/ packages/plugin-p8-repo/test/
git commit -m "feat(plugin): implement p8-repo diff and status with multi-repo merge"
```

---

### Task 11: Implement remaining provider methods and plugin registration

**Files:**

- Modify: `packages/plugin-p8-repo/src/provider.ts`
- Modify: `packages/plugin-p8-repo/src/index.ts`

**Interfaces:**

- Consumes: Tasks 9-10
- Produces: Complete VcsProvider with branch, defaultBranch, diffRaw, apply; plugin registered via ctx.vcs

- [ ] **Step 1: Implement branch() and defaultBranch()**

In `packages/plugin-p8-repo/src/provider.ts`:

```ts
branch: (directory: string): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const repos = yield* scanSubRepos(directory)
    if (repos.length === 0) return undefined
    return yield* execGit(repos[0], ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
      Effect.map((b) => b.trim() || undefined),
      Effect.catchAll(() => Effect.succeed(undefined)),
    )
  }),

defaultBranch: (directory: string): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const repos = yield* scanSubRepos(directory)
    if (repos.length === 0) return undefined
    const output = yield* execGit(repos[0], ["symbolic-ref", "refs/remotes/origin/HEAD"]).pipe(
      Effect.map((o) => o.trim().replace("refs/remotes/origin/", "")),
      Effect.catchAll(() => Effect.succeed("main")),
    )
    return output
  }),
```

- [ ] **Step 2: Implement diffRaw()**

```ts
diffRaw: (directory: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const repos = yield* scanSubRepos(directory)
    const patches = yield* Effect.forEach(repos, (repoDir) =>
      execGit(repoDir, ["diff", "--no-ext-diff", "--no-renames", "HEAD"]).pipe(
        Effect.catchAll(() => Effect.succeed("")),
      ),
    , { concurrency: "unbounded" })
    return patches.filter(Boolean).join("\n")
  }),
```

- [ ] **Step 3: Implement apply()**

```ts
apply: (directory: string, input: ApplyInput): Effect.Effect<ApplyResult, PatchApplyError> =>
  Effect.gen(function* () {
    const repos = yield* scanSubRepos(directory)
    // Parse patch to find target repo from file path prefix
    const firstFileMatch = input.patch.match(/^diff --git a\/([^/]+)\//m)
    if (!firstFileMatch) {
      return yield* Effect.fail(new PatchApplyError({
        message: "Cannot determine target repo from patch",
        reason: "not-clean",
      }))
    }
    const repoName = firstFileMatch[1]
    const repoDir = repos.find((r) => r.endsWith(repoName))
    if (!repoDir) {
      return yield* Effect.fail(new PatchApplyError({
        message: `Repo "${repoName}" not found in workspace`,
        reason: "not-clean",
      }))
    }
    const result = yield* execGitRaw(repoDir, ["apply", "--whitespace=fix"], input.patch)
    if (result.exitCode !== 0) {
      return yield* Effect.fail(new PatchApplyError({
        message: `Patch apply failed: ${result.stderr}`,
        reason: "not-clean",
      }))
    }
    return { applied: true }
  }),
```

Add `execGitRaw` to `packages/plugin-p8-repo/src/git.ts`:

```ts
export const execGitRaw = (
  cwd: string,
  args: string[],
  stdin: string,
): Effect.Effect<{ exitCode: number; stderr: string }> =>
  Effect.tryPromise(
    () =>
      new Promise((resolve, reject) => {
        const proc = spawn("git", ["-C", cwd, ...args], { maxBuffer: 10 * 1024 * 1024 })
        proc.stdin.write(stdin)
        proc.stdin.end()
        let stderr = ""
        proc.stderr.on("data", (d) => (stderr += d))
        proc.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stderr }))
        proc.on("error", reject)
      }),
  )
```

- [ ] **Step 4: Finalize plugin entry**

Update `packages/plugin-p8-repo/src/index.ts`:

```ts
import { Effect } from "effect"
import type { PluginContext } from "@opencode-ai/plugin/v2/effect"
import { provider } from "./provider"

export const Plugin = {
  id: "p8-repo",
  effect: (ctx: PluginContext) =>
    Effect.gen(function* () {
      ctx.vcs.register(provider)
    }),
}

export { provider } from "./provider"
```

- [ ] **Step 5: Verify typecheck**

Run (from `packages/plugin-p8-repo`): `bun typecheck`
Expected: PASS.

- [ ] **Step 6: Run all plugin tests**

Run (from `packages/plugin-p8-repo`): `bun test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-p8-repo/
git commit -m "feat(plugin): complete p8-repo provider methods and registration"
```

---

## Phase 4: Integration & Validation

### Task 12: End-to-end validation against ponyai workspace

**Files:**

- No code changes — validation only

- [ ] **Step 1: Install dependencies**

Run (from repo root): `bun install`
Expected: `packages/plugin-p8-repo` installed as workspace package.

- [ ] **Step 2: Configure opencode.json for ponyai**

Add to `/home/zubingtan/work/ponyai/.sub-repos/config.json` (or create a new `opencode.json` in the workspace):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@opencode-ai/plugin-p8-repo"],
}
```

- [ ] **Step 3: Start opencode server against ponyai**

Run (from `packages/opencode`):

```
bun run --conditions=browser ./src/index.ts serve --port 4096 --cwd /home/zubingtan/work/ponyai
```

Expected: Server starts without errors.

- [ ] **Step 4: Verify VCS diff endpoint returns multi-repo diffs**

Run: `curl http://localhost:4096/instance/vcs/diff?mode=git`
Expected: JSON response with `FileDiff[]` containing files from multiple sub-repos with repo-prefixed paths (e.g. `perception/...`, `pnc/...`).

- [ ] **Step 5: Start web app and verify Review tab**

Run (from `packages/app`): `bun dev -- --port 4444`
Open `http://localhost:4444`. Navigate to a session, open Review tab.

Expected: Review tab shows diffs from multiple sub-repos.

- [ ] **Step 6: Run full test suite**

Run (from `packages/opencode`): `bun test`
Run (from `packages/core`): `bun test`
Run (from `packages/plugin-p8-repo`): `bun test`
Expected: All tests pass.

- [ ] **Step 7: Run typecheck across all packages**

Run (from repo root): `bun typecheck`
Expected: PASS.

- [ ] **Step 8: Commit any test/config changes**

```bash
git add -A
git commit -m "test: validate p8 multi-repo integration"
```

---

## Phase 5: Sync Hardening

### Task 13: Document sync runbook and verify idempotency

**Files:**

- Create: `docs/sync-runbook.md`

- [ ] **Step 1: Write sync runbook**

Create `docs/sync-runbook.md` documenting:

1. `git fetch upstream`
2. `git merge upstream/dev`
3. Resolve conflicts in: `packages/schema/src/project.ts`, `packages/core/src/project/schema.ts`, `packages/core/src/project.ts`, `packages/opencode/src/project/vcs.ts`, `packages/plugin/src/v2/effect/context.ts`, `packages/core/src/plugin/internal.ts`
4. `bun run script/fix-runners.ts` (re-apply runner labels)
5. `bun run script/add-owner-guards.ts` (re-apply owner guards)
6. `bun typecheck` + `bun turbo test` to verify

- [ ] **Step 2: Verify fix-runners.ts is idempotent**

Run: `bun run script/fix-runners.ts` again
Expected: "0 file(s) changed" — already applied.

- [ ] **Step 3: Dry-run upstream merge**

Run: `git merge --no-commit --no-ff upstream/dev`
Check conflict files. Abort: `git merge --abort`

Expected: Conflicts only in the 6 files listed in the spec. No conflicts in new files (`packages/core/src/vcs-provider.ts`, `packages/plugin-p8-repo/`, etc.).

- [ ] **Step 4: Commit**

```bash
git add docs/sync-runbook.md
git commit -m "docs: add upstream sync runbook"
```
