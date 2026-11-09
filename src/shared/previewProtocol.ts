import { z } from "zod"

export const PREVIEW_LIMITS = {
  maxRangeBytes: 8 * 1024 * 1024,
  chunkBytes: 16 * 1024,
  maxInflightReads: 4,
  connectTimeoutMs: 15_000,
  idleTimeoutMs: 60_000,
  serviceWorkerWindowBytes: 1024 * 1024,
  fallbackMaxBytes: 64 * 1024 * 1024,
  textInitialBytes: 512 * 1024,
  textMaxBytes: 10 * 1024 * 1024,
  docxMaxBytes: 25 * 1024 * 1024,
  controlFrameBytes: 16 * 1024,
  signalWindowMs: 60_000,
  signalLimit: 60,
  maxSessionsPerShare: 4,
} as const

const uuid = z.string().uuid()

export const previewControlSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    v: z.literal(1),
    shareId: uuid,
    sessionId: uuid,
  }).strict(),
  z.object({
    t: z.literal("read"),
    rid: z.number().int().min(0).max(0xffffffff),
    entry: z.number().int().nonnegative().safe(),
    start: z.number().int().nonnegative().safe(),
    end: z.number().int().positive().safe(),
  }).strict(),
  z.object({
    t: z.literal("cancel"),
    rid: z.number().int().min(0).max(0xffffffff),
  }).strict(),
  z.object({
    t: z.literal("head"),
    rid: z.number().int().min(0).max(0xffffffff),
    size: z.number().int().nonnegative().safe(),
    mtime: z.number().int().nonnegative().safe(),
  }).strict(),
  z.object({
    t: z.literal("done"),
    rid: z.number().int().min(0).max(0xffffffff),
    bytes: z.number().int().nonnegative().safe(),
  }).strict(),
  z.object({
    t: z.literal("err"),
    rid: z.number().int().min(0).max(0xffffffff),
    code: z.enum([
      "not_found",
      "revoked",
      "changed",
      "permission_needed",
      "range_invalid",
      "busy",
      "too_large",
      "io",
    ]),
  }).strict(),
]).superRefine((message, context) => {
  if (
    message.t === "read" &&
    (message.end <= message.start ||
      message.end - message.start > PREVIEW_LIMITS.maxRangeBytes)
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid byte range" })
  }
})

export type PreviewControl = z.infer<typeof previewControlSchema>
export type PreviewReadControl = Extract<PreviewControl, { t: "read" }>

export const previewSignalSchema = z.object({
  shareId: uuid,
  sessionId: uuid,
  kind: z.enum(["offer", "answer", "ice", "bye"]),
  payload: z.unknown(),
}).strict()

export type PreviewSignal = z.infer<typeof previewSignalSchema>

export const previewRtcPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("offer"),
    sdp: z.string().min(1).max(PREVIEW_LIMITS.controlFrameBytes),
  }).strict(),
  z.object({
    kind: z.literal("answer"),
    sdp: z.string().min(1).max(PREVIEW_LIMITS.controlFrameBytes),
  }).strict(),
  z.object({
    kind: z.literal("ice"),
    candidate: z.object({
      candidate: z.string().max(2048),
      sdpMid: z.string().max(256).nullable().optional(),
      sdpMLineIndex: z.number().int().min(0).max(1024).nullable().optional(),
      usernameFragment: z.string().max(256).nullable().optional(),
    }).strict(),
  }).strict(),
  z.object({ kind: z.literal("bye") }).strict(),
])

export function encodePreviewControl(message: PreviewControl): string {
  const encoded = JSON.stringify(previewControlSchema.parse(message))
  if (new TextEncoder().encode(encoded).byteLength > PREVIEW_LIMITS.controlFrameBytes) {
    throw new Error("Preview control frame is too large.")
  }
  return encoded
}

export function decodePreviewControl(value: unknown): PreviewControl {
  if (typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > PREVIEW_LIMITS.controlFrameBytes) {
    throw new Error("Invalid preview control frame.")
  }
  return previewControlSchema.parse(JSON.parse(value))
}

export function encodePreviewChunkHeader(
  rid: number,
  seq: number,
  ciphertext: Uint8Array,
): ArrayBuffer {
  if (
    !Number.isInteger(rid) || rid < 0 || rid > 0xffffffff ||
    !Number.isInteger(seq) || seq < 0 || seq > 0xffffffff
  ) throw new Error("Invalid preview chunk header.")
  const frame = new Uint8Array(8 + ciphertext.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, rid, false)
  view.setUint32(4, seq, false)
  frame.set(ciphertext, 8)
  return frame.buffer
}

export function decodePreviewChunkHeader(value: ArrayBuffer): {
  rid: number
  seq: number
  ciphertext: Uint8Array
} {
  if (value.byteLength < 24) throw new Error("Invalid preview binary frame.")
  const view = new DataView(value)
  return {
    rid: view.getUint32(0, false),
    seq: view.getUint32(4, false),
    ciphertext: new Uint8Array(value, 8),
  }
}

export function validatePreviewRange(start: number, end: number, size: number): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(size) ||
    start < 0 ||
    end <= start ||
    end > size ||
    end - start > PREVIEW_LIMITS.maxRangeBytes
  ) throw new RangeError("Invalid preview byte range.")
}

export function previewSignalDirectionValid(isOwner: boolean, kind: PreviewSignal["kind"]): boolean {
  if (kind === "offer") return !isOwner
  if (kind === "answer") return isOwner
  return true
}
