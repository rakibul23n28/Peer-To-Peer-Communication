import { spawnSync } from "node:child_process"

const compose = ["compose", "-f", "docker-compose.test.yml"]

const databaseUrl =
  "postgresql://orbit_test:orbit_test_only@127.0.0.1:55432/orbit_test"

const environment = {
  ...process.env,

  DATABASE_URL: databaseUrl,

  DIRECT_URL: databaseUrl,

  TEST_DATABASE_URL: databaseUrl,

  NODE_ENV: "test",
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  })

  if (result.error) throw result.error

  if (result.status !== 0)
    throw new Error(`${command} exited with status ${result.status}`)
}

let failed = false

try {
  run("docker", [...compose, "up", "-d", "--wait"])

  run(process.execPath, ["scripts/generate-prisma.mjs"], environment)

  run(
    process.execPath,
    [
      "node_modules/prisma/build/index.js",

      "migrate",

      "reset",

      "--force",

      "--skip-seed",

      "--schema",

      "prisma/schema.prisma",
    ],
    environment,
  )

  run(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "test/prisma.integration.test.ts",
    ],
    environment,
  )

  run(
    process.execPath,
    [
      "node_modules/prisma/build/index.js",

      "db",

      "execute",

      "--schema",

      "prisma/schema.prisma",

      "--file",

      "scripts/verify-db.sql",
    ],
    environment,
  )
} catch (error) {
  failed = true

  console.error(
    error instanceof Error ? error.message : "Integration verification failed",
  )
} finally {
  try {
    run("docker", [...compose, "down", "-v", "--remove-orphans"])
  } catch (error) {
    failed = true

    console.error(
      error instanceof Error
        ? error.message
        : "Could not stop throwaway database",
    )
  }
}

if (failed) process.exitCode = 1
