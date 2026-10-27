import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  addMessageReceipt,
  blockUser,
  createConversation,
  createFileOffer,
  deleteMessage,
  editMessage,
  getUserPublicKey,
  getMessages,
  getConversations,
  listBlocks,
  searchUsers,
  removeMessageReaction,
  setMessageReaction,
  unblockUser,
  updateFileStatus,
  type ConversationSummary,
  type EncryptedMessage,
  type UserIdentity,
  type UserSearchResult,
} from './session';
import {
  retryOrbitSocket,
  requestOrbitEvent,
  sendOrbitEvent,
  startOrbitSocket,
  subscribeOrbitConnection,
  subscribeOrbitEvents,
  type OrbitConnectionState,
} from './orbitSocket';
import { decryptMessage, derivePeerKey, encryptMessage } from './messageCrypto';
import { getDeviceIdentity, getDeviceIdentityForVersion, getSavedDeviceIdentities, type DeviceIdentity } from './keyStore';
import { getLocalMessage, removeLocalMessage, saveLocalMessage } from './messageCache';
import { PeerFileTransfer, type PeerFileSignal } from './peerFileTransfer';
import { ConversationThread, type FileTransferProgress, type ThreadMessage } from './components/ConversationThread';
import { ConversationSidebar } from './components/ConversationSidebar';
import { EmptyConversationState } from './components/EmptyConversationState';
import { OrbitDialogs, type OrbitDialogKind } from './components/OrbitDialogs';

interface AuthenticatedHomeProps {
  user: UserIdentity;
  onSignOut: () => void;
  busy: boolean;
  message: string;
}

type OutboxMessage = {
  conversationId: string;
  clientMsgId: string;
  ciphertext: string;
  iv: string;
  keyVersion: number;
  senderKeyVersion: number;
  recipientKeyVersion: number;
  kind: 'text';
  replyToId?: string;
  peerPublicKey?: string;
  queuedAt?: string;
};

interface MessageKeyMetadata {
  senderId: string | null;
  senderKeyVersion?: number | null;
  recipientKeyVersion?: number | null;
  keyVersion: number | null;
}

interface DecryptedWithKeyVersions {
  plaintext: string;
  identity: DeviceIdentity;
  peerPublicKey: string;
}

function isOutboxMessage(value: unknown): value is OutboxMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<OutboxMessage>;
  return typeof item.conversationId === 'string' &&
    typeof item.clientMsgId === 'string' &&
    typeof item.ciphertext === 'string' &&
    typeof item.iv === 'string' &&
    typeof item.keyVersion === 'number' &&
    (item.senderKeyVersion === undefined || typeof item.senderKeyVersion === 'number') &&
    (item.recipientKeyVersion === undefined || typeof item.recipientKeyVersion === 'number') &&
    item.kind === 'text' &&
    (item.replyToId === undefined || typeof item.replyToId === 'string') &&
    (item.peerPublicKey === undefined || typeof item.peerPublicKey === 'string') &&
    (item.queuedAt === undefined || typeof item.queuedAt === 'string');
}

function readOutbox(storageKey: string): OutboxMessage[] {
  const stored = localStorage.getItem(storageKey);
  if (!stored) return [];
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed) || !parsed.every(isOutboxMessage)) {
    throw new Error('The encrypted outbox contains invalid data.');
  }
  return parsed;
}

function writeOutbox(storageKey: string, messages: OutboxMessage[]): void {
  localStorage.setItem(storageKey, JSON.stringify(messages));
}

function encodeBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer as ArrayBuffer;
}

function messageEventPayload(item: OutboxMessage) {
  return {
    conversationId: item.conversationId,
    clientMsgId: item.clientMsgId,
    ciphertext: item.ciphertext,
    iv: item.iv,
    keyVersion: item.keyVersion,
    senderKeyVersion: item.senderKeyVersion,
    recipientKeyVersion: item.recipientKeyVersion,
    kind: item.kind,
    ...(item.replyToId ? { replyToId: item.replyToId } : {}),
  };
}

async function toPendingThreadMessage(
  item: OutboxMessage,
  identity: DeviceIdentity,
  conversation: ConversationSummary,
  userId: string,
  isSending: boolean,
): Promise<ThreadMessage> {
  let plaintext = '';
  try {
    const cached = await getLocalMessage(item.clientMsgId);
    plaintext = cached?.plaintext ?? await decryptMessage(
        identity, conversation, item.ciphertext, item.iv, item.peerPublicKey,
      );
  } catch {
    plaintext = 'Setting up encryption';
  }
  return {
    id: item.clientMsgId,
    conversationId: item.conversationId,
    senderId: userId,
    clientMsgId: item.clientMsgId,
    seq: `pending-${item.clientMsgId}`,
    ciphertext: item.ciphertext,
    iv: item.iv,
    keyVersion: item.keyVersion,
    senderKeyVersion: item.senderKeyVersion,
    recipientKeyVersion: item.recipientKeyVersion,
    replyToId: item.replyToId ?? null,
    kind: item.kind,
    createdAt: item.queuedAt ?? new Date().toISOString(),
    editedAt: null,
    deletedAt: null,
    receipts: [],
    reactions: [],
    plaintext,
    decryptedReactions: [],
    sendState: isSending ? 'sending' : 'queued',
  };
}

export default function AuthenticatedHome({ user, onSignOut, busy, message }: AuthenticatedHomeProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversationPreviews, setConversationPreviews] = useState<Record<string, string>>({});
  const [conversationError, setConversationError] = useState('');
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [connection, setConnection] = useState<OrbitConnectionState>('offline');
  const [connectionError, setConnectionError] = useState('');
  const [dialog, setDialog] = useState<OrbitDialogKind>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [searchError, setSearchError] = useState('');
  const [searching, setSearching] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [threadMessages, setThreadMessages] = useState<ThreadMessage[]>([]);
  const [threadError, setThreadError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [deviceIdentity, setDeviceIdentity] = useState<DeviceIdentity | null>(null);
  const [outboxCount, setOutboxCount] = useState(0);
  const [outboxRevision, setOutboxRevision] = useState(0);
  const [fileShortcutPending, setFileShortcutPending] = useState(false);
  const [fileSending, setFileSending] = useState(false);
  const [fileProgress, setFileProgress] = useState<Record<string, FileTransferProgress>>({});
  const [receivedFiles, setReceivedFiles] = useState<Record<string, { name: string; blob: Blob; url: string }>>({});
  const receivedFilesRef = useRef(receivedFiles);
  receivedFilesRef.current = receivedFiles;
  const [blockedUsers, setBlockedUsers] = useState<UserSearchResult[]>([]);
  const [loadingBlocks, setLoadingBlocks] = useState(false);
  const messageListRef = useRef<HTMLElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const lastAutoScrollTokenRef = useRef('');
  const pendingScrollHeightRef = useRef<number | null>(null);
  const olderCursorRef = useRef<string | null>(null);
  const historyConversationRef = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const filePickerRef = useRef<HTMLInputElement | null>(null);
  const deliveredRef = useRef(new Set<string>());
  const flushingMessagesRef = useRef(new Set<string>());
  const attemptedMessagesRef = useRef(new Set<string>());
  const threadLoadIdRef = useRef(0);
  const peerPublicKeysRef = useRef(new Map<string, Promise<string>>());
  const fileTransfersRef = useRef(new Map<string, PeerFileTransfer>());
  const sourceFilesRef = useRef(new Map<string, File>());
  const sourceBuffersRef = useRef(new Map<string, ArrayBuffer>());
  const fileInfoRef = useRef(new Map<string, { size: number; mime: string; sha256: string; recipientKeyVersion: number }>());

  const loadConversations = useCallback(async () => {
    setLoadingConversations(true);
    setConversationError('');
    try {
      const response = await getConversations();
      setConversations(response.conversations);
      setSelectedId((current) => {
        const available = response.conversations.some(({ id }) => id === current);
        if (window.matchMedia('(max-width: 680px)').matches) return null;
        if (current && available) return current;
        let remembered: string | null = null;
        try {
          remembered = localStorage.getItem(`orbit-last-conversation:${user.id}`);
        } catch {
          remembered = null;
        }
        return response.conversations.find(({ id }) => id === remembered)?.id
          ?? response.conversations[0]?.id
          ?? null;
      });
    } catch (error) {
      setConversationError(error instanceof Error ? error.message : 'Could not load conversations.');
    } finally {
      setLoadingConversations(false);
    }
  }, [user.id]);

  function selectConversation(conversationId: string) {
    setSelectedId(conversationId);
    setConversations((current) => current.map((item) =>
      item.id === conversationId ? { ...item, unreadCount: 0 } : item,
    ));
  }

  useEffect(() => {
    if (!selectedId) return;
    try {
      localStorage.setItem(`orbit-last-conversation:${user.id}`, selectedId);
    } catch {
      setNotice('Conversation opened. This browser could not remember it for next time.');
    }
  }, [selectedId, user.id]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 680px)');
    const updateSelectionForViewport = () => {
      if (media.matches) {
        setSelectedId(null);
        return;
      }
      const availableConversations = conversationsRef.current;
      setSelectedId((current) => {
        if (current && availableConversations.some(({ id }) => id === current)) return current;
        let remembered: string | null = null;
        try {
          remembered = localStorage.getItem(`orbit-last-conversation:${user.id}`);
        } catch {
          remembered = null;
        }
        return availableConversations.find(({ id }) => id === remembered)?.id ?? availableConversations[0]?.id ?? null;
      });
    };
    media.addEventListener('change', updateSelectionForViewport);
    return () => media.removeEventListener('change', updateSelectionForViewport);
  }, [user.id]);

  useEffect(() => {
    void loadConversations();
    const stop = startOrbitSocket();
    const unsubscribe = subscribeOrbitConnection((state, error) => {
      setConnection(state);
      setConnectionError(error ?? '');
    });
    return () => {
      unsubscribe();
      stop();
    };
  }, [loadConversations]);

  useEffect(() => {
    if (dialog !== 'search' || query.trim().length < 3) {
      setResults([]);
      setSearchError('');
      setSearching(false);
      return;
    }

    let active = true;
    const timer = window.setTimeout(() => {
      setSearching(true);
      setSearchError('');
      setResults([]);
      void searchUsers(query.trim()).then((response) => {
        if (!Array.isArray(response.users)) {
          throw new Error('Orbit returned an invalid username search response.');
        }
        if (active) setResults(response.users.filter((person) => person.id !== user.id));
      }).catch((error: unknown) => {
        if (active) setSearchError(error instanceof Error ? error.message : 'Could not search users.');
      }).finally(() => {
        if (active) setSearching(false);
      });
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [dialog, query, user.id]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selected = conversations.find(({ id }) => id === selectedId) ?? null;
  const peerBlocked = Boolean(selected && blockedUsers.some(({ id }) => id === selected.peer.id));

  const peerPublicKeyForVersion = useCallback(async (
    conversation: ConversationSummary,
    keyVersion: number,
  ): Promise<string> => {
    if (keyVersion === conversation.peer.keyVersion) return conversation.peer.publicKey;
    const cacheKey = `${conversation.peer.id}:${keyVersion}`;
    let keyRequest = peerPublicKeysRef.current.get(cacheKey);
    if (!keyRequest) {
      keyRequest = getUserPublicKey(conversation.peer.id, keyVersion).then((response) => {
        if (response.keyVersion !== keyVersion) {
          throw new Error(`The contact's encryption key version ${keyVersion} is unavailable.`);
        }
        return response.publicKey;
      });
      peerPublicKeysRef.current.set(cacheKey, keyRequest);
      void keyRequest.catch(() => {
        if (peerPublicKeysRef.current.get(cacheKey) === keyRequest) {
          peerPublicKeysRef.current.delete(cacheKey);
        }
      });
    }
    return keyRequest;
  }, []);

  const decryptWithAvailableKeyVersions = useCallback(async (
    identity: DeviceIdentity,
    conversation: ConversationSummary,
    message: MessageKeyMetadata,
    ciphertext: string,
    iv: string,
  ): Promise<DecryptedWithKeyVersions> => {
    const sentByCurrentUser = message.senderId === user.id;
    const localVersions = [...new Set([
      sentByCurrentUser ? message.senderKeyVersion : message.recipientKeyVersion,
      message.keyVersion,
      identity.keyVersion,
      user.keyVersion,
    ].filter((version): version is number => Number.isSafeInteger(version) && (version ?? 0) > 0))];
    const peerVersions = [...new Set([
      sentByCurrentUser ? message.recipientKeyVersion : message.senderKeyVersion,
      message.keyVersion,
      conversation.peer.keyVersion,
    ].filter((version): version is number => Number.isSafeInteger(version) && (version ?? 0) > 0))];

    const identities = [identity];
    for (const version of localVersions) {
      const historical = await getDeviceIdentityForVersion(user.id, version);
      if (historical && !identities.some(({ fingerprint }) => fingerprint === historical.fingerprint)) {
        identities.push(historical);
      }
    }
    for (const savedIdentity of await getSavedDeviceIdentities(user.id)) {
      if (!identities.some(({ fingerprint }) => fingerprint === savedIdentity.fingerprint)) {
        identities.push(savedIdentity);
      }
    }

    let lastFailure: unknown;
    for (const localIdentity of identities) {
      for (const version of peerVersions) {
        let publicKey: string;
        try {
          publicKey = await peerPublicKeyForVersion(conversation, version);
        } catch (error) {
          lastFailure = error;
          continue;
        }
        try {
          return {
            plaintext: await decryptMessage(localIdentity, conversation, ciphertext, iv, publicKey),
            identity: localIdentity,
            peerPublicKey: publicKey,
          };
        } catch (error) {
          lastFailure = error;
        }
      }
    }
    const localVersionsLabel = localVersions.join(', ') || 'unknown';
    const peerVersionsLabel = peerVersions.join(', ') || 'unknown';
    const detail = lastFailure instanceof Error ? ` ${lastFailure.message}` : '';
    throw new Error(
      `No saved key pair could open this message (your key version ${localVersionsLabel}; contact key version ${peerVersionsLabel}).${detail}`,
    );
  }, [peerPublicKeyForVersion, user.id, user.keyVersion]);

  useEffect(() => {
    if (!deviceIdentity) return;
    let active = true;
    void Promise.all(conversations.map(async (conversation) => {
      const message = conversation.lastMessage;
      if (!message) return [conversation.id, 'No messages yet'] as const;
      if (message.kind === 'file') return [conversation.id, 'File shared'] as const;
      try {
        const decrypted = await decryptWithAvailableKeyVersions(
          deviceIdentity,
          conversation,
          message,
          message.ciphertext,
          message.iv,
        );
        return [conversation.id, decrypted.plaintext] as const;
      } catch {
        return [conversation.id, 'Encrypted message · key unavailable'] as const;
      }
    })).then((entries) => {
      if (active) setConversationPreviews(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
  }, [conversations, decryptWithAvailableKeyVersions, deviceIdentity, user.id]);

  useEffect(() => {
    let active = true;
    void getDeviceIdentity(user.id).then((identity) => {
      if (active) setDeviceIdentity(identity);
    }).catch((error: unknown) => {
      if (active) setThreadError(error instanceof Error ? error.message : 'Could not load the local encryption key.');
    });
    return () => {
      active = false;
    };
  }, [user.id]);

  useEffect(() => {
    if (dialog === 'settings') void refreshBlockedUsers();
  }, [dialog]);

  useEffect(() => () => {
    for (const transfer of fileTransfersRef.current.values()) transfer.close();
    for (const file of Object.values(receivedFilesRef.current)) URL.revokeObjectURL(file.url);
  }, []);

  const decryptMessagePage = useCallback(async (
    messages: EncryptedMessage[],
    conversation: ConversationSummary,
    identity: DeviceIdentity,
  ): Promise<Array<{ message: ThreadMessage; textDecrypted: boolean }>> => Promise.all(messages.map(async (item) => {
    let plaintext = item.deletedAt ? 'Message deleted' : 'Unable to decrypt this message.';
    let decryptionError: string | undefined;
    let peerPublicKey = '';
    let decryptionIdentity = identity;
    if (!item.deletedAt && item.ciphertext && item.iv) {
      try {
        const decrypted = await decryptWithAvailableKeyVersions(
          identity,
          conversation,
          item,
          item.ciphertext,
          item.iv,
        );
        plaintext = decrypted.plaintext;
        decryptionIdentity = decrypted.identity;
        peerPublicKey = decrypted.peerPublicKey;
      } catch (error) {
        const cached = item.kind === 'text' && item.senderId === user.id
          ? await getLocalMessage(item.clientMsgId)
          : null;
        if (cached) {
          plaintext = cached.plaintext;
        } else {
          decryptionError = error instanceof Error
            ? error.message
            : 'The matching private key is not available on this device.';
        }
      }
    }

    const decryptedReactions = await Promise.all(item.reactions.map(async (reaction) => {
      if (!peerPublicKey) return null;
      try {
        return {
          userId: reaction.userId,
          value: await decryptMessage(
            decryptionIdentity,
            conversation,
            reaction.reactionEnc,
            reaction.iv,
            peerPublicKey,
          ),
        };
      } catch {
        return null;
      }
    }));

    let decryptedFileName: string | undefined;
    if (item.kind === 'file' && item.file && peerPublicKey) {
      try {
        const key = await derivePeerKey(
          decryptionIdentity,
          conversation.id,
          peerPublicKey,
          'orbit-file-name-v1',
        );
        const name = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: decodeBase64(item.file.nameIv) },
          key,
          decodeBase64(item.file.nameEnc),
        );
        decryptedFileName = new TextDecoder().decode(name);
      } catch {
        decryptedFileName = 'Encrypted file';
      }
    }

    return {
      message: {
        ...item,
        plaintext,
        ...(decryptionError ? { decryptionError } : {}),
        decryptedReactions: decryptedReactions.filter((reaction) => reaction !== null),
        decryptedFileName,
      },
      textDecrypted: Boolean(!item.deletedAt && item.ciphertext && item.iv && !decryptionError),
    };
  })), [decryptWithAvailableKeyVersions, user.id]);

  const refreshThread = useCallback(async () => {
    const conversation = conversationsRef.current.find(({ id }) => id === selectedId);
    if (!conversation || !deviceIdentity) return;
    const loadId = ++threadLoadIdRef.current;
    try {
      const storageKey = `orbit-outbox:${user.id}`;
      const outbox = readOutbox(storageKey);
      setOutboxCount(outbox.length);
      const pending = await Promise.all(outbox
        .filter((item) => item.conversationId === conversation.id)
        .map((item) => toPendingThreadMessage(
          item,
          deviceIdentity,
          conversation,
          user.id,
          flushingMessagesRef.current.has(item.clientMsgId),
        )));
      if (loadId !== threadLoadIdRef.current) return;
      setThreadMessages((current) => {
        const existingMessages = current.filter((item) =>
          item.conversationId === conversation.id && !item.sendState,
        );
        return [
          ...existingMessages,
          ...pending,
        ];
      });

      const response = await getMessages(conversation.id);
      if (historyConversationRef.current !== conversation.id) return;
      for (const item of response.messages) {
        if (
          item.senderId === user.id &&
          item.kind === 'file' &&
          item.file &&
          ['received', 'declined', 'cancelled', 'failed', 'expired'].includes(item.file.status)
        ) {
          sourceFilesRef.current.delete(item.file.fileId);
          sourceBuffersRef.current.delete(item.file.fileId);
          fileInfoRef.current.delete(item.file.fileId);
        }
      }
      const persistedIds = new Set(response.messages.map((item) => item.clientMsgId));
      const confirmedOutboxIds = outbox
        .filter((item) => item.conversationId === conversation.id && persistedIds.has(item.clientMsgId))
        .map((item) => item.clientMsgId);
      const remainingOutbox = outbox.filter((item) =>
        item.conversationId !== conversation.id || !persistedIds.has(item.clientMsgId),
      );
      if (remainingOutbox.length !== outbox.length) writeOutbox(storageKey, remainingOutbox);
      setOutboxCount(remainingOutbox.length);
      const decryptedResults = await decryptMessagePage(response.messages, conversation, deviceIdentity);
      if (loadId !== threadLoadIdRef.current || historyConversationRef.current !== conversation.id) return;
      const decrypted = decryptedResults.map(({ message }) => message);
      await Promise.all(decryptedResults
        .filter(({ message, textDecrypted }) =>
          textDecrypted && message.senderId === user.id && confirmedOutboxIds.includes(message.clientMsgId),
        )
        .map(({ message }) => removeLocalMessage(message.clientMsgId)));
      olderCursorRef.current ??= response.nextCursor;
      setHasOlderMessages(Boolean(olderCursorRef.current));
      setThreadMessages((current) => {
        const oldestFreshSeq = response.messages[0]?.seq;
        const retainedOlder = oldestFreshSeq
          ? current.filter((item) => !item.sendState && /^\d+$/.test(item.seq) && BigInt(item.seq) < BigInt(oldestFreshSeq))
          : [];
        const merged = new Map<string, ThreadMessage>();
        for (const item of retainedOlder) merged.set(item.id, item);
        for (const item of decrypted) merged.set(item.id, item);
        for (const item of pending.filter((message) => !persistedIds.has(message.clientMsgId)).map((item) => ({
          ...item,
          sendState: flushingMessagesRef.current.has(item.clientMsgId)
            ? 'sending' as const
            : item.sendState,
        }))) merged.set(item.id, item);
        return [...merged.values()].sort((left, right) => {
          if (left.sendState && right.sendState) return left.createdAt.localeCompare(right.createdAt);
          if (left.sendState) return 1;
          if (right.sendState) return -1;
          return BigInt(left.seq) < BigInt(right.seq) ? -1 : BigInt(left.seq) > BigInt(right.seq) ? 1 : 0;
        });
      });
      setThreadError('');

      const unread = response.messages.filter((item) =>
        item.senderId !== user.id &&
        !item.deletedAt &&
        !deliveredRef.current.has(item.id) &&
        !item.receipts.some((receipt) => receipt.userId === user.id && receipt.status === 'read'),
      );
      for (const item of unread) {
        deliveredRef.current.add(item.id);
        void addMessageReceipt(conversation.id, item.id, 'delivered').catch(() => deliveredRef.current.delete(item.id));
        void addMessageReceipt(conversation.id, item.id, 'read').catch(() => undefined);
      }
    } catch (error) {
      if (loadId === threadLoadIdRef.current) {
        setThreadError(error instanceof Error ? error.message : 'Could not load this conversation.');
      }
    }
  }, [decryptMessagePage, deviceIdentity, selectedId, user.id]);

  const loadOlderMessages = useCallback(async () => {
    const conversationId = selectedId;
    const cursor = olderCursorRef.current;
    const list = messageListRef.current;
    if (!conversationId || !cursor || !list || loadingOlderRef.current || !deviceIdentity) return;
    const conversation = conversationsRef.current.find(({ id }) => id === conversationId);
    if (!conversation) return;
    loadingOlderRef.current = true;
    setLoadingOlderMessages(true);
    const previousHeight = list.scrollHeight;
    try {
      const response = await getMessages(conversationId, cursor);
      const decrypted = await decryptMessagePage(response.messages, conversation, deviceIdentity);
      if (historyConversationRef.current !== conversationId) return;
      pendingScrollHeightRef.current = previousHeight;
      olderCursorRef.current = response.nextCursor;
      setHasOlderMessages(Boolean(response.nextCursor));
      setThreadMessages((current) => {
        const messages = new Map(current.map((item) => [item.id, item]));
        for (const { message } of decrypted) messages.set(message.id, message);
        return [...messages.values()].sort((left, right) => {
          if (left.sendState && right.sendState) return left.createdAt.localeCompare(right.createdAt);
          if (left.sendState) return 1;
          if (right.sendState) return -1;
          return BigInt(left.seq) < BigInt(right.seq) ? -1 : BigInt(left.seq) > BigInt(right.seq) ? 1 : 0;
        });
      });
    } catch (error) {
      if (historyConversationRef.current === conversationId) {
        setThreadError(error instanceof Error ? error.message : 'Could not load earlier messages.');
      }
    } finally {
      loadingOlderRef.current = false;
      if (historyConversationRef.current === conversationId) setLoadingOlderMessages(false);
    }
  }, [decryptMessagePage, deviceIdentity, selectedId]);

  useEffect(() => {
    setThreadMessages([]);
    setThreadError('');
    deliveredRef.current.clear();
    olderCursorRef.current = null;
    historyConversationRef.current = selectedId;
    loadingOlderRef.current = false;
    setHasOlderMessages(false);
    setLoadingOlderMessages(false);
    shouldAutoScrollRef.current = true;
    lastAutoScrollTokenRef.current = '';
    if (!selectedId) return;
    void refreshThread();
    const interval = window.setInterval(() => void refreshThread(), 4000);
    return () => window.clearInterval(interval);
  }, [refreshThread, selectedId]);

  useLayoutEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    const previousHeight = pendingScrollHeightRef.current;
    if (previousHeight !== null) {
      list.scrollTop += list.scrollHeight - previousHeight;
      pendingScrollHeightRef.current = null;
      return;
    }
    const latestMessage = threadMessages[threadMessages.length - 1];
    if (!latestMessage || !shouldAutoScrollRef.current) return;
    const token = `${selectedId}:${latestMessage.id}`;
    if (token === lastAutoScrollTokenRef.current) return;
    list.scrollTop = list.scrollHeight;
    lastAutoScrollTokenRef.current = token;
  }, [selectedId, threadMessages]);

  useEffect(() => {
    const unsubscribe = subscribeOrbitEvents((envelope) => {
      if (envelope.event === 'message.new' || envelope.event === 'message.created') {
        const event = envelope.data as { payload?: EncryptedMessage };
        const newMessage = event.payload;
        if (newMessage) {
          setConversations((current) => {
            const next = current.map((conversation) => conversation.id === newMessage.conversationId
              ? {
                  ...conversation,
                  lastMessage: newMessage.ciphertext && newMessage.iv &&
                    (!conversation.lastMessage ||
                      new Date(newMessage.createdAt).getTime() >=
                        new Date(conversation.lastMessage.createdAt ?? 0).getTime())
                    ? {
                        id: newMessage.id,
                        senderId: newMessage.senderId,
                        clientMsgId: newMessage.clientMsgId,
                        seq: newMessage.seq,
                        ciphertext: newMessage.ciphertext,
                        iv: newMessage.iv,
                        keyVersion: newMessage.keyVersion,
                        senderKeyVersion: newMessage.senderKeyVersion,
                        recipientKeyVersion: newMessage.recipientKeyVersion,
                        kind: newMessage.kind,
                        createdAt: newMessage.createdAt,
                      }
                    : conversation.lastMessage,
                  unreadCount: newMessage.senderId === user.id ||
                    newMessage.conversationId === selectedId ||
                    conversation.lastMessage?.id === newMessage.id ||
                    conversation.lastMessage?.clientMsgId === newMessage.clientMsgId
                    ? conversation.unreadCount
                    : conversation.unreadCount + 1,
                }
              : conversation);
            return [...next].sort((a, b) =>
              new Date(b.lastMessage?.createdAt ?? 0).getTime() -
              new Date(a.lastMessage?.createdAt ?? 0).getTime(),
            );
          });
          if (newMessage.conversationId === selectedId) void refreshThread();
        }
      }
      if (envelope.event === 'message.edited' || envelope.event === 'message.deleted') {
        void refreshThread();
      }
      if (envelope.event === 'file.offered' || envelope.event === 'file.status') {
        void refreshThread();
      }
      if (envelope.event === 'file.peer.signal') {
        const event = envelope.data as {
          payload?: { conversationId?: string; signal?: PeerFileSignal };
        };
        if (event.payload?.conversationId && event.payload.signal) {
          void handleFileSignal(event.payload.conversationId, event.payload.signal);
        }
      }
      if (envelope.event === 'receipt.updated') {
        const event = envelope.data as { payload?: { messageId: string; userId: string; status: 'delivered' | 'read'; at?: string } };
        const receipt = event.payload;
        if (!receipt) return;
        setThreadMessages((current) => current.map((item) => item.id === receipt.messageId
          ? { ...item, receipts: [...item.receipts.filter((entry) => !(entry.userId === receipt.userId && entry.status === receipt.status)), { ...receipt, at: receipt.at ?? new Date().toISOString() }] }
          : item));
      }
    });
    return unsubscribe;
  }, [deviceIdentity, peerPublicKeyForVersion, refreshThread, selectedId, user.id]);

  useEffect(() => {
    if (connection !== 'connected') attemptedMessagesRef.current.clear();
  }, [connection]);

  useEffect(() => {
    if (connection !== 'connected' || !selected) return;
    void refreshThread();
    const storageKey = `orbit-outbox:${user.id}`;
    try {
      const queue = readOutbox(storageKey);
      setOutboxCount(queue.length);
      const selectedQueue = queue.filter((item) => item.conversationId === selected.id);
      const next = selectedQueue.map((item) => ({
        ...item,
        senderKeyVersion: item.senderKeyVersion ?? item.keyVersion,
        recipientKeyVersion: item.recipientKeyVersion ?? selected.peer.keyVersion,
      }));
      if (next.some((item, index) =>
        item.senderKeyVersion !== selectedQueue[index].senderKeyVersion ||
        item.recipientKeyVersion !== selectedQueue[index].recipientKeyVersion
      )) {
        const updates = new Map(next.map((item) => [item.clientMsgId, item]));
        writeOutbox(storageKey, queue.map((item) => updates.get(item.clientMsgId) ?? item));
      }
      for (const item of next) {
        if (
          flushingMessagesRef.current.has(item.clientMsgId) ||
          attemptedMessagesRef.current.has(item.clientMsgId)
        ) continue;
        flushingMessagesRef.current.add(item.clientMsgId);
        attemptedMessagesRef.current.add(item.clientMsgId);
        if (import.meta.env.DEV) {
          console.debug('[Orbit WS] sending message.send', {
            clientMsgId: item.clientMsgId,
            hasConversationId: Boolean(item.conversationId),
            hasCiphertext: Boolean(item.ciphertext),
            hasIv: Boolean(item.iv),
            hasSenderKeyVersion: Number.isInteger(item.senderKeyVersion),
            hasRecipientKeyVersion: Number.isInteger(item.recipientKeyVersion),
          });
        }
        void requestOrbitEvent('message.send', messageEventPayload(item), item.clientMsgId)
          .then(() => {
            setThreadMessages((current) => current.map((message) =>
              message.clientMsgId === item.clientMsgId
                ? { ...message, sendState: 'sent', sendError: undefined }
                : message,
            ));
            void refreshThread();
          })
          .catch((error: unknown) => {
            setThreadMessages((current) => current.map((message) =>
              message.clientMsgId === item.clientMsgId
                ? {
                    ...message,
                    sendState: 'failed',
                    sendError: error instanceof Error ? error.message : 'Could not send this message.',
                  }
                : message,
            ));
          })
          .finally(() => flushingMessagesRef.current.delete(item.clientMsgId));
      }
    } catch {
      setThreadError('The encrypted outbox could not be read from this browser.');
    }
  }, [connection, outboxRevision, refreshThread, selected, user.id, user.keyVersion]);

  function retryQueuedMessage(clientMsgId: string) {
    attemptedMessagesRef.current.delete(clientMsgId);
    setThreadMessages((current) => current.map((item) =>
      item.clientMsgId === clientMsgId
        ? { ...item, sendState: 'queued', sendError: undefined }
        : item,
    ));
    setOutboxRevision((revision) => revision + 1);
  }

  function retryAllQueuedMessages() {
    try {
      const queue = readOutbox(`orbit-outbox:${user.id}`);
      for (const item of queue) attemptedMessagesRef.current.delete(item.clientMsgId);
      setThreadMessages((current) => current.map((item) =>
        item.sendState === 'failed'
          ? { ...item, sendState: 'queued', sendError: undefined }
          : item,
      ));
      setOutboxRevision((revision) => revision + 1);
    } catch {
      setThreadError('The saved messages could not be read. Refresh the page and try again.');
    }
  }

  async function sendTextMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const plaintext = draft.trim();
    if (!plaintext || !selected || !deviceIdentity || sending || peerBlocked) return;
    setSending(true);
    setThreadError('');
    try {
      const encrypted = await encryptMessage(deviceIdentity, selected, plaintext);
      const clientMsgId = crypto.randomUUID();
      const queued: OutboxMessage = {
        conversationId: selected.id,
        clientMsgId,
        ...encrypted,
        keyVersion: user.keyVersion,
        senderKeyVersion: user.keyVersion,
        recipientKeyVersion: selected.peer.keyVersion,
        kind: 'text',
        peerPublicKey: selected.peer.publicKey,
        queuedAt: new Date().toISOString(),
        ...(replyTo ? { replyToId: replyTo } : {}),
      };
      const createdAt = new Date().toISOString();
      await saveLocalMessage({ clientMsgId, conversationId: selected.id, plaintext, createdAt });
      const storageKey = `orbit-outbox:${user.id}`;
      const outbox = readOutbox(storageKey);
      if (!outbox.some((item) => item.clientMsgId === clientMsgId)) outbox.push(queued);
      writeOutbox(storageKey, outbox);
      setOutboxCount(outbox.length);
      setOutboxRevision((revision) => revision + 1);
      setDraft('');
      setReplyTo(null);
      shouldAutoScrollRef.current = true;
      setThreadMessages((current) => [...current, {
        id: clientMsgId,
        conversationId: selected.id,
        senderId: user.id,
        clientMsgId,
        seq: `pending-${Date.now()}`,
        ciphertext: queued.ciphertext,
        iv: queued.iv,
        keyVersion: queued.keyVersion,
        replyToId: queued.replyToId ?? null,
        kind: 'text',
        createdAt,
        editedAt: null,
        deletedAt: null,
        senderKeyVersion: queued.senderKeyVersion,
        recipientKeyVersion: queued.recipientKeyVersion,
        receipts: [],
        reactions: [],
        plaintext,
        decryptedReactions: [],
        sendState: connection === 'connected' ? 'sending' : 'queued',
      }]);
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : 'Could not send this encrypted message.');
    } finally {
      setSending(false);
    }
  }

  async function editTextMessage(item: ThreadMessage) {
    if (!selected || !deviceIdentity || !editDraft.trim()) return;
    try {
      const encrypted = await encryptMessage(deviceIdentity, selected, editDraft.trim());
      await editMessage(selected.id, item.id, { ...encrypted, keyVersion: user.keyVersion });
      setEditingId(null);
      setEditDraft('');
      void refreshThread();
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : 'Could not edit this message.');
    }
  }

  async function removeTextMessage(item: ThreadMessage) {
    if (!selected || !window.confirm('Delete this message for everyone?')) return;
    try {
      await deleteMessage(selected.id, item.id);
      void refreshThread();
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : 'Could not delete this message.');
    }
  }

  async function reactToMessage(item: ThreadMessage, reaction: string) {
    if (!selected || !deviceIdentity) return;
    try {
      const alreadyReacted = item.decryptedReactions.some(
        (entry) => entry.userId === user.id && entry.value === reaction,
      );
      if (alreadyReacted) {
        await removeMessageReaction(selected.id, item.id);
      } else {
        const encrypted = await encryptMessage(deviceIdentity, selected, reaction);
        await setMessageReaction(selected.id, item.id, {
          reactionEnc: encrypted.ciphertext,
          iv: encrypted.iv,
        });
      }
      void refreshThread();
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : 'Could not save the reaction.');
    }
  }

  function relayFileSignal(conversationId: string, signal: PeerFileSignal) {
    sendOrbitEvent('file.peer.signal', { conversationId, signal });
  }

  function createFileTransfer(
    conversationId: string,
    fileId: string,
    size: number,
    mime: string,
    sha256: string,
    name: string,
    key: CryptoKey,
  ): PeerFileTransfer {
    const transfer = new PeerFileTransfer({
      fileId,
      key,
      size,
      mime,
      sha256,
      onSignal: (signal) => {
        try {
          relayFileSignal(conversationId, signal);
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Could not signal the peer.';
          setFileProgress((current) => ({ ...current, [fileId]: { transferred: 0, total: size, error: reason } }));
        }
      },
      onProgress: (transferred, total) => {
        setFileProgress((current) => ({ ...current, [fileId]: { transferred, total } }));
      },
      onComplete: (blob) => {
        const url = URL.createObjectURL(blob);
        setFileProgress((current) => ({
          ...current,
          [fileId]: { transferred: size, total: size, verified: true },
        }));
        setReceivedFiles((current) => {
          const previous = current[fileId];
          if (previous) URL.revokeObjectURL(previous.url);
          return { ...current, [fileId]: { name, blob, url } };
        });
        void updateFileStatus(conversationId, fileId, 'received').catch((error: unknown) => {
          setThreadError(error instanceof Error ? error.message : 'The file arrived, but its status could not be updated.');
        });
        setNotice('File received and verified. It is only stored in this browser.');
      },
      onError: (error) => {
        setFileProgress((current) => ({
          ...current,
          [fileId]: {
            transferred: current[fileId]?.transferred ?? 0,
            total: size,
            error: error.message,
          },
        }));
        void updateFileStatus(conversationId, fileId, 'failed').catch((statusError: unknown) => {
          setThreadError(statusError instanceof Error ? statusError.message : error.message);
        });
      },
    });
    fileTransfersRef.current.set(fileId, transfer);
    return transfer;
  }

  async function offerFile(file: File) {
    if (!selected || !deviceIdentity || fileSending || peerBlocked) return;
    setFileSending(true);
    setThreadError('');
    try {
      const content = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', content);
      const sha256 = encodeBase64(digest);
      const fileId = crypto.randomUUID();
      const clientMsgId = crypto.randomUUID();
      const encryptedMessage = await encryptMessage(deviceIdentity, selected, 'Shared a file');
      const nameKey = await derivePeerKey(
        deviceIdentity,
        selected.id,
        selected.peer.publicKey,
        'orbit-file-name-v1',
      );
      const nameIv = crypto.getRandomValues(new Uint8Array(12));
      const nameEnc = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nameIv },
        nameKey,
        new TextEncoder().encode(file.name),
      );
      await createFileOffer(selected.id, {
        fileId,
        clientMsgId,
        ...encryptedMessage,
        keyVersion: user.keyVersion,
        senderKeyVersion: user.keyVersion,
        recipientKeyVersion: selected.peer.keyVersion,
        nameEnc: encodeBase64(nameEnc),
        nameIv: encodeBase64(nameIv.buffer),
        size: String(file.size),
        mime: file.type || 'application/octet-stream',
        sha256,
      });
      sourceFilesRef.current.set(fileId, file);
      sourceBuffersRef.current.set(fileId, content);
      fileInfoRef.current.set(fileId, {
        size: file.size,
        mime: file.type || 'application/octet-stream',
        sha256,
        recipientKeyVersion: selected.peer.keyVersion,
      });
      const url = URL.createObjectURL(file);
      setReceivedFiles((current) => ({ ...current, [fileId]: { name: file.name, blob: file, url } }));
      setNotice('Encrypted file offer sent. The file itself stays on your device until a direct transfer starts.');
      await refreshThread();
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : 'Could not create the encrypted file offer.');
    } finally {
      setFileSending(false);
    }
  }

  async function acceptFile(item: ThreadMessage) {
    if (!selected || !deviceIdentity || !item.file || item.file.status !== 'offered') return;
    const size = Number(item.file.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      setThreadError('This file offer has an invalid size.');
      return;
    }
    try {
      const peerPublicKey = await peerPublicKeyForVersion(
        selected,
        item.senderKeyVersion || selected.peer.keyVersion,
      );
      const key = await derivePeerKey(deviceIdentity, selected.id, peerPublicKey, 'orbit-file-content-v1');
      const name = item.decryptedFileName ?? 'Shared file';
      fileInfoRef.current.set(item.file.fileId, {
        size,
        mime: item.file.mime,
        sha256: item.file.sha256,
        recipientKeyVersion: user.keyVersion,
      });
      createFileTransfer(
        selected.id,
        item.file.fileId,
        size,
        item.file.mime,
        item.file.sha256,
        name,
        key,
      );
      await updateFileStatus(selected.id, item.file.fileId, 'accepted');
      relayFileSignal(selected.id, { type: 'accept', fileId: item.file.fileId });
      void refreshThread();
      setNotice('File accepted. Establishing a direct encrypted connection…');
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : 'Could not accept this file offer.');
    }
  }

  async function declineFile(item: ThreadMessage) {
    if (!selected || !item.file) return;
    try {
      await updateFileStatus(selected.id, item.file.fileId, 'declined');
      void refreshThread();
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : 'Could not decline this file offer.');
    }
  }

  async function cancelFile(item: ThreadMessage) {
    if (!selected || !item.file) return;
    try {
      relayFileSignal(selected.id, { type: 'cancel', fileId: item.file.fileId });
      await updateFileStatus(selected.id, item.file.fileId, 'cancelled');
      fileTransfersRef.current.get(item.file.fileId)?.close();
      fileTransfersRef.current.delete(item.file.fileId);
      sourceFilesRef.current.delete(item.file.fileId);
      sourceBuffersRef.current.delete(item.file.fileId);
      fileInfoRef.current.delete(item.file.fileId);
      void refreshThread();
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : 'Could not cancel this file transfer.');
    }
  }

  async function refreshBlockedUsers() {
    setLoadingBlocks(true);
    try {
      const response = await listBlocks();
      setBlockedUsers(response.blocks);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not load blocked contacts.');
    } finally {
      setLoadingBlocks(false);
    }
  }

  async function blockSelectedUser() {
    if (!selected) return;
    try {
      await blockUser(selected.peer.id);
      setBlockedUsers((current) => current.some(({ id }) => id === selected.peer.id)
        ? current
        : [...current, {
            id: selected.peer.id,
            username: selected.peer.username,
            displayName: selected.peer.displayName,
          }]);
      setNotice(`@${selected.peer.username} is blocked.`);
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : 'Could not block this contact.');
    }
  }

  async function unblockContact(userId: string) {
    try {
      await unblockUser(userId);
      setBlockedUsers((current) => current.filter(({ id }) => id !== userId));
      setNotice('Contact unblocked.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not unblock this contact.');
    }
  }

  async function handleFileSignal(conversationId: string, signal: PeerFileSignal) {
    if (signal.type === 'accept') {
      const file = sourceFilesRef.current.get(signal.fileId);
      const source = sourceBuffersRef.current.get(signal.fileId);
      const info = fileInfoRef.current.get(signal.fileId);
      const conversation = conversationsRef.current.find(({ id }) => id === conversationId);
      if (!file || !source || !info || !conversation || !deviceIdentity) {
        setFileProgress((current) => ({
          ...current,
          [signal.fileId]: { transferred: 0, total: info?.size ?? 0, error: 'The original file is no longer available in this browser.' },
        }));
        return;
      }
      try {
        const key = await derivePeerKey(
          deviceIdentity,
          conversation.id,
          await peerPublicKeyForVersion(conversation, info.recipientKeyVersion),
          'orbit-file-content-v1',
        );
        const transfer = createFileTransfer(
          conversationId,
          signal.fileId,
          info.size,
          info.mime,
          info.sha256,
          file.name,
          key,
        );
        await updateFileStatus(conversationId, signal.fileId, 'transferring');
        await transfer.startSender(source);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Could not start the direct file transfer.';
        setFileProgress((current) => ({
          ...current,
          [signal.fileId]: { transferred: current[signal.fileId]?.transferred ?? 0, total: info?.size ?? 0, error: reason },
        }));
      }
      return;
    }
    const transfer = fileTransfersRef.current.get(signal.fileId);
    if (!transfer) return;
    try {
      if (signal.type === 'offer') await transfer.acceptOffer(signal.sdp);
      else await transfer.handleSignal(signal);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The direct file connection failed.';
      setFileProgress((current) => ({
        ...current,
        [signal.fileId]: { transferred: current[signal.fileId]?.transferred ?? 0, total: current[signal.fileId]?.total ?? 0, error: reason },
      }));
    }
  }

  async function copyFingerprint(fingerprint: string) {
    try {
      await navigator.clipboard.writeText(fingerprint);
      setNotice('Fingerprint copied.');
      setActionError('');
    } catch {
      setActionError('Clipboard access was denied. Select and copy the fingerprint manually.');
    }
  }

  async function openConversation(person: UserSearchResult) {
    setActionError('');
    try {
      const { conversation } = await createConversation(person.id);
      await loadConversations();
      selectConversation(conversation.id);
      setDialog(null);
      setQuery('');
      if (fileShortcutPending) {
        setFileShortcutPending(false);
        window.requestAnimationFrame(() => filePickerRef.current?.click());
      }
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : 'Could not start this conversation.');
    }
  }

  return <main className={`home-screen orbit-shell${selected ? ' has-selected-conversation' : ''}${conversations.length ? ' has-conversations' : ''}`}>
    <ConversationSidebar
      user={user}
      busy={busy}
      conversations={conversations}
      selectedId={selectedId}
      previews={conversationPreviews}
      loading={loadingConversations}
      error={conversationError}
      connection={connection}
      connectionError={connectionError}
      onSelect={selectConversation}
      onRetryConversations={() => void loadConversations()}
      onRetryConnection={retryOrbitSocket}
      onFindSomeone={() => setDialog('search')}
      onSendFile={() => {
        if (selected) {
          filePickerRef.current?.click();
        } else {
          setFileShortcutPending(true);
          setQuery('');
          setDialog('search');
        }
      }}
      onCopyFingerprint={() => void copyFingerprint(user.fingerprint)}
      onOpenSettings={() => setDialog('settings')}
      onSignOut={onSignOut}
    />

    <section className="orbit-main" aria-label={selected ? `Conversation with ${selected.peer.displayName}` : 'No conversations'}>
      {!selected && conversations.length === 0 && !loadingConversations && <EmptyConversationState onFindSomeone={() => setDialog('search')} />}

      {selected && <ConversationThread
        conversation={selected}
        user={user}
        connection={connection}
        deviceIdentityAvailable={Boolean(deviceIdentity)}
        peerBlocked={peerBlocked}
        fileSending={fileSending}
        filePickerRef={filePickerRef}
        threadMessages={threadMessages}
        threadError={threadError}
        receivedFiles={receivedFiles}
        fileProgress={fileProgress}
        editingId={editingId}
        editDraft={editDraft}
        replyTo={replyTo}
        draft={draft}
        sending={sending}
        outboxCount={outboxCount}
        messageListRef={messageListRef}
        hasOlderMessages={hasOlderMessages}
        loadingOlderMessages={loadingOlderMessages}
        onBack={() => setSelectedId(null)}
        onBlock={() => void blockSelectedUser()}
        onUnblock={() => void unblockContact(selected.peer.id)}
        onRetryThread={() => void refreshThread()}
        onMessageListScroll={(nearBottom) => { shouldAutoScrollRef.current = nearBottom; }}
        onLoadOlderMessages={() => void loadOlderMessages()}
        onAcceptFile={(item) => void acceptFile(item)}
        onDeclineFile={(item) => void declineFile(item)}
        onCancelFile={(item) => void cancelFile(item)}
        onEditDraftChange={setEditDraft}
        onEditTextMessage={(item) => void editTextMessage(item)}
        onCancelEdit={() => setEditingId(null)}
        onRetryQueuedMessage={retryQueuedMessage}
        onDeleteTextMessage={(item) => void removeTextMessage(item)}
        onStartEdit={(item) => { setEditingId(item.id); setEditDraft(item.plaintext); }}
        onReply={setReplyTo}
        onReact={(item, reaction) => void reactToMessage(item, reaction)}
        onOfferFile={(file) => void offerFile(file)}
        onReplyChange={setReplyTo}
        onDraftChange={setDraft}
        onRetryAllQueued={retryAllQueuedMessages}
        onSendMessage={(event) => void sendTextMessage(event)}
      />}
      {message && <p className="form-message home-message" role="alert">{message}</p>}
      {actionError && <p className="orbit-action-error" role="alert">{actionError}</p>}
    </section>

    {notice && <div className="orbit-toast" role="status">{notice}</div>}

    <OrbitDialogs
      dialog={dialog}
      user={user}
      busy={busy}
      connection={connection}
      fileShortcutPending={fileShortcutPending}
      query={query}
      results={results}
      searching={searching}
      searchError={searchError}
      loadingBlocks={loadingBlocks}
      blockedUsers={blockedUsers}
      onQueryChange={setQuery}
      onOpenConversation={(person) => void openConversation(person)}
      onClose={() => setDialog(null)}
      onCopyFingerprint={() => void copyFingerprint(user.fingerprint)}
      onRefreshBlocks={() => void refreshBlockedUsers()}
      onUnblock={(id) => void unblockContact(id)}
      onSignOut={onSignOut}
    />
  </main>;
}
