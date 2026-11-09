import { derivePeerKey } from "../messageCrypto"
import type { DeviceIdentity } from "../keyStore"
import type { ConversationSummary } from "../session"

export type PreviewDirection = 0 | 1

export interface PreviewSessionKeys {
  ownerToViewer: CryptoKey
  viewerToOwner: CryptoKey
}

const encoder = new TextEncoder()

export async function derivePreviewSessionKeys(
  identity: DeviceIdentity,
  conversation: ConversationSummary,
  sessionId: string,
): Promise<PreviewSessionKeys> {
  const [ownerToViewer, viewerToOwner] = await Promise.all([
    derivePeerKey(
      identity,
      conversation.id,
      conversation.peer.publicKey,
      `orbit-preview-v1:${sessionId}:owner-to-viewer`,
    ),
    derivePeerKey(
      identity,
      conversation.id,
      conversation.peer.publicKey,
      `orbit-preview-v1:${sessionId}:viewer-to-owner`,
    ),
  ])
  return { ownerToViewer, viewerToOwner }
}

export function previewChunkIv(direction: PreviewDirection, rid: number, seq: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12)
  const view = new DataView(iv.buffer)
  view.setUint32(0, direction, false)
  view.setUint32(4, rid, false)
  view.setUint32(8, seq, false)
  return iv
}

function chunkAad(
  shareId: string,
  entry: number,
  rid: number,
  start: number,
  seq: number,
): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(`${shareId}|${entry}|${rid}|${start}|${seq}`))
}

export async function encryptPreviewChunk(
  key: CryptoKey,
  direction: PreviewDirection,
  shareId: string,
  entry: number,
  rid: number,
  start: number,
  seq: number,
  plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = new Uint8Array(plaintext.byteLength)
  input.set(plaintext)
  const encrypted = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: previewChunkIv(direction, rid, seq),
    additionalData: chunkAad(shareId, entry, rid, start, seq),
  }, key, input)
  return new Uint8Array(encrypted)
}

export async function decryptPreviewChunk(
  key: CryptoKey,
  direction: PreviewDirection,
  shareId: string,
  entry: number,
  rid: number,
  start: number,
  seq: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = new Uint8Array(ciphertext.byteLength)
  input.set(ciphertext)
  const decrypted = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: previewChunkIv(direction, rid, seq),
    additionalData: chunkAad(shareId, entry, rid, start, seq),
  }, key, input)
  return new Uint8Array(decrypted)
}
