import { readdir, readFile } from "node:fs/promises"

import path from "node:path"

const root = process.cwd()

const roots = ["src", "dist"]

const bannedCopy = [
  "Alex Morgan",

  "Sophie Chen",

  "James Wilson",

  "Maya Patel",

  "Daniel Kim",

  "Quiet orbits.fig",

  "18.4 MB",

  "Local preview",

  "local draft",

  "TODAY, JUNE 18",
]

const forbiddenImport =
  /(?:from\s*|import\s*\()\s*['"][^'"]*(?:mocks\/|fixtures\/|faker|\.stories\.)/i

const issues = []

async function inspect(directory) {
  let entries

  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (directory === path.join(root, "dist") && error.code === "ENOENT") return

    throw error
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      await inspect(fullPath)

      continue
    }

    const content = await readFile(fullPath, "utf8")

    const relative = path.relative(root, fullPath)

    for (const text of bannedCopy) {
      if (content.includes(text))
        issues.push(`${relative}: forbidden demo copy "${text}"`)
    }

    if (forbiddenImport.test(content))
      issues.push(`${relative}: forbidden mock/fixture/story import`)
  }
}

for (const directory of roots) {
  await inspect(path.join(root, directory))
}

if (issues.length) {
  console.error(issues.join("\n"))

  process.exitCode = 1
} else {
  console.log(
    "No demo copy or mock imports found in source or production bundle.",
  )
}
