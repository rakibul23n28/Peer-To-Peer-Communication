import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  addMessageReceipt,
  createConversation,
  deleteMessage,
  editMessage,
  getMessages,
  getConversations,
  searchUsers,
  setMessageReaction,
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
import { decryptMessage, encryptMessage } from './messageCrypto';
import { getDeviceIdentity, type DeviceIdentity } from './keyStore';
import { getLocalMessage, removeLocalMessage, saveLocalMessage } from './messageCache';

interface AuthenticatedHomeProps {
  user: UserIdentity;
  onSignOut: () => void;
  busy: boolean;
  message: string;
}

type Dialog = 'search' | 'security' | 'settings' | null;
type ThreadMessage = EncryptedMessage & { plaintext: string; decryptedReactions: string[]; sendState?: 'queued' | 'sending' | 'sent' | 'failed'; sendError?: string };
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

function OrbitMark() {
  return <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle cx="24" cy="24" r="4" fill="currentColor" />
    <ellipse cx="24" cy="24" rx="18" ry="8" transform="rotate(-34 24 24)" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="38.5" cy="14" r="2.5" fill="currentColor" />
  </svg>;
}

function initials(name: string): string {
  return name.trim().slice(0, 1).toLocaleUpperCase() || '?';
}

export default function AuthenticatedHome({ user, onSignOut, busy, message }: AuthenticatedHomeProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState('');
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [connection, setConnection] = useState<OrbitConnectionState>('offline');
  const [connectionError, setConnectionError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
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
  const [peerRequestState, setPeerRequestState] = useState<'idle' | 'requested' | 'received' | 'accepted'>('idle');
  const [peerRequestId, setPeerRequestId] = useState<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const deliveredRef = useRef(new Set<string>());
  const flushingMessagesRef = useRef(new Set<string>());
  const attemptedMessagesRef = useRef(new Set<string>());
  const threadLoadIdRef = useRef(0);

  const loadConversations = useCallback(async () => {
    setLoadingConversations(true);
    setConversationError('');
    try {
      const response = await getConversations();
      setConversations(response.conversations);
      setSelectedId((current) => current && response.conversations.some(({ id }) => id === current) ? current : null);
    } catch (error) {
      setConversationError(error instanceof Error ? error.message : 'Could not load conversations.');
    } finally {
      setLoadingConversations(false);
    }
  }, []);

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

  const refreshThread = useCallback(async () => {
    if (!selected || !deviceIdentity) return;
    const loadId = ++threadLoadIdRef.current;
    try {
      const storageKey = `orbit-outbox:${user.id}`;
      const outbox = readOutbox(storageKey);
      setOutboxCount(outbox.length);
      const pending = await Promise.all(outbox
        .filter((item) => item.conversationId === selected.id)
        .map((item) => toPendingThreadMessage(
          item,
          deviceIdentity,
          selected,
          user.id,
          flushingMessagesRef.current.has(item.clientMsgId),
        )));
      if (loadId !== threadLoadIdRef.current) return;
      setThreadMessages((current) => {
        const existingMessages = current.filter((item) =>
          item.conversationId === selected.id && !item.sendState,
        );
        const pendingIds = new Set(pending.map((item) => item.clientMsgId));
        return [
          ...existingMessages.filter((item) => !pendingIds.has(item.clientMsgId)),
          ...pending,
        ];
      });

      const response = await getMessages(selected.id);
      const persistedIds = new Set(response.messages.map((item) => item.clientMsgId));
      const confirmedOutboxIds = outbox
        .filter((item) => item.conversationId === selected.id && persistedIds.has(item.clientMsgId))
        .map((item) => item.clientMsgId);
      const remainingOutbox = outbox.filter((item) =>
        item.conversationId !== selected.id || !persistedIds.has(item.clientMsgId),
      );
      if (remainingOutbox.length !== outbox.length) writeOutbox(storageKey, remainingOutbox);
      await Promise.all(response.messages
        .filter((item) => confirmedOutboxIds.includes(item.clientMsgId))
        .map((item) => removeLocalMessage(item.clientMsgId)));
      setOutboxCount(remainingOutbox.length);
      const decrypted = await Promise.all(response.messages.map(async (item): Promise<ThreadMessage> => {
        let plaintext = item.deletedAt ? 'Message deleted' : 'Unable to decrypt this message.';
        if (!item.deletedAt && item.ciphertext && item.iv && item.kind === 'text') {
          try {
            plaintext = await decryptMessage(deviceIdentity, selected, item.ciphertext, item.iv);
          } catch {
            plaintext = 'Unable to decrypt this message.';
          }
        }
        const decryptedReactions = await Promise.all(item.reactions.map(async (reaction) => {
          try {
            return await decryptMessage(deviceIdentity, selected, reaction.reactionEnc, reaction.iv);
          } catch {
            return '';
          }
        }));
        return { ...item, plaintext, decryptedReactions: decryptedReactions.filter(Boolean) };
      }));
      if (loadId !== threadLoadIdRef.current) return;
      setThreadMessages([
        ...decrypted,
        ...pending.filter((item) => !persistedIds.has(item.clientMsgId)),
      ]);
      setThreadError('');

      const unread = response.messages.filter((item) =>
        item.senderId !== user.id &&
        !item.deletedAt &&
        !deliveredRef.current.has(item.id) &&
        !item.receipts.some((receipt) => receipt.userId === user.id && receipt.status === 'read'),
      );
      for (const item of unread) {
        deliveredRef.current.add(item.id);
        void addMessageReceipt(selected.id, item.id, 'delivered').catch(() => deliveredRef.current.delete(item.id));
        void addMessageReceipt(selected.id, item.id, 'read').catch(() => undefined);
      }
    } catch (error) {
      if (loadId === threadLoadIdRef.current) {
        setThreadError(error instanceof Error ? error.message : 'Could not load this conversation.');
      }
    }
  }, [connection, deviceIdentity, selected, user.id]);

  useEffect(() => {
    setThreadMessages([]);
    setThreadError('');
    deliveredRef.current.clear();
    if (!selected) return;
    void refreshThread();
    const interval = window.setInterval(() => void refreshThread(), 4000);
    return () => window.clearInterval(interval);
  }, [refreshThread, selected]);

  useEffect(() => {
    const unsubscribe = subscribeOrbitEvents((envelope) => {
      if (envelope.event === 'message.new' || envelope.event === 'message.created') {
        const event = envelope.data as { payload?: EncryptedMessage };
        if (event.payload?.conversationId === selectedId) void refreshThread();
      }
      if (envelope.event === 'message.edited' || envelope.event === 'message.deleted') {
        void refreshThread();
      }
      if (envelope.event === 'file.peer.request') {
        const event = envelope.data as { payload?: { requestId?: string } };
        setPeerRequestId(event.payload?.requestId ?? null);
        setPeerRequestState('received');
      }
      if (envelope.event === 'file.peer.response') {
        const event = envelope.data as { payload?: { accepted?: boolean } };
        setPeerRequestId(null);
        setPeerRequestState(event.payload?.accepted ? 'accepted' : 'idle');
        setNotice(event.payload?.accepted ? 'The peer-to-peer file request was accepted.' : 'The file-sharing request was declined.');
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
  }, [refreshThread, selectedId]);

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

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [threadMessages]);

  async function sendTextMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const plaintext = draft.trim();
    if (!plaintext || !selected || !deviceIdentity || sending) return;
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
      const encrypted = await encryptMessage(deviceIdentity, selected, reaction);
      await setMessageReaction(selected.id, item.id, {
        reactionEnc: encrypted.ciphertext,
        iv: encrypted.iv,
      });
      void refreshThread();
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : 'Could not save the reaction.');
    }
  }

  function requestPeerFileShare() {
    if (!selected || connection !== 'connected') {
      setThreadError('Connect to Orbit before requesting peer-to-peer file sharing.');
      return;
    }
    try {
      setPeerRequestState('requested');
      setThreadError('');
      const requestId = crypto.randomUUID();
      setPeerRequestId(requestId);
      sendOrbitEvent('file.peer.request', { conversationId: selected.id, requestId });
    } catch (error) {
      setPeerRequestState('idle');
      setThreadError(error instanceof Error ? error.message : 'Could not request file sharing.');
    }
  }

  function respondToPeerRequest(accepted: boolean) {
    if (!selected || connection !== 'connected') {
      setThreadError('Connect to Orbit before responding to a file-sharing request.');
      return;
    }
    try {
      if (!peerRequestId) throw new Error('This file-sharing request is no longer available.');
      sendOrbitEvent('file.peer.response', { conversationId: selected.id, requestId: peerRequestId, accepted });
      setPeerRequestState(accepted ? 'accepted' : 'idle');
      setPeerRequestId(null);
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : 'Could not respond to the request.');
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
      setSelectedId(conversation.id);
      setDialog(null);
      setQuery('');
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : 'Could not start this conversation.');
    }
  }

  function connectionLabel() {
    if (connection === 'connected') return 'Connected';
    if (connection === 'connecting') return 'Connecting…';
    if (connection === 'auth_failed') return 'Session expired';
    if (connection === 'reconnecting') return 'Reconnecting';
    if (connection === 'idle') return 'Idle';
    return 'Offline';
  }

  return <main className="home-screen orbit-shell">
    <aside className="orbit-sidebar" aria-label="Orbit navigation">
      <a className="home-brand" href="/" aria-label="Orbit home"><OrbitMark /> orbit<span>.</span></a>
      <div className="orbit-sidebar-heading">
        <span className="eyebrow">01 / YOUR ORBIT</span>
        <button className="orbit-add" type="button" aria-label="Find someone by username" onClick={() => setDialog('search')}>+</button>
      </div>
      <button className="orbit-find" type="button" onClick={() => setDialog('search')}>
        <span aria-hidden="true">⌕</span> Find someone by username
      </button>
      <div className="orbit-list-heading"><span>CONVERSATIONS</span><span>{conversations.length.toString().padStart(2, '0')}</span></div>
      <div className="orbit-conversation-list">
        {loadingConversations && <p className="orbit-list-note">Loading conversations…</p>}
        {!loadingConversations && conversations.length === 0 && <p className="orbit-list-note">No conversations yet. Find someone to begin.</p>}
        {conversationError && <div className="orbit-inline-error" role="alert"><span>{conversationError}</span><button type="button" onClick={() => void loadConversations()}>Retry</button></div>}
        {conversations.map(({ id, peer }) => <button
          className={`orbit-conversation${selectedId === id ? ' is-selected' : ''}`}
          type="button"
          key={id}
          aria-label={`Conversation with ${peer.displayName}`}
          onClick={() => setSelectedId(id)}
          aria-current={selectedId === id ? 'page' : undefined}
        >
          <span className="orbit-avatar">{initials(peer.displayName)}</span>
          <span className="orbit-conversation-copy"><strong>{peer.displayName}</strong><small>@{peer.username}</small></span>
          <span className="orbit-chevron" aria-hidden="true">↗</span>
        </button>)}
      </div>
      <div className="orbit-sidebar-bottom">
        <div className={`orbit-connection is-${connection}`} role="status">
          <i />
          <span>{connectionLabel()}</span>
          {connection === 'offline' && <button type="button" onClick={retryOrbitSocket}>Retry</button>}
        </div>
        {connectionError && <p className="orbit-connection-error" role="alert">{connectionError}</p>}
        <button className="orbit-profile" type="button" aria-label={`Settings for ${user.displayName}`} onClick={() => setDialog('settings')}>
          <span className="orbit-avatar orbit-avatar--self">{initials(user.displayName)}</span>
          <span><strong>{user.displayName}</strong><small>@{user.username}</small></span>
          <span className="orbit-chevron" aria-hidden="true">···</span>
        </button>
      </div>
    </aside>

    <section className="orbit-main" aria-label={selected ? `Conversation with ${selected.peer.displayName}` : 'Personal space'}>
      <header className="orbit-topbar">
        <span className="orbit-topbar-caption"><i /> PRIVATE SESSION</span>
        <button className="home-signout" disabled={busy} onClick={onSignOut}>Sign out <span aria-hidden="true">↗</span></button>
      </header>

      {!selected ? <div className="orbit-home">
        <div className="orbit-home-copy">
          <span className="eyebrow"><span /> YOUR ORBIT / PERSONAL SPACE</span>
          <h1>A little space,<br /><em>entirely yours.</em></h1>
          <p>A quieter place for your people. Start with a username; your conversations will gather here.</p>
          <div className="orbit-home-actions">
            <button className="orbit-primary-action" type="button" onClick={() => setDialog('search')}>Find someone by username <span aria-hidden="true">↗</span></button>
            <button className="orbit-secondary-action" type="button" onClick={() => setDialog('security')}>Verify security code</button>
            <button className="orbit-secondary-action" type="button" onClick={() => setDialog('settings')}>Settings</button>
          </div>
        </div>
        <div className="orbit-home-art" aria-hidden="true">
          <span className="orbit-art-ring orbit-art-ring--one" />
          <span className="orbit-art-ring orbit-art-ring--two" />
          <span className="orbit-art-ring orbit-art-ring--three" />
          <span className="orbit-art-point orbit-art-point--one" />
          <span className="orbit-art-point orbit-art-point--two" />
          <span className="orbit-art-core"><OrbitMark /></span>
        </div>
        <div className="orbit-home-bottom">
          <article className="orbit-info-card">
            <span className="eyebrow">02 / YOUR DEVICE</span>
            <div className="orbit-device-row">
              <span className="orbit-avatar orbit-avatar--self">{initials(user.displayName)}</span>
              <div><strong>{user.displayName}</strong><small>@{user.username}</small></div>
              <button className="orbit-copy-button" type="button" onClick={() => void copyFingerprint(user.fingerprint)}>Copy fingerprint</button>
            </div>
            <details className="orbit-fingerprint">
              <summary>Device key fingerprint</summary>
              <code>{user.fingerprint}</code>
              <button type="button" onClick={() => void copyFingerprint(user.fingerprint)}>Copy full fingerprint</button>
            </details>
          </article>
          <article className="orbit-info-card orbit-security-card">
            <span className="eyebrow">03 / DEVICE SECURITY</span>
            <h2>This device is<br />in your orbit.</h2>
            <p>Your private key stays on this device. The active server key matches this device.</p>
            <div className="orbit-security-state"><span><i /> KEY VERIFIED</span><span>VERSION {user.keyVersion}</span></div>
          </article>
          <article className="orbit-info-card orbit-status-card">
            <span className="eyebrow">04 / LIVE CONNECTION</span>
            <strong className={`orbit-status-title is-${connection}`}><i /> {connectionLabel()}</strong>
            <p>{connectionError || (connection === 'connected' ? 'Secure connection to Orbit is active.' : 'Orbit is trying to reach the secure messaging service.')}</p>
            {connection === 'offline' && <button className="orbit-inline-retry" type="button" onClick={retryOrbitSocket}>Retry connection ↗</button>}
          </article>
        </div>
      </div> : <div className="orbit-thread">
        <header className="orbit-thread-header">
          <div className="orbit-thread-orbit" aria-hidden="true">
            <span className="orbit-art-ring orbit-art-ring--one" />
            <span className="orbit-art-ring orbit-art-ring--two" />
            <span className="orbit-stage-line" />
            <span className="orbit-stage-person orbit-stage-person--self">{initials(user.displayName)}</span>
            <span className="orbit-stage-person orbit-stage-person--peer">{initials(selected.peer.displayName)}</span>
            <span className="orbit-stage-star">✳</span>
          </div>
          <div className="orbit-thread-person">
            <span className="eyebrow">DIRECT MESSAGE</span>
            <h1>{selected.peer.displayName}<em>@{selected.peer.username}</em></h1>
            <span className={`orbit-stage-connection is-${connection}`}><i /> {connectionLabel()}</span>
          </div>
          <div className="orbit-thread-tools">
            <button className="orbit-secondary-action" type="button" onClick={() => setDialog('security')}>Verify security code</button>
          </div>
        </header>
        <section className="orbit-message-list" aria-label="Encrypted messages" aria-live="polite">
          {threadMessages.length === 0 && !threadError && <div className="orbit-thread-empty"><span className="eyebrow">A SPACE FOR TWO</span><p>No messages yet. Send a private note to start the conversation.</p></div>}
          {threadError && <div className="orbit-thread-error" role="alert">{threadError}<button type="button" onClick={() => void refreshThread()}>Retry</button></div>}
          {threadMessages.map((item) => <article className={`orbit-message${item.senderId === user.id ? ' is-own' : ''}`} key={item.id}>
            {item.replyToId && <span className="orbit-reply-caption">REPLY TO / {item.replyToId.slice(0, 8)}</span>}
            {editingId === item.id ? <div className="orbit-edit-form">
              <textarea aria-label="Edit message" value={editDraft} onChange={(event) => setEditDraft(event.target.value)} />
              <button type="button" onClick={() => void editTextMessage(item)}>Save edit</button>
              <button type="button" onClick={() => setEditingId(null)}>Cancel</button>
            </div> : <p>{item.plaintext}</p>}
            {item.decryptedReactions.length > 0 && <div className="orbit-message-reactions">{item.decryptedReactions.map((reaction, index) => <span key={`${item.id}-${index}`}>{reaction}</span>)}</div>}
            <footer><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{item.editedAt ? ' · edited' : ''}</time>
              {item.senderId === user.id && <span>{item.sendState === 'failed' ? "Couldn't send" : item.sendState === 'queued' || item.sendState === 'sending' ? 'Sending' : item.receipts.some((entry) => entry.status === 'read') ? 'Seen' : item.receipts.some((entry) => entry.status === 'delivered') ? 'Delivered' : 'Sent'}</span>}
            </footer>
            {item.senderId === user.id && item.sendState === 'failed' && <div className="orbit-message-error" role="alert">
              <span>{item.sendError ?? 'Could not send this message.'}</span>
              <button type="button" onClick={() => retryQueuedMessage(item.clientMsgId)}>Retry</button>
            </div>}
            {item.senderId === user.id && !item.deletedAt && !item.sendState && <div className="orbit-message-actions">
              <button type="button" onClick={() => { setEditingId(item.id); setEditDraft(item.plaintext); }}>Edit</button>
              <button type="button" onClick={() => void removeTextMessage(item)}>Delete</button>
            </div>}
            {!item.deletedAt && <div className="orbit-message-actions">
              <button type="button" onClick={() => setReplyTo(item.id)}>Reply</button>
              <button type="button" aria-label="React with heart" onClick={() => void reactToMessage(item, '❤️')}>React ♥</button>
            </div>}
          </article>)}
          <div ref={threadEndRef} />
        </section>
        <form className="orbit-composer" onSubmit={(event) => void sendTextMessage(event)}>
          {replyTo && <div className="orbit-replying">Replying to {threadMessages.find((item) => item.id === replyTo)?.plaintext.slice(0, 80) ?? 'message'}<button type="button" onClick={() => setReplyTo(null)}>Cancel</button></div>}
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={8000} aria-label="Message" placeholder={deviceIdentity ? 'Write an encrypted message…' : 'Loading your device key…'} disabled={!deviceIdentity} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }} />
          <div className="orbit-composer-bottom">
            <span>{outboxCount > 0 ? `${outboxCount} encrypted message${outboxCount === 1 ? '' : 's'} in outbox` : 'Messages are end-to-end encrypted · Enter to send'}</span>
            {outboxCount > 0 && <button className="orbit-outbox-retry" type="button" disabled={connection !== 'connected'} onClick={retryAllQueuedMessages}>Retry queued</button>}
            <button className="orbit-primary-action" type="submit" disabled={!draft.trim() || sending || !deviceIdentity}>{sending ? 'Sending…' : 'Send'} <span aria-hidden="true">↗</span></button>
          </div>
        </form>
      </div>}
      {message && <p className="form-message home-message" role="alert">{message}</p>}
      {actionError && <p className="orbit-action-error" role="alert">{actionError}</p>}
      <footer className="home-footer"><span>ORBIT / PRIVATE BY DESIGN</span><span>YOUR KEYS. YOUR SPACE.</span></footer>
    </section>

    {notice && <div className="orbit-toast" role="status">{notice}</div>}

    {dialog && <div className="orbit-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setDialog(null);
    }}>
      <section className="orbit-dialog" role="dialog" aria-modal="true" aria-labelledby="orbit-dialog-title" onKeyDown={(event) => {
        if (event.key === 'Escape') setDialog(null);
      }}>
        <button className="orbit-dialog-close" type="button" onClick={() => setDialog(null)} aria-label="Close dialog">×</button>
        {dialog === 'search' && <>
          <span className="eyebrow">FIND YOUR PEOPLE / 01</span>
          <h2 id="orbit-dialog-title">Find someone.</h2>
          <p>Search by username. Enter at least three characters.</p>
          <label className="orbit-search-label" htmlFor="orbit-user-search">Username</label>
          <input id="orbit-user-search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Start typing a username" autoComplete="off" />
          {query.trim().length < 3 ? <p className="orbit-dialog-hint">Search starts at 3 characters.</p> : searching ? <p className="orbit-dialog-hint" role="status">Searching Orbit…</p> : searchError ? <p className="orbit-dialog-error" role="alert">{searchError}</p> : results.length === 0 ? <p className="orbit-dialog-hint">No people found for that username.</p> : <div className="orbit-search-results">
            {results.map((person) => <button type="button" key={person.id} onClick={() => void openConversation(person)}>
              <span className="orbit-avatar">{initials(person.displayName)}</span><span><strong>{person.displayName}</strong><small>@{person.username}</small></span><span aria-hidden="true">↗</span>
            </button>)}
          </div>}
        </>}
        {dialog === 'security' && <>
          <span className="eyebrow">SECURITY / MANUAL COMPARISON</span>
          <h2 id="orbit-dialog-title">Verify a security code.</h2>
          {selected ? <>
            <p>Compare this contact’s fingerprint with them through a trusted channel. Orbit does not mark a contact verified without that comparison.</p>
            <span className="orbit-code-label">@{selected.peer.username} / ACTIVE KEY VERSION {selected.peer.keyVersion}</span>
            <code className="orbit-security-code">{selected.peer.fingerprint || 'No active fingerprint is available.'}</code>
            {selected.peer.fingerprint && <button className="orbit-primary-action" type="button" onClick={() => void copyFingerprint(selected.peer.fingerprint)}>Copy security code <span aria-hidden="true">↗</span></button>}
          </> : <><p>Select a conversation to compare the other person’s active public-key fingerprint.</p>{conversations.length === 0 ? <p className="orbit-dialog-hint">No conversations to verify yet.</p> : <div className="orbit-search-results">
            {conversations.map(({ id, peer }) => <button type="button" key={id} onClick={() => {
              setSelectedId(id);
              setDialog('security');
            }}><span className="orbit-avatar">{initials(peer.displayName)}</span><span><strong>{peer.displayName}</strong><small>@{peer.username}</small></span><span aria-hidden="true">↗</span></button>)}
          </div>}</>}
        </>}
        {dialog === 'settings' && <>
          <span className="eyebrow">SETTINGS / DEVICE</span>
          <h2 id="orbit-dialog-title">Your space, your keys.</h2>
          <p>Account and device details currently available for this session.</p>
          <dl className="orbit-settings-list"><div><dt>Username</dt><dd>@{user.username}</dd></div><div><dt>Active key version</dt><dd>{user.keyVersion}</dd></div><div><dt>Device key</dt><dd>Verified against the active server key</dd></div><div><dt>Connection</dt><dd>{connectionLabel()}</dd></div></dl>
          <button className="orbit-primary-action" type="button" onClick={() => void copyFingerprint(user.fingerprint)}>Copy device fingerprint <span aria-hidden="true">↗</span></button>
          <button className="orbit-dialog-signout" type="button" disabled={busy} onClick={onSignOut}>Sign out of Orbit</button>
        </>}
      </section>
    </div>}
  </main>;
}
