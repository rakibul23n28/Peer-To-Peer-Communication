import assert from "node:assert/strict"
import test from "node:test"

import { UsersRepository } from "../src/modules/users/users.repository.ts"
import type { PrismaService } from "../src/modules/prisma/prisma.service.ts"

test("public key history returns available versions, including revoked historical keys", async () => {
  const keys = [
    { publicKey: Buffer.from("current"), fingerprint: "current-fingerprint", keyVersion: 8 },
    { publicKey: Buffer.from("historical"), fingerprint: "historical-fingerprint", keyVersion: 6 },
  ]
  let query: unknown
  const repository = new UsersRepository({
    user: {
      findFirst: async (value: unknown) => {
        query = value
        return { id: "user-id", keys }
      },
    },
  } as unknown as PrismaService)

  const result = await repository.publicKeys("user-id")

  assert.deepEqual(result, [
    {
      id: "user-id",
      publicKey: Buffer.from("current").toString("base64"),
      fingerprint: "current-fingerprint",
      keyVersion: 8,
    },
    {
      id: "user-id",
      publicKey: Buffer.from("historical").toString("base64"),
      fingerprint: "historical-fingerprint",
      keyVersion: 6,
    },
  ])
  assert.deepEqual(query, {
    where: { id: "user-id", deletedAt: null },
    select: {
      id: true,
      keys: {
        orderBy: { keyVersion: "desc" },
        select: { publicKey: true, fingerprint: true, keyVersion: true },
      },
    },
  })
})

test("public key history returns null for users without stored keys", async () => {
  const repository = new UsersRepository({
    user: { findFirst: async () => ({ id: "user-id", keys: [] }) },
  } as unknown as PrismaService)

  assert.equal(await repository.publicKeys("user-id"), null)
})
