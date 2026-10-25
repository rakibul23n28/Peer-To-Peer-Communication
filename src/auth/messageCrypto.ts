import type { ConversationSummary } from './session';
import type { DeviceIdentity } from './keyStore';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function encodeBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function conversationKey(identity: DeviceIdentity, conversation: ConversationSummary): Promise<CryptoKey> {
  if (!conversation.peer.publicKey) throw new Error('This contact does not have an active public key.');
  const peerPublicKey = await crypto.subtle.importKey(
    'spki',
    decodeBase64(conversation.peer.publicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    identity.privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(conversation.id),
      info: encoder.encode('orbit-text-message-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptMessage(
  identity: DeviceIdentity,
  conversation: ConversationSummary,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await conversationKey(identity, conversation);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer },
    key,
    encoder.encode(plaintext),
  );
  return { ciphertext: encodeBase64(ciphertext), iv: encodeBase64(iv.buffer) };
}

export async function decryptMessage(
  identity: DeviceIdentity,
  conversation: ConversationSummary,
  ciphertext: string,
  iv: string,
): Promise<string> {
  const key = await conversationKey(identity, conversation);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64(iv) },
    key,
    decodeBase64(ciphertext),
  );
  return decoder.decode(plaintext);
}
