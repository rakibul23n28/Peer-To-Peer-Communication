import { existsSync } from "node:fs"

import { resolve } from "node:path"

import { spawnSync } from "node:child_process"

const envPath = resolve(process.cwd(), ".env")

if (existsSync(envPath)) process.loadEnvFile(envPath)

process.env.DIRECT_URL ||= process.env.DATABASE_URL

const prismaCli = resolve("node_modules", "prisma", "build", "index.js")

const result = spawnSync(
  process.execPath,
  [prismaCli, "generate", "--schema", "prisma/schema.prisma"],
  {
    stdio: "inherit",

    env: process.env,
  },
)

if (result.error) throw result.error

process.exitCode = result.status ?? 1
