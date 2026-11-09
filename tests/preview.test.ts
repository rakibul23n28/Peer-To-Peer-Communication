import assert from "node:assert/strict"
import test from "node:test"

import {
  PREVIEW_LIMITS,
  decodePreviewChunkHeader,
  decodePreviewControl,
  encodePreviewChunkHeader,
  encodePreviewControl,
  previewControlSchema,
  previewSignalDirectionValid,
  validatePreviewRange,
} from "../src/shared/previewProtocol.ts"
import {
  decryptPreviewChunk,
  derivePreviewSessionKeys,
  encryptPreviewChunk,
  previewChunkIv,
} from "../src/auth/shared-folders/previewCrypto.ts"
import {
  previewFileChanged,
  previewReadIsBusy,
  resolvePreviewFileEntry,
  resolvePreviewPathSegments,
} from "../src/shared/previewAuthorization.ts"
import type { DeviceIdentity } from "../src/auth/keyStore.ts"
import type { ConversationSummary } from "../src/auth/session.ts"
import {
  COMMON_EXCLUDED_DIRECTORIES,
  DEFAULT_EXCLUDED_DIRECTORIES,
  makeManifest,
  parseExcludedDirectoryNames,
} from "../src/auth/shared-folders/picker.ts"
import {
  getPreviewDescriptor,
  previewMagicMatches,
  zipHasRootEntry,
  zipIsWithinPreviewBounds,
} from "../src/auth/shared-folders/previewTypes.ts"
import { parsePreviewRange, previewRangeHeaders } from "../public/__preview/preview-range.js"
import type { SharedFolderManifest } from "../src/shared/sharedFolders.ts"

const shareId = "05a133b9-3d06-4bc1-83f8-f4aa4fc3ac29"
const sessionId = "ce2c2985-cb84-4bc8-bdb5-f879303e0ef0"
const conversationId = "83e5bb73-b51d-42b4-a2d9-b2fb778185dd"

test("validates and encodes preview controls and binary frames", () => {
  const read = { t: "read", rid: 42, entry: 3, start: 100, end: 200 } as const
  assert.deepEqual(decodePreviewControl(encodePreviewControl(read)), read)
  assert.equal(previewControlSchema.safeParse({ ...read, end: read.start }).success, false)
  assert.equal(previewControlSchema.safeParse({ ...read, end: read.start + PREVIEW_LIMITS.maxRangeBytes + 1 }).success, false)
  assert.equal(decodePreviewControl(encodePreviewControl({
    t: "hello",
    v: 1,
    shareId,
    sessionId,
  })).t, "hello")
  assert.throws(() => decodePreviewControl(JSON.stringify({ t: "read", rid: -1 })))

  const cipherText = new Uint8Array(16).fill(7)
  const chunk = encodePreviewChunkHeader(42, 7, cipherText)
  const decoded = decodePreviewChunkHeader(chunk)
  assert.equal(decoded.rid, 42)
  assert.equal(decoded.seq, 7)
  assert.deepEqual([...decoded.ciphertext], [...cipherText])
  assert.equal(previewSignalDirectionValid(false, "offer"), true)
  assert.equal(previewSignalDirectionValid(true, "offer"), false)
  assert.equal(previewSignalDirectionValid(true, "answer"), true)
  assert.equal(previewSignalDirectionValid(false, "answer"), false)
})

test("derives session keys and authenticates byte-range chunks with all AAD fields", async () => {
  const alice = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey", "deriveBits"],
  ) as CryptoKeyPair
  const bob = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey", "deriveBits"],
  ) as CryptoKeyPair
  const alicePublic = new Uint8Array(await crypto.subtle.exportKey("spki", alice.publicKey))
  const bobPublic = new Uint8Array(await crypto.subtle.exportKey("spki", bob.publicKey))
  const encode = (bytes: Uint8Array) => {
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  const identity = (userId: string, pair: CryptoKeyPair, publicKey: Uint8Array): DeviceIdentity => ({
    userId,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyBase64: encode(publicKey),
    fingerprint: userId,
  })
  const aliceIdentity = identity("alice", alice, alicePublic)
  const bobIdentity = identity("bob", bob, bobPublic)
  const conversation = (publicKey: string): ConversationSummary => ({
    id: conversationId,
    peer: {
      id: "peer",
      username: "peer",
      displayName: "Peer",
      publicKey,
      fingerprint: "fingerprint",
      keyVersion: 1,
      keyAvailable: true,
    },
    unreadCount: 0,
    lastMessage: null,
  })
  const aliceKeys = await derivePreviewSessionKeys(aliceIdentity, conversation(encode(bobPublic)), sessionId)
  const bobKeys = await derivePreviewSessionKeys(bobIdentity, conversation(encode(alicePublic)), sessionId)
  const plaintext = new TextEncoder().encode("preview bytes")
  const encrypted = await encryptPreviewChunk(aliceKeys.ownerToViewer, 0, shareId, 4, 17, 128, 0, plaintext)
  const decrypted = await decryptPreviewChunk(bobKeys.ownerToViewer, 0, shareId, 4, 17, 128, 0, encrypted)
  assert.deepEqual([...decrypted], [...plaintext])
  await assert.rejects(decryptPreviewChunk(bobKeys.ownerToViewer, 0, shareId, 4, 17, 129, 0, encrypted))
  await assert.rejects(decryptPreviewChunk(bobKeys.ownerToViewer, 0, shareId, 4, 18, 128, 0, encrypted))
  await assert.rejects(decryptPreviewChunk(bobKeys.ownerToViewer, 0, shareId, 5, 17, 128, 0, encrypted))
  await assert.rejects(decryptPreviewChunk(bobKeys.ownerToViewer, 0, sessionId, 4, 17, 128, 0, encrypted))

  const ivs = [
    previewChunkIv(0, 1, 0),
    previewChunkIv(1, 1, 0),
    previewChunkIv(0, 2, 0),
    previewChunkIv(0, 1, 1),
  ].map((iv) => Buffer.from(iv).toString("hex"))
  assert.equal(new Set(ivs).size, ivs.length)
})

test("rejects unsafe owner paths and resolves only file entry ids", () => {
  const manifest: SharedFolderManifest = {
    v: 1,
    rootName: "Root",
    scannedAt: 1,
    entries: [
      { id: 0, p: "safe/file.txt", k: "f", s: 7, m: 10 },
      { id: 1, p: "folder", k: "d" },
    ],
  }
  assert.deepEqual(resolvePreviewPathSegments("safe/file.txt"), ["safe", "file.txt"])
  for (const path of ["../secret", "/absolute", "a\\b", "a//b", "a/./b", "a/../b"]) {
    assert.equal(resolvePreviewPathSegments(path), null)
  }
  assert.equal(resolvePreviewFileEntry(manifest, 0)?.p, "safe/file.txt")
  assert.equal(resolvePreviewFileEntry(manifest, 1), null)
  assert.equal(resolvePreviewFileEntry(manifest, 99), null)
  assert.equal(previewFileChanged(manifest.entries[0], { size: 7, lastModified: 10 }), false)
  assert.equal(previewFileChanged(manifest.entries[0], { size: 8, lastModified: 10 }), true)
  assert.equal(previewFileChanged(manifest.entries[0], { size: 7, lastModified: 11 }), true)
  assert.equal(previewReadIsBusy(PREVIEW_LIMITS.maxInflightReads), true)
  assert.equal(previewReadIsBusy(PREVIEW_LIMITS.maxInflightReads - 1), false)
  assert.throws(() => validatePreviewRange(4, 4, 10))
  assert.throws(() => validatePreviewRange(0, 9 * 1024 * 1024, 10 * 1024 * 1024))
})

test("parses media ranges and produces no-store, nosniff partial response headers", () => {
  assert.deepEqual(parsePreviewRange("bytes=10-19", 100, PREVIEW_LIMITS.serviceWorkerWindowBytes), { start: 10, end: 20 })
  assert.deepEqual(parsePreviewRange("bytes=90-", 100, PREVIEW_LIMITS.serviceWorkerWindowBytes), { start: 90, end: 100 })
  assert.deepEqual(parsePreviewRange("bytes=-12", 100, PREVIEW_LIMITS.serviceWorkerWindowBytes), { start: 88, end: 100 })
  assert.deepEqual(parsePreviewRange(null, 3_000_000, PREVIEW_LIMITS.serviceWorkerWindowBytes), { start: 0, end: PREVIEW_LIMITS.serviceWorkerWindowBytes })
  assert.equal(parsePreviewRange("bytes=100-101", 100, 1000), null)
  assert.equal(parsePreviewRange("bytes=1-2,4-5", 100, 1000), null)
  const headers = previewRangeHeaders(10, 20, 100, "video/mp4")
  assert.equal(headers.get("Content-Range"), "bytes 10-19/100")
  assert.equal(headers.get("Content-Length"), "10")
  assert.equal(headers.get("Cache-Control"), "no-store")
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff")
  assert.equal(headers.get("Content-Type"), "video/mp4")
})

test("matches preview extensions to signatures and rejects binary-looking text", () => {
  assert.equal(getPreviewDescriptor("paper.tex", 128).kind, "text")
  assert.equal(previewMagicMatches("image", "x.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true)
  assert.equal(previewMagicMatches("image", "x.png", new Uint8Array([0xff, 0xd8, 0xff])), false)
  assert.equal(previewMagicMatches("pdf", "x.pdf", new TextEncoder().encode("%PDF-1.7")), true)
  assert.equal(previewMagicMatches("video", "x.mp4", new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70])), true)
  assert.equal(previewMagicMatches("audio", "x.wav", new TextEncoder().encode("RIFF0000WAVE")), true)
  assert.equal(previewMagicMatches("text", "x.txt", new Uint8Array([65, 66, 0, 67])), false)
  assert.equal(getPreviewDescriptor("table.xlsx", 10).kind, "unsupported")
  assert.equal(getPreviewDescriptor("video.MOV", 10).mime, "video/quicktime")
})

test("folder exclusions are validated and removed before sharing", () => {
  const excluded = parseExcludedDirectoryNames("cache, output")
  assert.deepEqual([...excluded], ["cache", "output"])
  assert.throws(() => parseExcludedDirectoryNames("../private"))
  assert.ok(COMMON_EXCLUDED_DIRECTORIES.includes("node_modules"))
  assert.ok(DEFAULT_EXCLUDED_DIRECTORIES.includes("node_modules"))
  const manifest = makeManifest({
    rootName: "Project",
    entries: [
      { id: 0, p: "src/app.ts", k: "f", s: 10, m: 1 },
      { id: 1, p: "node_modules/pkg/index.js", k: "f", s: 20, m: 2 },
      { id: 2, p: "node_modules/pkg", k: "d" },
      { id: 3, p: "vendor/lib.js", k: "f", s: 30, m: 3 },
    ],
  }, false, new Set(["node_modules"]))
  assert.deepEqual(manifest.entries.map(({ p, id }) => [id, p]), [
    [0, "src/app.ts"],
    [1, "vendor/lib.js"],
  ])
})

test("detects DOCX content-types entries from a ZIP central directory", () => {
  const entryName = new TextEncoder().encode("[Content_Types].xml")
  const localSize = 30 + entryName.length
  const centralSize = 46 + entryName.length
  const bytes = new Uint8Array(localSize + centralSize + 22)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(26, entryName.length, true)
  bytes.set(entryName, 30)
  const central = localSize
  view.setUint32(central, 0x02014b50, true)
  view.setUint16(central + 28, entryName.length, true)
  bytes.set(entryName, central + 46)
  const end = localSize + centralSize
  view.setUint32(end, 0x06054b50, true)
  view.setUint16(end + 8, 1, true)
  view.setUint16(end + 10, 1, true)
  view.setUint32(end + 12, centralSize, true)
  view.setUint32(end + 16, localSize, true)
  assert.equal(zipHasRootEntry(bytes, "[Content_Types].xml"), true)
  assert.equal(zipHasRootEntry(bytes, "word/document.xml"), false)
  assert.equal(zipIsWithinPreviewBounds(bytes), true)
  view.setUint32(central + 20, 1, true)
  view.setUint32(central + 24, 200 * 1024 * 1024, true)
  assert.equal(zipIsWithinPreviewBounds(bytes), false)
})
