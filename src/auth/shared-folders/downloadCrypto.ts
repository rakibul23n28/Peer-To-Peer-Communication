import { derivePeerKey } from "../messageCrypto"
import type { DeviceIdentity } from "../keyStore"
import type { ConversationSummary } from "../session"

export interface DownloadSessionKeys {
  ownerToViewer: CryptoKey
  viewerToOwner: CryptoKey
}

const encoder = new TextEncoder()

export async function deriveDownloadSessionKeys(
  identity: DeviceIdentity,
  conversation: ConversationSummary,
  sessionId: string,
): Promise<DownloadSessionKeys> {
  const [ownerToViewer, viewerToOwner] = await Promise.all([
    derivePeerKey(identity, conversation.id, conversation.peer.publicKey, `orbit-dl-v1:${sessionId}:owner-to-viewer`),
    derivePeerKey(identity, conversation.id, conversation.peer.publicKey, `orbit-dl-v1:${sessionId}:viewer-to-owner`),
  ])
  return { ownerToViewer, viewerToOwner }
}

export function downloadChunkIv(direction: 0 | 1, rid: number, seq: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12)
  const view = new DataView(iv.buffer)
  view.setUint32(0, direction, false)
  view.setUint32(4, rid, false)
  view.setUint32(8, seq, false)
  return iv
}

function downloadChunkAad(
  shareId: string,
  entry: number,
  rid: number,
  blockIndex: number,
  seq: number,
): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(`${shareId}|${entry}|${rid}|${blockIndex}|${seq}`))
}

export async function encryptDownloadChunk(
  key: CryptoKey,
  direction: 0 | 1,
  shareId: string,
  entry: number,
  rid: number,
  blockIndex: number,
  seq: number,
  plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = new Uint8Array(plaintext.byteLength)
  input.set(plaintext)
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: downloadChunkIv(direction, rid, seq),
    additionalData: downloadChunkAad(shareId, entry, rid, blockIndex, seq),
  }, key, input)
  return new Uint8Array(ciphertext)
}

export async function decryptDownloadChunk(
  key: CryptoKey,
  direction: 0 | 1,
  shareId: string,
  entry: number,
  rid: number,
  blockIndex: number,
  seq: number,
  ciphertext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = new Uint8Array(ciphertext.byteLength)
  input.set(ciphertext)
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: downloadChunkIv(direction, rid, seq),
    additionalData: downloadChunkAad(shareId, entry, rid, blockIndex, seq),
  }, key, input)
  return new Uint8Array(plaintext)
}
