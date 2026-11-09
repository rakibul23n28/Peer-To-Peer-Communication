import { z } from "zod"

export const DOWNLOAD_LIMITS = {
  initialBlockBytes: 256 * 1024,
  maxBlockBytes: 8 * 1024 * 1024,
  maxBlocks: 32_768,
  maxRequestBytes: 8 * 1024 * 1024,
  chunkBytes: 16 * 1024,
  maxInflightReadsPerFile: 4,
  maxConcurrentFiles: 2,
  defaultWindow: 8,
  maxAttempts: 3,
  memoryBytes: 64 * 1024 * 1024,
  persistEveryBlocks: 8,
  journalDebounceMs: 1_000,
  maxRootNameBytes: 200,
} as const

const u32 = z.number().int().min(0).max(0xffffffff)
const safeSize = z.number().int().nonnegative().safe()
const rootHash = z.string().regex(/^[A-Za-z0-9+/]{43}=$/)

export const downloadControlSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    v: z.literal(1),
    shareId: z.string().uuid(),
    sessionId: z.string().uuid(),
  }).strict(),
  z.object({
    t: z.literal("caps"),
    download: z.boolean(),
    maxWindow: z.number().int().min(1).max(16),
  }).strict(),
  z.object({
    t: z.literal("get"),
    rid: u32,
    entry: safeSize,
    blockSize: z.number().int().min(DOWNLOAD_LIMITS.initialBlockBytes).max(DOWNLOAD_LIMITS.maxBlockBytes),
    first: safeSize,
    count: z.number().int().min(1).max(32),
  }).strict(),
  z.object({
    t: z.literal("verify"),
    rid: u32,
    entry: safeSize,
    blockSize: z.number().int().min(DOWNLOAD_LIMITS.initialBlockBytes).max(DOWNLOAD_LIMITS.maxBlockBytes),
  }).strict(),
  z.object({ t: z.literal("cancel"), rid: u32 }).strict(),
  z.object({
    t: z.literal("head"),
    rid: u32,
    size: safeSize,
    mtime: safeSize,
  }).strict(),
  z.object({
    t: z.literal("blk"),
    rid: u32,
    index: safeSize,
    len: z.number().int().positive().max(DOWNLOAD_LIMITS.maxBlockBytes),
    sha256: rootHash,
  }).strict(),
  z.object({ t: z.literal("done"), rid: u32 }).strict(),
  z.object({
    t: z.literal("vroot"),
    rid: u32,
    size: safeSize,
    root: rootHash,
    ms: safeSize,
  }).strict(),
  z.object({
    t: z.literal("err"),
    rid: u32,
    code: z.enum([
      "not_found",
      "revoked",
      "download_not_allowed",
      "changed",
      "permission_needed",
      "range_invalid",
      "busy",
      "io",
      "canceled",
    ]),
  }).strict(),
]).superRefine((message, context) => {
  if (message.t !== "get" && message.t !== "verify") return
  if (message.blockSize & (message.blockSize - 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid block size." })
  }
  if (message.t !== "get") return
  if (message.count * message.blockSize > DOWNLOAD_LIMITS.maxRequestBytes) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Download request exceeds its byte limit." })
  }
  if (message.first + message.count > DOWNLOAD_LIMITS.maxBlocks) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Download block range is too large." })
  }
})

export type DownloadControl = z.infer<typeof downloadControlSchema>
export type DownloadGetControl = Extract<DownloadControl, { t: "get" }>

export function encodeDownloadControl(control: DownloadControl): string {
  const encoded = JSON.stringify(downloadControlSchema.parse(control))
  if (new TextEncoder().encode(encoded).byteLength > 16 * 1024) {
    throw new Error("Download control frame is too large.")
  }
  return encoded
}

export function decodeDownloadControl(value: unknown): DownloadControl {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 16 * 1024) {
    throw new Error("Invalid download control frame.")
  }
  return downloadControlSchema.parse(JSON.parse(value))
}

export function encodeDownloadChunkFrame(rid: number, seq: number, ciphertext: Uint8Array): ArrayBuffer {
  if (!Number.isInteger(rid) || rid < 0 || rid > 0xffffffff ||
      !Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) {
    throw new Error("Invalid download frame header.")
  }
  const frame = new Uint8Array(8 + ciphertext.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, rid, false)
  view.setUint32(4, seq, false)
  frame.set(ciphertext, 8)
  return frame.buffer
}

export function decodeDownloadChunkFrame(value: ArrayBuffer): {
  rid: number
  seq: number
  ciphertext: Uint8Array
} {
  if (value.byteLength < 24) throw new Error("Invalid download data frame.")
  const view = new DataView(value)
  return { rid: view.getUint32(0, false), seq: view.getUint32(4, false), ciphertext: new Uint8Array(value, 8) }
}
