import { DOWNLOAD_LIMITS } from "../../shared/downloadProtocol"

export type DownloadState =
  | "queued" | "connecting" | "downloading" | "paused" | "waiting_for_peer"
  | "interrupted" | "verifying" | "repairing" | "saving" | "completed"
  | "source_changed" | "failed" | "canceled"

export type DownloadEvent =
  | { type: "CONNECT" }
  | { type: "CONNECTED" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "DISCONNECT" }
  | { type: "INTERRUPT" }
  | { type: "VERIFY" }
  | { type: "REPAIR" }
  | { type: "SAVE" }
  | { type: "COMPLETE" }
  | { type: "SOURCE_CHANGED" }
  | { type: "FAIL" }
  | { type: "CANCEL" }
  | { type: "RESTART" }

const transitions: Record<DownloadState, Partial<Record<DownloadEvent["type"], DownloadState>>> = {
  queued: { CONNECT: "connecting", CANCEL: "canceled", FAIL: "failed" },
  connecting: { CONNECTED: "downloading", DISCONNECT: "waiting_for_peer", PAUSE: "paused", SOURCE_CHANGED: "source_changed", FAIL: "failed", CANCEL: "canceled" },
  downloading: { PAUSE: "paused", DISCONNECT: "waiting_for_peer", VERIFY: "verifying", SOURCE_CHANGED: "source_changed", FAIL: "failed", CANCEL: "canceled" },
  paused: { RESUME: "connecting", DISCONNECT: "waiting_for_peer", SOURCE_CHANGED: "source_changed", CANCEL: "canceled", FAIL: "failed" },
  waiting_for_peer: { RESUME: "connecting", CONNECT: "connecting", CANCEL: "canceled", FAIL: "failed", SOURCE_CHANGED: "source_changed" },
  interrupted: { RESUME: "connecting", CANCEL: "canceled", FAIL: "failed" },
  verifying: { REPAIR: "repairing", SAVE: "saving", SOURCE_CHANGED: "source_changed", FAIL: "failed", CANCEL: "canceled" },
  repairing: { VERIFY: "verifying", SOURCE_CHANGED: "source_changed", FAIL: "failed", CANCEL: "canceled" },
  saving: { COMPLETE: "completed", FAIL: "failed", CANCEL: "canceled" },
  completed: { RESTART: "queued" },
  source_changed: { RESTART: "queued", CANCEL: "canceled" },
  failed: { RESUME: "connecting", RESTART: "queued", CANCEL: "canceled" },
  canceled: { RESTART: "queued" },
}

export function reduceDownloadState(state: DownloadState, event: DownloadEvent): DownloadState {
  return transitions[state][event.type] ?? state
}

export function planDownloadBlocks(size: number): { blockSize: number; totalBlocks: number } {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("Invalid file size.")
  let blockSize = DOWNLOAD_LIMITS.initialBlockBytes
  let totalBlocks = Math.ceil(size / blockSize)
  while (totalBlocks > DOWNLOAD_LIMITS.maxBlocks && blockSize < DOWNLOAD_LIMITS.maxBlockBytes) {
    blockSize = Math.min(blockSize * 2, DOWNLOAD_LIMITS.maxBlockBytes)
    totalBlocks = Math.ceil(size / blockSize)
  }
  if (totalBlocks > DOWNLOAD_LIMITS.maxBlocks) throw new RangeError("File exceeds the supported download size.")
  return { blockSize, totalBlocks }
}

export function blockLength(size: number, blockSize: number, index: number): number {
  const start = index * blockSize
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) throw new RangeError("Invalid block index.")
  return Math.min(blockSize, size - start)
}

const encoder = new TextEncoder()

export async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input.buffer))
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export async function createDownloadRootHash(
  blockSize: number,
  size: number,
  blockHashes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const totalBlocks = Math.ceil(size / blockSize)
  if (!Number.isSafeInteger(size) || size < 0 || blockHashes.byteLength !== totalBlocks * 32) {
    throw new RangeError("Invalid block hash journal.")
  }
  const domain = encoder.encode("orbit-root-v1")
  const header = new Uint8Array(12)
  const view = new DataView(header.buffer)
  view.setUint32(0, blockSize, false)
  view.setBigUint64(4, BigInt(size), false)
  const input = new Uint8Array(domain.length + header.length + blockHashes.length)
  input.set(domain)
  input.set(header, domain.length)
  input.set(blockHashes, domain.length + header.length)
  return sha256(input)
}

const reservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

export function sanitizePathSegment(value: string, entryId: number): string {
  let name = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, DOWNLOAD_LIMITS.maxRootNameBytes)
  if (!name || name === "." || name === "..") name = `file-${entryId}`
  if (reservedNames.test(name)) name = `_${name}`
  return name
}

export function sanitizeRelativePath(path: string, entryId: number): string[] {
  const segments = path.split("/")
  if (path.startsWith("/") || path.includes("\\") || segments.some((part) =>
    !part || part === "." || part === ".." || part.includes("/") || part.includes("\\"),
  )) throw new Error("Unsafe shared folder path.")
  return segments.map((segment) => sanitizePathSegment(segment, entryId))
}

export function allocateUniquePath(path: string[], usedPaths: Set<string>): string[] {
  const result = [...path]
  const keyFor = (segments: string[]) => segments.join("/").toLocaleLowerCase()
  const originalPath = result[result.length - 1]
  let suffix = 1
  while (usedPaths.has(keyFor(result))) {
    const dot = originalPath.lastIndexOf(".")
    const stem = dot > 0 ? originalPath.slice(0, dot) : originalPath
    const extension = dot > 0 ? originalPath.slice(dot) : ""
    result[result.length - 1] = `${stem} (${suffix++})${extension}`
  }
  for (let index = 0; index < result.length - 1; index += 1) {
    usedPaths.add(keyFor(result.slice(0, index + 1)))
  }
  usedPaths.add(keyFor(result))
  return result
}

export function setBitmapBit(bitmap: Uint8Array, index: number, value: boolean): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= bitmap.length * 8) throw new RangeError("Invalid bitmap index.")
  const mask = 1 << (index & 7)
  if (value) bitmap[index >> 3] |= mask
  else bitmap[index >> 3] &= ~mask
}

export function hasBitmapBit(bitmap: Uint8Array, index: number): boolean {
  if (!Number.isSafeInteger(index) || index < 0 || index >= bitmap.length * 8) return false
  return Boolean(bitmap[index >> 3] & (1 << (index & 7)))
}

export function makeBitmap(totalBlocks: number): Uint8Array {
  if (!Number.isSafeInteger(totalBlocks) || totalBlocks < 0 || totalBlocks > DOWNLOAD_LIMITS.maxBlocks) {
    throw new RangeError("Invalid block count.")
  }
  return new Uint8Array(Math.ceil(totalBlocks / 8))
}
