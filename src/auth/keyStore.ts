export interface DeviceIdentity {
  userId: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBase64: string;
  fingerprint: string;
}

interface StoredIdentity extends DeviceIdentity {}

const DATABASE_NAME = 'orbit-device';
const STORE_NAME = 'identities';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'userId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open device key storage'));
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, done: (value: T) => void, fail: (error: Error) => void) => void,
): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    let result: T;
    let hasResult = false;
    operation(store, (value) => {
      result = value;
      hasResult = true;
    }, reject);
    tx.oncomplete = () => {
      db.close();
      if (hasResult) resolve(result);
      else resolve(undefined as T);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error('Device key storage failed'));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error('Device key storage was aborted'));
    };
  });
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function generateDeviceIdentity(userId: string): Promise<DeviceIdentity> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey', 'deriveBits'],
  ) as CryptoKeyPair;
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const fingerprintBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', publicBytes));
  return {
    userId,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeyBase64: base64(publicBytes),
    fingerprint: [...fingerprintBytes].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

export async function saveDeviceIdentity(identity: DeviceIdentity): Promise<void> {
  await transaction<void>('readwrite', (store, done, fail) => {
    const request = store.put(identity satisfies StoredIdentity);
    request.onsuccess = () => done(undefined);
    request.onerror = () => fail(request.error ?? new Error('Could not save device key'));
  });
}

export async function getDeviceIdentity(userId: string): Promise<DeviceIdentity | null> {
  return transaction<DeviceIdentity | null>('readonly', (store, done, fail) => {
    const request = store.get(userId);
    request.onsuccess = () => done((request.result as StoredIdentity | undefined) ?? null);
    request.onerror = () => fail(request.error ?? new Error('Could not read device key'));
  });
}
