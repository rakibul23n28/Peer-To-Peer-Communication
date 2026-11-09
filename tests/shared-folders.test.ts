import assert from "node:assert/strict"
import test from "node:test"

import { decryptFolderManifest, encryptFolderManifest } from "../src/auth/shared-folders/crypto.ts"
import { decodeBase64 } from "../src/modules/messages/messages.repository.ts"
import { SharedFoldersRepository } from "../src/modules/shared-folders/shared-folders.repository.ts"
import { PrismaService } from "../src/modules/prisma/prisma.service.ts"
import { Prisma } from "@prisma/client"
import {
  SHARED_FOLDER_LIMITS,
  buildSharedFolderTree,
  sanitizeManifestEntries,
  sharedFolderManifestSchema,
  sharedFolderRecordSchema,
  sortSharedFolderNodes,
  type SharedFolderEntry,
} from "../src/shared/sharedFolders.ts"
import { summarizeManifest } from "../src/auth/shared-folders/picker.ts"

const userId = "83e5bb73-b51d-42b4-a2d9-b2fb778185dd"
const otherUserId = "b1c816bd-2b4c-44ac-92ef-fbc7ea8dbd17"
const conversationId = "ce2c2985-cb84-4bc8-bdb5-f879303e0ef0"
const shareId = "05a133b9-3d06-4bc1-83f8-f4aa4fc3ac29"

test("sanitizes unsafe paths and keeps prototype-like names as ordinary data", () => {
  const entries: SharedFolderEntry[] = [
    { id: 0, p: "../outside", k: "f", s: 1 },
    { id: 1, p: "/absolute", k: "f", s: 1 },
    { id: 2, p: "a\\b", k: "f", s: 1 },
    { id: 3, p: "control\u0001name", k: "f", s: 1 },
    { id: 4, p: `${"n".repeat(256)}.txt`, k: "f", s: 1 },
    { id: 5, p: "a//b", k: "f", s: 1 },
    { id: 6, p: "__proto__", k: "d" },
    { id: 7, p: "constructor", k: "f", s: 2 },
  ]
  const sanitized = sanitizeManifestEntries(entries)
  assert.equal(sanitized.hiddenCount, 6)
  const tree = buildSharedFolderTree(sanitized.entries)
  assert.equal(tree.children.get("__proto__")?.kind, "d")
  assert.equal(tree.children.get("constructor")?.size, 2)
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false)
})

test("builds nested and empty folders and natural-sorts folders before files", () => {
  const entries: SharedFolderEntry[] = [
    { id: 0, p: "file10.txt", k: "f", s: 10 },
    { id: 1, p: "file2.txt", k: "f", s: 20 },
    { id: 2, p: "empty", k: "d" },
    { id: 3, p: "nested/child.txt", k: "f", s: 30, m: 1700000000000 },
    { id: 4, p: "nested", k: "d" },
  ]
  const tree = buildSharedFolderTree(entries)
  const summary = summarizeManifest(sharedFolderManifestSchema.parse({
    v: 1,
    rootName: "Folder",
    scannedAt: 1,
    entries,
  }))
  const sorted = sortSharedFolderNodes([...tree.children.values()])
  assert.deepEqual(sorted.map(({ name }) => name), ["empty", "nested", "file2.txt", "file10.txt"])
  assert.equal(tree.children.get("nested")?.children.get("child.txt")?.size, 30)
  assert.equal(tree.children.get("empty")?.children.size, 0)
  assert.equal(summary.files, 3)
  assert.equal(summary.folders, 2)
  assert.equal(summary.totalSize, 60)
})

test("encrypts and decrypts a manifest with conversation and share AAD binding", async () => {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
  const manifest = sharedFolderManifestSchema.parse({
    v: 1,
    rootName: "Folder",
    scannedAt: 1731090000000,
    entries: [
      { id: 0, p: "empty", k: "d" },
      { id: 1, p: "child.txt", k: "f", s: 12, m: 1700000000000 },
    ],
  })
  const encrypted = await encryptFolderManifest(manifest, key, conversationId, shareId)
  const record = {
    ...encrypted,
    formatVersion: 1,
  }
  const decrypted = await decryptFolderManifest(record, key, conversationId, shareId)
  assert.deepEqual(decrypted.manifest, manifest)
  await assert.rejects(decryptFolderManifest(record, key, otherUserId, shareId))
  await assert.rejects(decryptFolderManifest(record, key, conversationId, otherUserId))
})

test("rejects manifests over 50,000 entries and encrypted payloads over 4 MiB", () => {
  const entries = Array.from({ length: SHARED_FOLDER_LIMITS.maxEntries + 1 }, (_, id) => ({
    id,
    p: `file-${id}`,
    k: "f" as const,
    s: 1,
  }))
  assert.throws(() => sharedFolderManifestSchema.parse({
    v: 1,
    rootName: "Folder",
    scannedAt: 1,
    entries,
  }))

  const oversized = Buffer.alloc(SHARED_FOLDER_LIMITS.maxPayloadBytes + 1).toString("base64")
  assert.throws(() => decodeBase64(
    oversized,
    16,
    SHARED_FOLDER_LIMITS.maxPayloadBytes,
    "Encrypted folder manifest",
  ))
})

test("normalizes Prisma Buffer JSON values in shared-folder records", () => {
  const ciphertext = Buffer.alloc(16, 7)
  const iv = Buffer.alloc(12, 3)
  const record = sharedFolderRecordSchema.parse({
    id: shareId,
    conversationId,
    ownerId: userId,
    ciphertext: { type: "Buffer", data: [...ciphertext] },
    iv: { type: "Buffer", data: [...iv] },
    formatVersion: 1,
    compressed: false,
    payloadBytes: ciphertext.length,
    createdAt: new Date("2026-11-09T00:00:00.000Z").toISOString(),
    revokedAt: null,
  })
  assert.equal(record.ciphertext, ciphertext.toString("base64"))
  assert.equal(record.iv, iv.toString("base64"))

  const typedArrayJson = sharedFolderRecordSchema.parse({
    id: shareId,
    conversationId,
    ownerId: userId,
    ciphertext: JSON.parse(JSON.stringify(new Uint8Array(ciphertext))),
    iv: JSON.parse(JSON.stringify(new Uint8Array(iv))),
    formatVersion: 1,
    compressed: false,
    payloadBytes: ciphertext.length,
    createdAt: new Date("2026-11-09T00:00:00.000Z").toISOString(),
    revokedAt: null,
  })
  assert.equal(typedArrayJson.ciphertext, ciphertext.toString("base64"))
  assert.equal(typedArrayJson.iv, iv.toString("base64"))
})

test("serializes the create response to base64 instead of returning Prisma byte objects", async () => {
  const ciphertext = Buffer.alloc(16, 7)
  const iv = Buffer.alloc(12, 3)
  const createdAt = new Date("2026-11-09T00:00:00.000Z")
  const repository = new SharedFoldersRepository({
    $transaction: async (operation: (tx: unknown) => unknown) => operation({
      conversation: {
        findFirst: async () => ({ userA: userId, userB: otherUserId }),
      },
      $queryRaw: async () => [],
      block: { findFirst: async () => null },
      sharedFolder: {
        count: async () => 0,
        create: async () => ({
          id: shareId,
          conversationId,
          ownerId: userId,
          ciphertext,
          iv,
          formatVersion: 1,
          compressed: false,
          payloadBytes: ciphertext.length,
          createdAt,
          revokedAt: null,
        }),
      },
    }),
  } as unknown as PrismaService)

  const record = await repository.create(conversationId, userId, {
    id: shareId,
    ciphertext,
    iv,
    formatVersion: 1,
    compressed: false,
    payloadBytes: ciphertext.length,
  })
  assert.equal(record.ciphertext, ciphertext.toString("base64"))
  assert.equal(record.iv, iv.toString("base64"))
  assert.equal(typeof record.ciphertext, "string")
  assert.equal(typeof record.iv, "string")
})

test("returns not-found for non-participants and revoked shares and forbids non-owner revoke", async () => {
  const nonParticipant = new SharedFoldersRepository({
    conversation: { findFirst: async () => null },
  } as unknown as PrismaService)
  await assert.rejects(nonParticipant.list(conversationId, userId), (error: { getStatus?: () => number }) => error.getStatus?.() === 404)

  const revokedShare = new SharedFoldersRepository({
    sharedFolder: { findFirst: async () => null },
  } as unknown as PrismaService)
  await assert.rejects(revokedShare.get(shareId, userId), (error: { getStatus?: () => number }) => error.getStatus?.() === 404)

  const nonOwner = new SharedFoldersRepository({
    sharedFolder: {
      findFirst: async () => ({
        id: shareId,
        conversationId,
        ownerId: otherUserId,
      }),
    },
  } as unknown as PrismaService)
  await assert.rejects(nonOwner.revoke(shareId, userId), (error: { getStatus?: () => number }) => error.getStatus?.() === 403)

  let updated = false
  const ownerRepository = new SharedFoldersRepository({
    sharedFolder: {
      findFirst: async () => ({
        id: shareId,
        conversationId,
        ownerId: userId,
      }),
      update: async () => { updated = true },
    },
  } as unknown as PrismaService)
  assert.deepEqual(await ownerRepository.revoke(shareId, userId), { id: shareId, conversationId })
  assert.equal(updated, true)
})

test("rejects creation when either conversation participant has blocked the other", async () => {
  const repository = new SharedFoldersRepository({
    $transaction: async (operation: (tx: unknown) => unknown) => operation({
      conversation: {
        findFirst: async () => ({ userA: userId, userB: otherUserId }),
      },
      $queryRaw: async () => [],
      block: { findFirst: async () => ({ blockerId: otherUserId }) },
    }),
  } as unknown as PrismaService)
  await assert.rejects(repository.create(conversationId, userId, {
    id: shareId,
    ciphertext: Buffer.alloc(16),
    iv: Buffer.alloc(12),
    formatVersion: 1,
    compressed: false,
    payloadBytes: 16,
  }), (error: { getStatus?: () => number }) => error.getStatus?.() === 403)
})

test("maps duplicate share ids to HTTP 409", async () => {
  const duplicate = new Prisma.PrismaClientKnownRequestError("duplicate", {
    code: "P2002",
    clientVersion: "6.19.3",
    meta: { target: ["id"] },
  })
  const repository = new SharedFoldersRepository({
    $transaction: async (operation: (tx: unknown) => unknown) => operation({
      conversation: {
        findFirst: async () => ({ userA: userId, userB: otherUserId }),
      },
      $queryRaw: async () => [],
      block: { findFirst: async () => null },
      sharedFolder: {
        count: async () => 0,
        create: async () => { throw duplicate },
      },
    }),
  } as unknown as PrismaService)
  await assert.rejects(repository.create(conversationId, userId, {
    id: shareId,
    ciphertext: Buffer.alloc(16),
    iv: Buffer.alloc(12),
    formatVersion: 1,
    compressed: false,
    payloadBytes: 16,
  }), (error: { getStatus?: () => number }) => error.getStatus?.() === 409)
})
