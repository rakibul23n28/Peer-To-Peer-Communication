import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
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
import { encryptFolderManifest, decryptFolderManifest } from './shared-folders/crypto';
import { createSharedFolder, listSharedFolders, revokeSharedFolder } from './shared-folders/api';
import { makeManifest, pickFolder, type PickedFolder } from './shared-folders/picker';
import { PreviewServer, type PreviewServerNotice } from './shared-folders/previewServer';
import { PreviewSessionManager } from './shared-folders/previewSession';
import { deleteFolderHandle, saveFolderHandle } from './shared-folders/sourceStorage';
import type { PreviewSignal } from '../shared/previewProtocol';
import {
  type SharedFolderManifest,
} from '../shared/sharedFolders';
import { getDeviceIdentity, getDeviceIdentityForVersion, getSavedDeviceIdentities, type DeviceIdentity } from './keyStore';
import { getLocalMessage, removeLocalMessage, saveLocalMessage } from './messageCache';
import { hashFile, PeerFileTransfer, supportsFileSize, type PeerFileSignal } from './peerFileTransfer';
import { PeerAudioCall, type PeerAudioSignal } from './peerAudioCall';
import type { AudioCallView } from './components/AudioCallPanel';
import { ConversationThread, type FileTransferProgress, type ThreadMessage } from './components/ConversationThread';
import { ConversationSidebar } from './components/ConversationSidebar';
import { EmptyConversationState } from './components/EmptyConversationState';
import { OrbitDialogs, type OrbitDialogKind } from './components/OrbitDialogs';
import { WorkspaceDetails } from './components/WorkspaceDetails';

type WorkspaceAppearance = 'storybook' | 'minimal' | 'watercolor' | 'anime' | 'midnight';

function isWorkspaceAppearance(value: string): value is WorkspaceAppearance {
  return ['storybook', 'minimal', 'watercolor', 'anime', 'midnight'].includes(value);
}

function readWorkspacePreference(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

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

function fallbackFilesForManifest(
  folder: PickedFolder,
  manifest: SharedFolderManifest,
): Map<number, File> {
  const files = new Map<number, File>()
  for (const entry of manifest.entries) {
    if (entry.k !== 'f') continue
    const file = folder.filesByPath?.get(entry.p)
    if (file) files.set(entry.id, file)
  }
  return files
}

function manifestsMatch(
  expected: SharedFolderManifest,
  actual: SharedFolderManifest,
): boolean {
  if (expected.rootName !== actual.rootName || expected.entries.length !== actual.entries.length) return false
  const toKey = (entry: SharedFolderManifest['entries'][number]) =>
    `${entry.p}\u0000${entry.k}\u0000${entry.s ?? ''}\u0000${entry.m ?? ''}`
  const expectedEntries = expected.entries.map(toKey).sort()
  const actualEntries = actual.entries.map(toKey).sort()
  return expectedEntries.every((entry, index) => entry === actualEntries[index])
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
  const [previewOwnerNotice, setPreviewOwnerNotice] = useState<PreviewServerNotice | null>(null);
  const [refreshingPeerKey, setRefreshingPeerKey] = useState(false);
  const [threadMessages, setThreadMessages] = useState<ThreadMessage[]>([]);
  const [threadError, setThreadError] = useState('');
  const [navigationCollapsed, setNavigationCollapsed] = useState(
    () => readWorkspacePreference('orbit-navigation-collapsed', 'false') === 'true',
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [workspaceAppearance, setWorkspaceAppearance] = useState<WorkspaceAppearance>(
    () => {
      const saved = readWorkspacePreference('orbit-appearance', '');
      if (isWorkspaceAppearance(saved)) return saved;
      return readWorkspacePreference('orbit-theme', 'light') === 'dark' ? 'midnight' : 'storybook';
    },
  );
  const workspaceLayoutStyle: CSSProperties & Record<
    '--orbit-sidebar-width' | '--orbit-details-width',
    string
  > = {
    '--orbit-sidebar-width': `${navigationCollapsed ? 72 : 270}px`,
    '--orbit-details-width': `${selectedId && detailsOpen ? 310 : 0}px`,
  };
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [deviceIdentity, setDeviceIdentity] = useState<DeviceIdentity | null>(null);
  const previewServerRef = useRef<PreviewServer | null>(null);
  const previewOwnerSharesRef = useRef(new Map<string, { manifest: SharedFolderManifest; conversation: ConversationSummary }>());
  const previewSessionManagerRef = useRef<PreviewSessionManager | null>(null);
  previewSessionManagerRef.current ??= new PreviewSessionManager();
  const [outboxCount, setOutboxCount] = useState(0);
  const [outboxRevision, setOutboxRevision] = useState(0);
  const [fileShortcutPending, setFileShortcutPending] = useState(false);
  const [fileSending, setFileSending] = useState(false);
  const [fileProgress, setFileProgress] = useState<Record<string, FileTransferProgress>>({});
  const [receivedFiles, setReceivedFiles] = useState<Record<string, { name: string; blob: Blob; url: string }>>({});
  const [audioCall, setAudioCall] = useState<AudioCallView | null>(null);
  const [remoteAudioStream, setRemoteAudioStream] = useState<MediaStream | null>(null);
  const receivedFilesRef = useRef(receivedFiles);
  receivedFilesRef.current = receivedFiles;
  const audioCallRef = useRef<AudioCallView | null>(audioCall);
  audioCallRef.current = audioCall;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
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
  const fileInfoRef = useRef(new Map<string, { size: number; mime: string; sha256: string; recipientKeyVersion: number }>());
  const audioCallSessionRef = useRef<PeerAudioCall | null>(null);
  const startingAudioCallRef = useRef(false);

  function updateAudioCall(
    update: AudioCallView | null | ((current: AudioCallView | null) => AudioCallView | null),
  ): void {
    const next = typeof update === 'function' ? update(audioCallRef.current) : update;
    audioCallRef.current = next;
    setAudioCall(next);
  }

  function finishAudioCall(sendSignal: boolean, message?: string): void {
    const current = audioCallRef.current;
    if (!current) return;
    if (sendSignal && connectionRef.current === 'connected') {
      try {
        const event = current.phase === 'ringing'
          ? current.direction === 'incoming' ? 'call.respond' : 'call.cancel'
          : 'call.hangup';
        const data = event === 'call.respond'
          ? { callId: current.callId, accepted: false }
          : { callId: current.callId };
        sendOrbitEvent(event, data);
      } catch (error) {
        if (!message) message = error instanceof Error ? error.message : 'Could not notify the other person that the call ended.';
      }
    }
    audioCallSessionRef.current?.close();
    audioCallSessionRef.current = null;
    setRemoteAudioStream(null);
    updateAudioCall(null);
    if (message) setNotice(message);
  }

  function createAudioCallSession(callId: string, stream: MediaStream): PeerAudioCall {
    return new PeerAudioCall({
      stream,
      onSignal: (signal: PeerAudioSignal) => {
        try {
          sendOrbitEvent('call.signal', { callId, signal });
        } catch (error) {
          finishAudioCall(false, error instanceof Error ? error.message : 'Could not signal the audio call.');
        }
      },
      onRemoteStream: setRemoteAudioStream,
      onConnected: () => updateAudioCall((current) => current?.callId === callId
        ? { ...current, phase: 'active', startedAt: current.startedAt ?? Date.now() }
        : current),
      onError: (error) => finishAudioCall(true, error.message),
    });
  }

  async function startAudioCall(): Promise<void> {
    const conversation = selected;
    if (!conversation || peerBlocked || audioCallRef.current || startingAudioCallRef.current) return;
    if (connection !== 'connected') {
      setNotice('Reconnect before starting an audio call.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice('Audio calls require microphone access on a secure connection.');
      return;
    }
    startingAudioCallRef.current = true;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (audioCallRef.current || selectedId !== conversation.id) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const callId = crypto.randomUUID();
      audioCallSessionRef.current = createAudioCallSession(callId, stream);
      updateAudioCall({
        callId,
        conversationId: conversation.id,
        peerId: conversation.peer.id,
        peerName: conversation.peer.displayName,
        direction: 'outgoing',
        phase: 'ringing',
        muted: false,
        startedAt: null,
      });
      sendOrbitEvent('call.invite', { callId, conversationId: conversation.id });
    } catch (error) {
      if (audioCallRef.current) finishAudioCall(false);
      else if (stream) for (const track of stream.getTracks()) track.stop();
      setNotice(error instanceof Error ? error.message : 'Could not start the audio call.');
    } finally {
      startingAudioCallRef.current = false;
    }
  }

  async function acceptAudioCall(): Promise<void> {
    const current = audioCallRef.current;
    if (!current || current.direction !== 'incoming' || current.phase !== 'ringing') return;
    if (!navigator.mediaDevices?.getUserMedia) {
      finishAudioCall(true, 'Audio calls require microphone access on a secure connection.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (audioCallRef.current?.callId !== current.callId) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      audioCallSessionRef.current = createAudioCallSession(current.callId, stream);
      updateAudioCall({ ...current, phase: 'connecting' });
      sendOrbitEvent('call.respond', { callId: current.callId, accepted: true });
    } catch (error) {
      finishAudioCall(true, error instanceof Error ? error.message : 'Could not accept the audio call.');
    }
  }

  function toggleAudioMute(): void {
    const current = audioCallRef.current;
    if (!current || current.phase === 'ringing') return;
    const muted = !current.muted;
    audioCallSessionRef.current?.setMuted(muted);
    updateAudioCall({ ...current, muted });
  }

  function handleAudioCallEvent(eventName: string, data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const payload = (data as { payload?: unknown }).payload;
    if (!payload || typeof payload !== 'object') return;
    const value = payload as {
      callId?: unknown
      conversationId?: unknown
      callerId?: unknown
      signal?: unknown
      message?: unknown
    };
    if (typeof value.callId !== 'string') return;
    const current = audioCallRef.current;

    if (eventName === 'call.incoming') {
      if (typeof value.conversationId !== 'string' || typeof value.callerId !== 'string') return;
      if (current) {
        try {
          sendOrbitEvent('call.respond', { callId: value.callId, accepted: false });
        } catch {
          setNotice('A second call came in while you were already on a call.');
        }
        return;
      }
      const conversation = conversationsRef.current.find(({ id }) => id === value.conversationId);
      updateAudioCall({
        callId: value.callId,
        conversationId: value.conversationId,
        peerId: value.callerId,
        peerName: conversation?.peer.displayName ?? 'Orbit contact',
        direction: 'incoming',
        phase: 'ringing',
        muted: false,
        startedAt: null,
      });
      return;
    }

    if (!current || current.callId !== value.callId) return;
    if (eventName === 'call.accepted' && current.direction === 'outgoing') {
      updateAudioCall({ ...current, phase: 'connecting' });
      const session = audioCallSessionRef.current;
      if (!session) {
        finishAudioCall(true, 'The microphone session could not be started.');
        return;
      }
      void session.createOffer().catch((error: unknown) => {
        finishAudioCall(true, error instanceof Error ? error.message : 'Could not negotiate the audio connection.');
      });
    } else if (eventName === 'call.signal' && value.signal && audioCallSessionRef.current) {
      void audioCallSessionRef.current.handleSignal(value.signal as PeerAudioSignal).catch((error: unknown) => {
        finishAudioCall(true, error instanceof Error ? error.message : 'The audio connection could not be established.');
      });
    } else if (eventName === 'call.error') {
      finishAudioCall(current.phase !== 'ringing', typeof value.message === 'string' ? value.message : 'The audio call could not be completed.');
    } else if (eventName === 'call.declined') {
      finishAudioCall(false, `${current.peerName} declined the call.`);
    } else if (eventName === 'call.cancelled') {
      finishAudioCall(false, `${current.peerName} cancelled the call.`);
    } else if (eventName === 'call.timeout') {
      finishAudioCall(false, 'The audio call was not answered.');
    } else if (eventName === 'call.ended') {
      finishAudioCall(false, 'The audio call ended.');
    }
  }

  useEffect(() => {
    for (const [key, value] of [
      ['orbit-navigation-collapsed', String(navigationCollapsed)],
      ['orbit-appearance', workspaceAppearance],
    ]) {
      try {
        localStorage.setItem(key, value);
      } catch {
        setNotice('Workspace preferences could not be saved in this browser.');
        break;
      }
    }
  }, [navigationCollapsed, workspaceAppearance]);

  useEffect(() => {
    if (!detailsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetailsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [detailsOpen]);

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

  async function refreshPeerKey() {
    if (!selected || refreshingPeerKey) return;
    setRefreshingPeerKey(true);
    setActionError('');
    try {
      const response = await getConversations();
      conversationsRef.current = response.conversations;
      setConversations(response.conversations);
      const refreshed = response.conversations.find(({ id }) => id === selected.id);
      await refreshThread(true);
      if (refreshed?.peer.keyAvailable) {
        setNotice(`${refreshed.peer.displayName}'s encryption key is available.`);
      } else {
        setNotice(`${selected.peer.displayName}'s key is still unavailable. Ask them to sign in and restore it.`);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not refresh the contact encryption key.');
    } finally {
      setRefreshingPeerKey(false);
    }
  }

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
  const sendPreviewSignal = useCallback((signal: PreviewSignal) => {
    sendOrbitEvent('preview.signal', signal);
  }, []);

  function leaveSession(): void {
    previewServerRef.current?.closeAll();
    previewSessionManagerRef.current?.closeAll();
    onSignOut();
  }

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
    if (!deviceIdentity) return;
    const server = new PreviewServer({
      identity: deviceIdentity,
      userId: user.id,
      onSignal: (signal) => {
        try {
          sendOrbitEvent('preview.signal', signal);
        } catch {
          setPreviewOwnerNotice({
            type: 'error',
            shareId: signal.shareId,
            message: 'The preview signaling connection was interrupted.',
          });
        }
      },
      onNotice: (next) => setPreviewOwnerNotice(next.type === 'activity' && !next.entryId ? null : next),
    });
    previewServerRef.current = server;
    const closeOnExit = () => {
      server.closeAll();
      previewSessionManagerRef.current?.closeAll();
    };
    window.addEventListener('beforeunload', closeOnExit);
    return () => {
      window.removeEventListener('beforeunload', closeOnExit);
      server.closeAll();
      previewSessionManagerRef.current?.closeAll();
      if (previewServerRef.current === server) previewServerRef.current = null;
    };
  }, [deviceIdentity, user.id]);

  useEffect(() => {
    const server = previewServerRef.current;
    if (!server || !deviceIdentity || connection !== 'connected') return;
    let active = true;
    void (async () => {
      for (const conversation of conversations) {
        if (!conversation.peer.keyAvailable) continue;
        try {
          const records = await listSharedFolders(conversation.id);
          for (const record of records) {
            if (!active || record.ownerId !== user.id) continue;
            const key = await derivePeerKey(
              deviceIdentity,
              conversation.id,
              conversation.peer.publicKey,
              'orbit-shared-folder-v1',
            );
            const opened = await decryptFolderManifest(record, key, conversation.id, record.id);
            previewOwnerSharesRef.current.set(record.id, {
              manifest: opened.manifest,
              conversation,
            });
            const status = await server.restoreShare({
              shareId: record.id,
              conversation,
              manifest: opened.manifest,
            });
            if (!active) return;
            if (status === 'permission') {
              setPreviewOwnerNotice({ type: 'permission', shareId: record.id })
            } else if (status === 'repick') {
              setPreviewOwnerNotice({ type: 'repick', shareId: record.id })
            }
          }
        } catch {
          if (active) setThreadError('Could not restore a folder preview source. Retry the conversation to try again.');
        }
      }
    })();
    return () => { active = false };
  }, [connection, conversations, deviceIdentity, user.id]);

  useEffect(() => {
    if (dialog === 'settings') void refreshBlockedUsers();
  }, [dialog]);

  useEffect(() => () => {
    for (const transfer of fileTransfersRef.current.values()) transfer.close();
    audioCallSessionRef.current?.close();
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
      try {
        const ownReaction = reaction.userId === user.id;
        const localKeyVersion = decryptionIdentity.keyVersion ?? user.keyVersion;
        const senderKeyVersion = ownReaction ? localKeyVersion : conversation.peer.keyVersion;
        const recipientKeyVersion = ownReaction ? conversation.peer.keyVersion : localKeyVersion;
        const decrypted = await decryptWithAvailableKeyVersions(
          identity,
          conversation,
          {
            senderId: reaction.userId,
            senderKeyVersion,
            recipientKeyVersion,
            keyVersion: senderKeyVersion,
          },
          reaction.reactionEnc,
          reaction.iv,
        );
        return {
          userId: reaction.userId,
          value: decrypted.plaintext,
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
  })), [decryptWithAvailableKeyVersions, user.id, user.keyVersion]);

  const refreshThread = useCallback(async (includeSharedFolders = false) => {
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
        const messages = new Map(
          current
            .filter((item) => item.conversationId === conversation.id)
            .map((item) => [item.clientMsgId, item]),
        );
        for (const item of pending) {
          if (!messages.has(item.clientMsgId)) messages.set(item.clientMsgId, item);
        }
        return [...messages.values()];
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
          fileInfoRef.current.delete(item.file.fileId);
          fileTransfersRef.current.get(item.file.fileId)?.close();
          fileTransfersRef.current.delete(item.file.fileId);
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
      const sharedFolderRecords = includeSharedFolders
        ? await listSharedFolders(conversation.id)
        : [];
      const folderMessages = await Promise.all(sharedFolderRecords.map(async (record) => {
        const baseMessage: ThreadMessage = {
          id: `shared-folder:${record.id}`,
          conversationId: record.conversationId,
          senderId: record.ownerId,
          clientMsgId: `shared-folder:${record.id}`,
          seq: "0",
          ciphertext: null,
          iv: null,
          keyVersion: 1,
          senderKeyVersion: 1,
          recipientKeyVersion: 1,
          replyToId: null,
          kind: 'shared_folder',
          createdAt: record.createdAt,
          editedAt: null,
          deletedAt: null,
          receipts: [],
          reactions: [],
          plaintext: record.ownerId === user.id ? 'You shared a folder' : `${conversation.peer.displayName} shared a folder`,
          decryptedReactions: [],
        };
        if (!conversation.peer.keyAvailable) {
          return {
            ...baseMessage,
            sharedFolder: { ...record, status: 'pending' as const },
          };
        }
        try {
          const key = await derivePeerKey(
            deviceIdentity,
            conversation.id,
            conversation.peer.publicKey,
            'orbit-shared-folder-v1',
          );
          const decryptedFolder = await decryptFolderManifest(
            record,
            key,
            conversation.id,
            record.id,
          );
          const manifest: SharedFolderManifest = decryptedFolder.manifest;
          const fileEntries = manifest.entries.filter(({ k }) => k === 'f');
          return {
            ...baseMessage,
            sharedFolder: {
              ...record,
              status: 'ready' as const,
              manifest,
              invalidCount: decryptedFolder.invalidCount,
              fileCount: fileEntries.length,
              folderCount: manifest.entries.filter(({ k }) => k === 'd').length,
              totalSize: fileEntries.reduce((total, entry) => total + (entry.s ?? 0), 0),
            },
          };
        } catch {
          return {
            ...baseMessage,
            sharedFolder: { ...record, status: 'error' as const },
          };
        }
      }));
      if (loadId !== threadLoadIdRef.current || historyConversationRef.current !== conversation.id) return;
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
        for (const item of current) {
          if (
            item.conversationId === conversation.id &&
            item.sendState &&
            !persistedIds.has(item.clientMsgId)
          ) {
            merged.set(item.id, item);
          }
        }
        for (const item of decrypted) merged.set(item.id, item);
        for (const item of folderMessages) merged.set(item.id, item);
        for (const item of current) {
          if (
            item.conversationId === conversation.id &&
            item.sharedFolder?.status === 'revoked' &&
            !folderMessages.some((folder) => folder.sharedFolder?.id === item.sharedFolder?.id)
          ) merged.set(item.id, item);
          if (
            !includeSharedFolders &&
            item.conversationId === conversation.id &&
            item.kind === 'shared_folder'
          ) merged.set(item.id, item);
        }
        const mergedClientIds = new Set(
          [...merged.values()].map((item) => item.clientMsgId),
        );
        for (const item of pending.filter((message) =>
          !persistedIds.has(message.clientMsgId) &&
          !mergedClientIds.has(message.clientMsgId),
        ).map((item) => ({
          ...item,
          sendState: flushingMessagesRef.current.has(item.clientMsgId)
            ? 'sending' as const
            : item.sendState,
        }))) merged.set(item.id, item);
        return [...merged.values()].sort((left, right) => {
          if (left.sendState && right.sendState) return left.createdAt.localeCompare(right.createdAt);
          if (left.sendState) return 1;
          if (right.sendState) return -1;
          if (left.kind === 'shared_folder' || right.kind === 'shared_folder') {
            return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
          }
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
    void refreshThread(true);
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
      if (envelope.event.startsWith('call.')) {
        handleAudioCallEvent(envelope.event, envelope.data);
      }
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
      if (envelope.event === 'shared_folder.created' || envelope.event === 'shared_folder.revoked') {
        const event = envelope.data as {
          payload?: { id?: string; conversationId?: string };
        };
        const payload = event.payload;
        if (envelope.event === 'shared_folder.revoked' && payload?.id) {
          previewServerRef.current?.closeShare(payload.id);
          previewSessionManagerRef.current?.closeShare(payload.id);
          previewOwnerSharesRef.current.delete(payload.id);
          setThreadMessages((current) => current.map((item) =>
            item.sharedFolder && item.sharedFolder.id === payload.id
              ? { ...item, sharedFolder: { ...item.sharedFolder, status: 'revoked' } }
              : item,
          ));
        }
        if (payload?.conversationId === selectedId) void refreshThread(true);
      }
      if (envelope.event === 'preview.signal') {
        const event = envelope.data as {
          payload?: {
            shareId?: string
            sessionId?: string
            kind?: 'offer' | 'answer' | 'ice' | 'bye'
            payload?: unknown
            senderId?: string
          }
        };
        const payload = event.payload;
        if (
          payload?.shareId &&
          payload.sessionId &&
          payload.kind &&
          payload.senderId
        ) {
          const signal = {
            shareId: payload.shareId,
            sessionId: payload.sessionId,
            kind: payload.kind,
            payload: payload.payload,
          };
          previewSessionManagerRef.current?.handleSignal(signal);
          if (payload.senderId !== user.id) {
            const conversation = conversationsRef.current.find(({ id }) =>
              previewOwnerSharesRef.current.get(payload.shareId!)?.conversation.id === id,
            );
            void previewServerRef.current?.acceptSignal({
              ...signal,
              senderId: payload.senderId,
              senderName: conversation?.peer.displayName ?? 'Your contact',
            }).catch(() => setPreviewOwnerNotice({
              type: 'error',
              shareId: payload.shareId!,
              message: 'Could not start this folder preview.',
            }));
          }
        }
      }
      if (envelope.event === 'preview.unavailable') {
        const event = envelope.data as {
          payload?: { shareId?: string; sessionId?: string; reason?: string }
        };
        if (event.payload?.shareId && event.payload.sessionId) {
          previewSessionManagerRef.current?.peerUnavailable(
            event.payload.shareId,
            event.payload.sessionId,
          );
        }
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
    if (!audioCall || audioCall.phase !== 'ringing') return;
    const timer = window.setTimeout(() => {
      finishAudioCall(true, 'The audio call was not answered.');
    }, 45_000);
    return () => window.clearTimeout(timer);
  }, [audioCall?.callId, audioCall?.phase]);

  useEffect(() => {
    if (!audioCall || audioCall.phase !== 'connecting') return;
    const callId = audioCall.callId;
    const timer = window.setTimeout(() => {
      if (audioCallRef.current?.callId === callId && audioCallRef.current.phase === 'connecting') {
        finishAudioCall(true, 'The audio call could not connect. Check microphone access and network connectivity; some networks require a TURN relay.');
      }
    }, 30_000);
    return () => window.clearTimeout(timer);
  }, [audioCall?.callId, audioCall?.phase]);

  useEffect(() => {
    if (connection === 'connected' || !audioCallRef.current) return;
    finishAudioCall(false, 'The call ended because the secure connection was lost.');
  }, [connection]);

  useEffect(() => {
    if (connection !== 'connected' || !selected) return;
    void refreshThread(true);
    if (!selected.peer.keyAvailable) return;
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
          !selected.peer.keyAvailable ||
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
        void requestOrbitEvent<{ messageId: string; seq: string }>(
          'message.send',
          messageEventPayload(item),
          item.clientMsgId,
        )
          .then((ack) => {
            setThreadMessages((current) => current.map((message) =>
              message.clientMsgId === item.clientMsgId
                ? { ...message, seq: ack.seq, sendState: 'sent', sendError: undefined }
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
    if (!plaintext || !selected || !deviceIdentity || sending || peerBlocked || !selected.peer.keyAvailable) return;
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
      try {
        await saveLocalMessage({ clientMsgId, conversationId: selected.id, plaintext, createdAt });
      } catch {
        setNotice('Message queued, but this browser could not save its local plaintext cache.');
      }
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : 'Could not send this encrypted message.');
    } finally {
      setSending(false);
    }
  }

  async function editTextMessage(item: ThreadMessage) {
    if (!selected || !deviceIdentity || !selected.peer.keyAvailable || !editDraft.trim()) return;
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
    if (!selected || !deviceIdentity || !selected.peer.keyAvailable) return;
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
        window.setTimeout(() => {
          fileTransfersRef.current.get(fileId)?.close();
          fileTransfersRef.current.delete(fileId);
        }, 5_000);
      },
      onSent: () => {
        setFileProgress((current) => ({
          ...current,
          [fileId]: { transferred: size, total: size, verified: true },
        }));
        sourceFilesRef.current.delete(fileId);
        fileInfoRef.current.delete(fileId);
        fileTransfersRef.current.get(fileId)?.close();
        fileTransfersRef.current.delete(fileId);
        setNotice('File transfer completed and verified by the recipient.');
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
        sourceFilesRef.current.delete(fileId);
        fileInfoRef.current.delete(fileId);
        fileTransfersRef.current.delete(fileId);
      },
    });
    fileTransfersRef.current.set(fileId, transfer);
    return transfer;
  }

  async function offerFile(file: File) {
    if (!selected || !deviceIdentity || fileSending || peerBlocked || !selected.peer.keyAvailable) return;
    setFileSending(true);
    setThreadError('');
    try {
      if (!Number.isSafeInteger(file.size)) throw new Error('This browser cannot safely transfer a file of this size.');
      const sha256 = await hashFile(file, (processed, total) => {
        if (processed === total || processed % (16 * 1024 * 1024) === 0) {
          setNotice(`Preparing encrypted file offer · ${Math.floor((processed / total) * 100)}%`);
        }
      });
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

  async function shareFolder(
    manifest: SharedFolderManifest,
    shareId: string,
    picked: PickedFolder,
  ): Promise<void> {
    const conversation = selected;
    if (!conversation || !deviceIdentity || peerBlocked || !conversation.peer.keyAvailable) {
      throw new Error('The conversation encryption key is not ready. Refresh the contact key and retry.')
    }
    const previewServer = previewServerRef.current
    if (!previewServer) throw new Error('The local folder preview service is not ready. Retry in a moment.')
    const fallbackFiles = fallbackFilesForManifest(picked, manifest)
    if (!picked.handle && fallbackFiles.size !== manifest.entries.filter(({ k }) => k === 'f').length) {
      throw new Error('The browser did not retain the selected files for preview. Please choose the folder again.')
    }
    if (picked.handle) await saveFolderHandle(shareId, picked.handle)
    const key = await derivePeerKey(
      deviceIdentity,
      conversation.id,
      conversation.peer.publicKey,
      'orbit-shared-folder-v1',
    )
    const encrypted = await encryptFolderManifest(manifest, key, conversation.id, shareId)
    try {
      await createSharedFolder(conversation.id, {
        id: shareId,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        formatVersion: 1,
        compressed: encrypted.compressed,
      })
      await previewServer.registerShare({
        shareId,
        conversation,
        manifest,
        handle: picked.handle,
        fallbackFiles: picked.handle ? undefined : fallbackFiles,
        persistHandle: false,
      })
    } catch (error) {
      if (picked.handle) await deleteFolderHandle(shareId)
      throw error
    }
    previewOwnerSharesRef.current.set(shareId, { manifest, conversation })
    setNotice('Folder structure shared end-to-end encrypted. No file contents were uploaded.')
    await refreshThread(true)
  }

  async function restorePreviewFolder(shareId: string): Promise<void> {
    const saved = previewOwnerSharesRef.current.get(shareId)
    const server = previewServerRef.current
    if (!saved || !server) return
    const controller = new AbortController()
    try {
      const picked = await pickFolder(controller.signal, () => undefined)
      if (!picked) return
      const rescanned = makeManifest(picked, true)
      if (!manifestsMatch(saved.manifest, rescanned)) {
        throw new Error('The selected folder does not match the shared folder structure.')
      }
      const fallbackFiles = fallbackFilesForManifest(picked, saved.manifest)
      if (!picked.handle && fallbackFiles.size !== saved.manifest.entries.filter(({ k }) => k === 'f').length) {
        throw new Error('The browser did not retain the selected files. Choose the folder again.')
      }
      await server.registerShare({
        shareId,
        conversation: saved.conversation,
        manifest: saved.manifest,
        handle: picked.handle,
        fallbackFiles: picked.handle ? undefined : fallbackFiles,
      })
      setPreviewOwnerNotice(null)
      setNotice('Folder preview access restored.')
    } catch (error) {
      setPreviewOwnerNotice({
        type: 'repick',
        shareId,
        message: error instanceof Error ? error.message : 'Could not restore access to this folder.',
      })
    }
  }

  async function regrantPreviewFolder(shareId: string): Promise<void> {
    try {
      const granted = await previewServerRef.current?.requestPermission(shareId)
      if (!granted) {
        await restorePreviewFolder(shareId)
        return
      }
      setPreviewOwnerNotice(null)
      setNotice('Folder access restored. Your contact can retry the preview.')
    } catch {
      setPreviewOwnerNotice({
        type: 'permission',
        shareId,
        message: 'Folder access could not be restored. Choose the folder again.',
      })
    }
  }

  async function stopSharingFolder(id: string): Promise<void> {
    try {
      await revokeSharedFolder(id)
      previewServerRef.current?.closeShare(id);
      previewSessionManagerRef.current?.closeShare(id);
      previewOwnerSharesRef.current.delete(id);
      setPreviewOwnerNotice((current) => current?.shareId === id ? null : current);
      setThreadMessages((current) => current.map((item) =>
        item.sharedFolder && item.sharedFolder.id === id
          ? { ...item, sharedFolder: { ...item.sharedFolder, status: 'revoked' } }
          : item,
      ))
      setNotice('Folder sharing stopped.')
      await refreshThread(true)
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : 'Could not stop sharing this folder.')
    }
  }

  async function acceptFile(item: ThreadMessage) {
    if (!selected || !deviceIdentity || !item.file || item.file.status !== 'offered') return;
    const size = Number(item.file.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      setThreadError('This file offer has an invalid size.');
      return;
    }
    if (!supportsFileSize(size)) {
      setThreadError('This browser cannot receive files larger than 64 MB. Use an up-to-date browser with site storage enabled.');
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
      const info = fileInfoRef.current.get(signal.fileId);
      const conversation = conversationsRef.current.find(({ id }) => id === conversationId);
      if (!file || !info || !conversation || !deviceIdentity) {
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
        await transfer.startSender(file);
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

  return <main
    className={`home-screen orbit-shell${selected ? ' has-selected-conversation' : ''}${conversations.length ? ' has-conversations' : ''}${navigationCollapsed ? ' is-navigation-collapsed' : ''}`}
    data-theme={workspaceAppearance === 'midnight' ? 'dark' : 'light'}
    data-appearance={workspaceAppearance}
    style={workspaceLayoutStyle}
  >
    {previewOwnerNotice && <aside className="orbit-preview-owner-banner" role="status">
      {previewOwnerNotice.type === 'activity'
        ? <span>{previewOwnerNotice.viewerName ?? 'Your contact'} is viewing <strong>{previewOwnerNotice.fileName ?? 'a file'}</strong>.</span>
        : previewOwnerNotice.type === 'permission'
          ? <span>{previewOwnerNotice.message ?? `Allow Orbit to access ‘${previewOwnerSharesRef.current.get(previewOwnerNotice.shareId)?.manifest.rootName ?? 'shared folder'}’ again.`}</span>
          : previewOwnerNotice.type === 'repick'
            ? <span>{previewOwnerNotice.message ?? `Choose ‘${previewOwnerSharesRef.current.get(previewOwnerNotice.shareId)?.manifest.rootName ?? 'the shared folder'}’ again to serve previews.`}</span>
            : <span>{previewOwnerNotice.message ?? 'Folder preview is temporarily unavailable.'}</span>}
      {previewOwnerNotice.type === 'activity'
        ? <button type="button" onClick={() => void stopSharingFolder(previewOwnerNotice.shareId)}>Stop sharing</button>
        : previewOwnerNotice.type === 'permission'
          ? <button type="button" onClick={() => void regrantPreviewFolder(previewOwnerNotice.shareId)}>Allow access</button>
          : previewOwnerNotice.type === 'repick'
            ? <button type="button" onClick={() => void restorePreviewFolder(previewOwnerNotice.shareId)}>Choose folder</button>
            : null}
    </aside>}
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
      collapsed={navigationCollapsed}
      onSelect={selectConversation}
      onToggleCollapsed={() => setNavigationCollapsed((collapsed) => !collapsed)}
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
      onSignOut={leaveSession}
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
        detailsOpen={detailsOpen}
        audioCall={audioCall}
        remoteAudioStream={remoteAudioStream}
        audioCallDisabled={Boolean(audioCall) || !deviceIdentity || !selected.peer.keyAvailable || peerBlocked || connection !== 'connected'}
        audioCallLabel={audioCall
          ? audioCall.peerId === selected.peer.id ? 'Call in progress' : 'Another call is active'
          : 'Start audio call'}
        deviceIdentity={deviceIdentity}
        previewSessionManager={previewSessionManagerRef.current!}
        onBack={() => setSelectedId(null)}
        onToggleNavigation={() => setNavigationCollapsed((collapsed) => !collapsed)}
        onToggleDetails={() => setDetailsOpen((open) => !open)}
        onRefreshPeerKey={() => void refreshPeerKey()}
        refreshingPeerKey={refreshingPeerKey}
        onStartAudioCall={() => void startAudioCall()}
        onAcceptAudioCall={acceptAudioCall}
        onDeclineAudioCall={() => finishAudioCall(true)}
        onCancelAudioCall={() => finishAudioCall(true)}
        onHangupAudioCall={() => finishAudioCall(true)}
        onToggleAudioMute={toggleAudioMute}
        onBlock={() => void blockSelectedUser()}
        onUnblock={() => void unblockContact(selected.peer.id)}
        onRetryThread={() => void refreshThread(true)}
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
        onShareFolder={shareFolder}
        onPreviewSignal={sendPreviewSignal}
        onRevokeFolder={(id) => void stopSharingFolder(id)}
        onReplyChange={setReplyTo}
        onDraftChange={setDraft}
        onRetryAllQueued={retryAllQueuedMessages}
        onSendMessage={(event) => void sendTextMessage(event)}
      />}
      {message && <p className="form-message home-message" role="alert">{message}</p>}
      {actionError && <p className="orbit-action-error" role="alert">{actionError}</p>}
    </section>

    {selected && detailsOpen && <>
      <button
        className="orbit-details-backdrop"
        type="button"
        aria-label="Close conversation details"
        onClick={() => setDetailsOpen(false)}
      />
      <WorkspaceDetails
        conversation={selected}
        user={user}
        messages={threadMessages}
        appearance={workspaceAppearance}
        onAppearanceChange={setWorkspaceAppearance}
        onClose={() => setDetailsOpen(false)}
        onCopyFingerprint={() => void copyFingerprint(user.fingerprint)}
        onJumpToMessage={(id) => {
          const target = document.getElementById(`orbit-message-${id}`);
          target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target?.focus({ preventScroll: true });
        }}
      />
    </>}

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
      onSignOut={leaveSession}
    />
  </main>;
}
