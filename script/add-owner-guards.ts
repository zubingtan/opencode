import { file, write } from "bun"

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

const guard = "github.repository_owner == 'anomalyco'"

for (const name of orgInternal) {
  const filePath = `.github/workflows/${name}.yml`
  const text = await file(filePath)
    .text()
    .catch(() => null)
  if (text === null) {
    console.log(`Skip (missing): ${filePath}`)
    continue
  }
  if (text.includes(guard)) {
    console.log(`Skip (already guarded): ${filePath}`)
    continue
  }

  const lines = text.split("\n")
  const out: string[] = []
  let inJobs = false
  let jobHasIf = false
  let inserted = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (/^jobs:/.test(line)) {
      inJobs = true
      out.push(line)
      continue
    }
    if (inJobs && /^[A-Za-z]/.test(line) && !line.startsWith(" ")) {
      inJobs = false
      out.push(line)
      continue
    }
    if (!inJobs) {
      out.push(line)
      continue
    }

    if (/^  \S/.test(line) && !line.startsWith("    ")) {
      jobHasIf = false
      out.push(line)
      continue
    }

    if (/^    if:/.test(line)) {
      jobHasIf = true
      out.push(line.replace(/^    if: /, `    if: ${guard} && `))
      inserted++
      continue
    }

    if (/^    runs-on:/.test(line) && !jobHasIf) {
      let hasIfAhead = false
      for (let j = i + 1; j < lines.length; j++) {
        const ahead = lines[j]
        if (/^  \S/.test(ahead) && !ahead.startsWith("    ")) break
        if (/^[A-Za-z]/.test(ahead) && !ahead.startsWith(" ")) break
        if (/^    if:/.test(ahead)) {
          hasIfAhead = true
          break
        }
      }
      if (!hasIfAhead) {
        out.push(`    if: ${guard}`)
        inserted++
      }
      out.push(line)
      continue
    }

    out.push(line)
  }

  await write(filePath, out.join("\n"))
  console.log(`Updated: ${filePath} (${inserted} guard(s))`)
}

console.log("Done.")
