import Dexie, { type Table } from "dexie";

interface CachedTextMessage {
  clientMsgId: string;
  conversationId: string;
  plaintext: string;
  createdAt: string;
}

class OrbitMessageCache extends Dexie {
  pendingText!: Table<CachedTextMessage, string>;

  constructor() {
    super("orbit-message-cache");
    this.version(1).stores({
      pendingText: "clientMsgId, conversationId, createdAt",
    });
  }
}

const cache = new OrbitMessageCache();

export function saveLocalMessage(message: CachedTextMessage): Promise<string> {
  return cache.pendingText.put(message);
}

export function getLocalMessage(clientMsgId: string): Promise<CachedTextMessage | undefined> {
  return cache.pendingText.get(clientMsgId);
}

export function removeLocalMessage(clientMsgId: string): Promise<void> {
  return cache.pendingText.delete(clientMsgId);
}
