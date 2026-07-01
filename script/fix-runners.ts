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
