import assert from "node:assert/strict"
import test from "node:test"

import {
  decryptAccessRequestNote,
  encryptAccessRequestNote,
} from "../src/auth/messageCrypto.ts"
import type { DeviceIdentity } from "../src/auth/keyStore.ts"
import type { ConversationSummary } from "../src/auth/session.ts"

function base64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

test("access-request notes decrypt for the conversation peer and bind ciphertext to the request ID", async () => {
  const requester = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )
  const owner = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )
  const requesterPublicKey = base64(await crypto.subtle.exportKey("spki", requester.publicKey))
  const ownerPublicKey = base64(await crypto.subtle.exportKey("spki", owner.publicKey))
  const requestId = crypto.randomUUID()
  const conversationId = crypto.randomUUID()
  const requesterIdentity = {
    userId: crypto.randomUUID(),
    publicKey: requester.publicKey,
    privateKey: requester.privateKey,
    publicKeyBase64: requesterPublicKey,
    fingerprint: "",
  } satisfies DeviceIdentity
  const ownerIdentity = {
    userId: crypto.randomUUID(),
    publicKey: owner.publicKey,
    privateKey: owner.privateKey,
    publicKeyBase64: ownerPublicKey,
    fingerprint: "",
  } satisfies DeviceIdentity
  const requesterConversation = {
    id: conversationId,
    peer: { publicKey: ownerPublicKey },
  } as ConversationSummary
  const ownerConversation = {
    id: conversationId,
    peer: { publicKey: requesterPublicKey },
  } as ConversationSummary

  const encrypted = await encryptAccessRequestNote(
    requesterIdentity,
    requesterConversation,
    requestId,
    "Please let me know when this is ready.",
  )

  assert.equal(await decryptAccessRequestNote(
    ownerIdentity,
    ownerConversation,
    requestId,
    encrypted.ciphertext,
    encrypted.iv,
  ), "Please let me know when this is ready.")
  await assert.rejects(() => decryptAccessRequestNote(
    ownerIdentity,
    ownerConversation,
    crypto.randomUUID(),
    encrypted.ciphertext,
    encrypted.iv,
  ))
})
