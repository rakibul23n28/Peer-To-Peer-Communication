import {
  SHARED_FOLDER_LIMITS,
  sanitizeManifestEntries,
  sharedFolderManifestSchema,
  untrustedSharedFolderManifestSchema,
  type SharedFolderManifest,
} from "../../shared/sharedFolders"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
type OwnedBytes = Uint8Array<ArrayBuffer>

function base64ToBytes(value: string): OwnedBytes {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function bytesToBase64(value: Uint8Array): string {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function folderAad(conversationId: string, shareId: string, formatVersion: number): OwnedBytes {
  return new Uint8Array(encoder.encode(`orbit-shared-folder:${conversationId}:${shareId}:${formatVersion}`))
}

async function transformStream(
  bytes: Uint8Array<ArrayBufferLike>,
  kind: "compress" | "decompress",
): Promise<OwnedBytes> {
  const transform = kind === "compress"
    ? new CompressionStream("gzip")
    : new DecompressionStream("gzip")
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)
  const output = new Blob([input.buffer]).stream().pipeThrough(transform)
  const reader = output.getReader()
  const chunks: Uint8Array<ArrayBufferLike>[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    const max = SHARED_FOLDER_LIMITS.maxManifestBytes
    if (total > max) {
      await reader.cancel()
      throw new Error(kind === "compress"
        ? "This folder manifest exceeds Orbit's safe processing limit."
        : "This shared folder manifest is too large to open.")
    }
    chunks.push(value)
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

export async function encryptFolderManifest(
  manifest: SharedFolderManifest,
  key: CryptoKey,
  conversationId: string,
  shareId: string,
): Promise<{ ciphertext: string; iv: string; compressed: boolean; payloadBytes: number }> {
  const plaintext = encoder.encode(JSON.stringify(sharedFolderManifestSchema.parse(manifest)))
  let payload: OwnedBytes = plaintext
  let compressed = false
  if (typeof CompressionStream !== "undefined") {
    try {
      payload = await transformStream(plaintext, "compress")
      compressed = true
      if (
        payload.byteLength + 16 > SHARED_FOLDER_LIMITS.maxPayloadBytes &&
        plaintext.byteLength + 16 <= SHARED_FOLDER_LIMITS.maxPayloadBytes
      ) {
        payload = plaintext
        compressed = false
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("4 MiB")) throw error
      payload = plaintext
    }
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: folderAad(conversationId, shareId, 1),
    },
    key,
    payload,
  ))
  if (encrypted.byteLength > SHARED_FOLDER_LIMITS.maxPayloadBytes) {
    throw new Error("This folder manifest is larger than Orbit's 4 MiB limit.")
  }
  return {
    ciphertext: bytesToBase64(encrypted),
    iv: bytesToBase64(iv),
    compressed,
    payloadBytes: encrypted.byteLength,
  }
}

export async function decryptFolderManifest(
  record: {
    ciphertext: string
    iv: string
    compressed: boolean
    formatVersion: number
    payloadBytes: number
  },
  key: CryptoKey,
  conversationId: string,
  shareId: string,
): Promise<{ manifest: SharedFolderManifest; invalidCount: number }> {
  if (
    record.formatVersion !== 1 ||
    record.payloadBytes > SHARED_FOLDER_LIMITS.maxPayloadBytes ||
    record.payloadBytes < 16
  ) throw new Error("Unsupported or oversized shared folder payload.")
  const ciphertext = base64ToBytes(record.ciphertext)
  const iv = base64ToBytes(record.iv)
  if (iv.byteLength !== 12 || ciphertext.byteLength !== record.payloadBytes) {
    throw new Error("Invalid shared folder payload.")
  }
  const decrypted: OwnedBytes = new Uint8Array(await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: folderAad(conversationId, shareId, record.formatVersion),
    },
    key,
    ciphertext,
  ))
  const plaintext = record.compressed
    ? await transformStream(decrypted, "decompress")
    : decrypted
  if (plaintext.byteLength > SHARED_FOLDER_LIMITS.maxManifestBytes) {
    throw new Error("This shared folder manifest is too large to open.")
  }
  const raw = untrustedSharedFolderManifestSchema.parse(
    JSON.parse(decoder.decode(plaintext)),
  )
  const sanitized = sanitizeManifestEntries(raw.entries)
  return {
    manifest: sharedFolderManifestSchema.parse({
      ...raw,
      entries: sanitized.entries,
    }),
    invalidCount: sanitized.hiddenCount,
  }
}
