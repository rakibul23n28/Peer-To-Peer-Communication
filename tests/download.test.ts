import assert from "node:assert/strict"
import test from "node:test"

import {
  DOWNLOAD_LIMITS,
  decodeDownloadChunkFrame,
  decodeDownloadControl,
  encodeDownloadChunkFrame,
  encodeDownloadControl,
  downloadControlSchema,
} from "../src/shared/downloadProtocol.ts"
import {
  allocateUniquePath,
  blockLength,
  bytesToBase64,
  createDownloadRootHash,
  hasBitmapBit,
  makeBitmap,
  planDownloadBlocks,
  reduceDownloadState,
  sanitizePathSegment,
  sanitizeRelativePath,
  setBitmapBit,
  sha256,
} from "../src/auth/shared-folders/downloadCore.ts"
import {
  decryptDownloadChunk,
  downloadChunkIv,
  encryptDownloadChunk,
} from "../src/auth/shared-folders/downloadCrypto.ts"
import { MemorySink } from "../src/auth/shared-folders/sinks/MemorySink.ts"

test("download block planner handles zero, short, adaptive and >4 GiB sizes", () => {
  assert.deepEqual(planDownloadBlocks(0), { blockSize: DOWNLOAD_LIMITS.initialBlockBytes, totalBlocks: 0 })
  assert.deepEqual(planDownloadBlocks(12), { blockSize: DOWNLOAD_LIMITS.initialBlockBytes, totalBlocks: 1 })
  assert.equal(blockLength(600_000, 256 * 1024, 2), 75_712)
  const large = planDownloadBlocks(5 * 1024 ** 3)
  assert.ok(large.totalBlocks <= DOWNLOAD_LIMITS.maxBlocks)
  assert.ok(large.blockSize >= DOWNLOAD_LIMITS.initialBlockBytes)
  assert.throws(() => blockLength(12, 4, 3))
})

test("download protocol validates controls and binary frame headers", () => {
  const get = {
    t: "get" as const,
    rid: 42,
    entry: 7,
    blockSize: DOWNLOAD_LIMITS.initialBlockBytes,
    first: 3,
    count: 4,
  }
  assert.deepEqual(decodeDownloadControl(encodeDownloadControl(get)), get)
  assert.equal(downloadControlSchema.safeParse({ ...get, count: 33 }).success, false)
  assert.equal(downloadControlSchema.safeParse({ ...get, blockSize: 300_000 }).success, false)
  assert.equal(downloadControlSchema.safeParse({
    t: "verify",
    rid: 42,
    entry: 7,
    blockSize: 300_000,
  }).success, false)
  assert.throws(() => decodeDownloadControl(JSON.stringify({ ...get, first: -1 })))
  const frame = encodeDownloadChunkFrame(42, 4, new Uint8Array(16).fill(8))
  assert.deepEqual(decodeDownloadChunkFrame(frame), {
    rid: 42,
    seq: 4,
    ciphertext: new Uint8Array(16).fill(8),
  })
})

test("download chunk AEAD binds share, entry, request, block, sequence and direction nonce", async () => {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
  const source = new TextEncoder().encode("a verified download block")
  const encrypted = await encryptDownloadChunk(key, 0, "share", 2, 9, 12, 0, source)
  const clear = await decryptDownloadChunk(key, 0, "share", 2, 9, 12, 0, encrypted)
  assert.deepEqual(clear, source)
  await assert.rejects(decryptDownloadChunk(key, 0, "other-share", 2, 9, 12, 0, encrypted))
  await assert.rejects(decryptDownloadChunk(key, 0, "share", 3, 9, 12, 0, encrypted))
  await assert.rejects(decryptDownloadChunk(key, 0, "share", 2, 10, 12, 0, encrypted))
  await assert.rejects(decryptDownloadChunk(key, 0, "share", 2, 9, 13, 0, encrypted))
  assert.notDeepEqual(downloadChunkIv(0, 9, 0), downloadChunkIv(1, 9, 0))
  assert.notDeepEqual(downloadChunkIv(0, 9, 0), downloadChunkIv(0, 10, 0))
  assert.notDeepEqual(downloadChunkIv(0, 9, 0), downloadChunkIv(0, 9, 1))
})

test("root hash is domain-, size-, block-size- and content-bound", async () => {
  const first = new TextEncoder().encode("block one")
  const second = new TextEncoder().encode("block two")
  const hashes = new Uint8Array(64)
  hashes.set(await sha256(first), 0)
  hashes.set(await sha256(second), 32)
  const root = await createDownloadRootHash(256 * 1024, 512 * 1024, hashes)
  assert.equal(bytesToBase64(root).length, 44)
  assert.notDeepEqual(root, await createDownloadRootHash(512 * 1024, 1024 * 1024, hashes))
  const changed = hashes.slice()
  changed[0] ^= 1
  assert.notDeepEqual(root, await createDownloadRootHash(256 * 1024, 512 * 1024, changed))
  assert.equal((await createDownloadRootHash(256 * 1024, 0, new Uint8Array())).length, 32)
})

test("local path sanitizer protects reserved names and resolves case-insensitive collisions", () => {
  for (const reserved of ["CON", "prn.txt", "AUX", "NUL", "COM1", "LPT9"]) {
    assert.match(sanitizePathSegment(reserved, 1), /^_/)
  }
  assert.equal(sanitizePathSegment("a:b?. ", 2), "a_b_")
  assert.deepEqual(sanitizeRelativePath("src/A.txt", 1), ["src", "A.txt"])
  assert.throws(() => sanitizeRelativePath("../secret", 1))
  assert.throws(() => sanitizeRelativePath("a\\\\b", 1))
  const used = new Set<string>()
  assert.deepEqual(allocateUniquePath(["folder", "A.txt"], used), ["folder", "A.txt"])
  assert.deepEqual(allocateUniquePath(["folder", "a.txt"], used), ["folder", "a (1).txt"])
  assert.deepEqual(allocateUniquePath(["folder", "other.txt"], used), ["folder", "other.txt"])
})

test("download bitmaps and total reducer handle every state/event pair", () => {
  const bitmap = makeBitmap(10)
  setBitmapBit(bitmap, 9, true)
  assert.equal(hasBitmapBit(bitmap, 9), true)
  setBitmapBit(bitmap, 9, false)
  assert.equal(hasBitmapBit(bitmap, 9), false)
  const states = [
    "queued", "connecting", "downloading", "paused", "waiting_for_peer", "interrupted",
    "verifying", "repairing", "saving", "completed", "source_changed", "failed", "canceled",
  ] as const
  const events = [
    "CONNECT", "CONNECTED", "PAUSE", "RESUME", "DISCONNECT", "INTERRUPT", "VERIFY",
    "REPAIR", "SAVE", "COMPLETE", "SOURCE_CHANGED", "FAIL", "CANCEL", "RESTART",
  ] as const
  for (const state of states) {
    for (const type of events) {
      assert.ok(states.includes(reduceDownloadState(state, { type })))
    }
  }
  assert.equal(reduceDownloadState("downloading", { type: "PAUSE" }), "paused")
  assert.equal(reduceDownloadState("waiting_for_peer", { type: "RESUME" }), "connecting")
  assert.equal(reduceDownloadState("completed", { type: "RESTART" }), "queued")
})

test("memory sink performs bounded random-access writes and rejects files over 64 MiB", async () => {
  const sink = new MemorySink()
  await sink.open({ id: "local", size: 5, blockSize: 4 })
  await sink.writeBlock(1, new Uint8Array([5]))
  await sink.writeBlock(0, new Uint8Array([1, 2, 3, 4]))
  assert.deepEqual(await sink.readBlock(0), new Uint8Array([1, 2, 3, 4]))
  assert.deepEqual(await sink.readBlock(1), new Uint8Array([5]))
  const file = await sink.getFile()
  assert.equal(file.size, 5)
  await assert.rejects(
    sink.open({ id: "too-large", size: DOWNLOAD_LIMITS.memoryBytes + 1, blockSize: 4 }),
    /64 MiB/,
  )
})
