export interface DeviceIdentity {
  userId: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBase64: string;
  fingerprint: string;
  keyVersion?: number;
}

interface StoredIdentity extends DeviceIdentity {}
interface ArchivedIdentity extends DeviceIdentity {
  storageKey: string;
}

const DATABASE_NAME = 'orbit-device';
const STORE_NAME = 'identities';
const ARCHIVE_STORE_NAME = 'identity-versions';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'userId' });
      }
      if (!request.result.objectStoreNames.contains(ARCHIVE_STORE_NAME)) {
        request.result.createObjectStore(ARCHIVE_STORE_NAME, { keyPath: 'storageKey' });
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

export async function archiveDeviceIdentity(identity: DeviceIdentity, keyVersion: number): Promise<void> {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new Error('A valid device key version is required to preserve message history.');
  }
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ARCHIVE_STORE_NAME, 'readwrite');
    const archived: ArchivedIdentity = {
      ...identity,
      keyVersion,
      storageKey: `${identity.userId}:${keyVersion}`,
    };
    const request = tx.objectStore(ARCHIVE_STORE_NAME).put(archived);
    request.onerror = () => reject(request.error ?? new Error('Could not preserve the previous device key.'));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Could not preserve the previous device key.'));
    tx.onabort = () => reject(tx.error ?? new Error('Preserving the previous device key was aborted.'));
  }).finally(() => db.close());
}

export async function getDeviceIdentity(userId: string): Promise<DeviceIdentity | null> {
  return transaction<DeviceIdentity | null>('readonly', (store, done, fail) => {
    const request = store.get(userId);
    request.onsuccess = () => done((request.result as StoredIdentity | undefined) ?? null);
    request.onerror = () => fail(request.error ?? new Error('Could not read device key'));
  });
}

export async function getDeviceIdentityForVersion(
  userId: string,
  keyVersion: number,
): Promise<DeviceIdentity | null> {
  const current = await getDeviceIdentity(userId);
  if (current?.keyVersion === keyVersion) return current;

  const db = await openDatabase();
  return new Promise<DeviceIdentity | null>((resolve, reject) => {
    const tx = db.transaction(ARCHIVE_STORE_NAME, 'readonly');
    const request = tx.objectStore(ARCHIVE_STORE_NAME).get(`${userId}:${keyVersion}`);
    request.onsuccess = () => {
      const archived = request.result as ArchivedIdentity | undefined;
      resolve(archived ? {
        userId: archived.userId,
        publicKey: archived.publicKey,
        privateKey: archived.privateKey,
        publicKeyBase64: archived.publicKeyBase64,
        fingerprint: archived.fingerprint,
        keyVersion: archived.keyVersion,
      } : null);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not read the previous device key.'));
    tx.onerror = () => reject(tx.error ?? new Error('Could not read the previous device key.'));
    tx.onabort = () => reject(tx.error ?? new Error('Reading the previous device key was aborted.'));
    tx.oncomplete = () => db.close();
  });
}

export async function getSavedDeviceIdentities(userId: string): Promise<DeviceIdentity[]> {
  const current = await getDeviceIdentity(userId);
  const db = await openDatabase();
  const archived = await new Promise<ArchivedIdentity[]>((resolve, reject) => {
    const tx = db.transaction(ARCHIVE_STORE_NAME, 'readonly');
    const request = tx.objectStore(ARCHIVE_STORE_NAME).getAll();
    request.onsuccess = () => resolve(
      (request.result as ArchivedIdentity[]).filter((identity) => identity.userId === userId),
    );
    request.onerror = () => reject(request.error ?? new Error('Could not read saved device key history.'));
    tx.onerror = () => reject(tx.error ?? new Error('Could not read saved device key history.'));
    tx.onabort = () => reject(tx.error ?? new Error('Reading saved device key history was aborted.'));
    tx.oncomplete = () => db.close();
  });

  const identities = [
    ...(current ? [current] : []),
    ...archived.map(({ storageKey: _storageKey, ...identity }) => identity),
  ];
  return identities.filter((identity, index) =>
    identities.findIndex((candidate) => candidate.fingerprint === identity.fingerprint) === index,
  );
}
