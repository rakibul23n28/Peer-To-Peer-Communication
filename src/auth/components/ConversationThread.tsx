import { useEffect, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import type { ConversationSummary, EncryptedMessage, UserIdentity } from '../session';
import type { DeviceIdentity } from '../keyStore';
import type { OrbitConnectionState } from '../orbitSocket';
import { OrbitIcon } from './OrbitIcon';
import { IconButton } from './IconButton';
import { initials } from './OrbitMark';
import { AudioCallPanel, type AudioCallView } from './AudioCallPanel';
import type { SharedFolderEntry, SharedFolderRecord, SharedFolderManifest } from '../../shared/sharedFolders';
import type { PreviewSignal } from '../../shared/previewProtocol';
import { SharedFolderComposer } from '../shared-folders/SharedFolderComposer';
import { SharedFolderViewer } from '../shared-folders/SharedFolderViewer';
import type { PickedFolder } from '../shared-folders/picker';
import { PreviewPane } from '../shared-folders/PreviewPane';
import { PreviewSessionManager } from '../shared-folders/previewSession';
import { registerDownload, updateDownloadProgress } from '../shared-folders/downloadStore';
import { sanitizePathSegment } from '../shared-folders/downloadCore';
import { PresenceIndicator } from './PresenceIndicator';
import type { ClientAvailability, ClientPresenceStatus } from '../presenceStore';

export type SharedFolderTimelineItem = SharedFolderRecord & {
  status: 'pending' | 'ready' | 'error' | 'revoked';
  errorMessage?: string;
  manifest?: SharedFolderManifest;
  invalidCount?: number;
  fileCount?: number;
  folderCount?: number;
  totalSize?: number;
};

export type ThreadMessage = Omit<EncryptedMessage, 'kind'> & {
  kind: EncryptedMessage['kind'] | 'shared_folder';
  plaintext: string;
  decryptionError?: string;
  decryptedReactions: Array<{ userId: string; value: string }>;
  decryptedFileName?: string;
  sendState?: 'queued' | 'sending' | 'sent' | 'failed';
  sendError?: string;
  sharedFolder?: SharedFolderTimelineItem;
};

export type FileTransferProgress = { transferred: number; total: number; error?: string; verified?: boolean };
export type ReceivedFile = { name: string; blob: Blob; url: string };

interface ConversationThreadProps {
  conversation: ConversationSummary;
  user: UserIdentity;
  connection: OrbitConnectionState;
  deviceIdentityAvailable: boolean;
  peerBlocked: boolean;
  peerPresenceStatus: ClientPresenceStatus;
  availabilityByShare: Record<string, ClientAvailability>;
  viewersByShare: Record<string, Array<{ userId: string; since: number }>>;
  refreshingPeerKey: boolean;
  fileSending: boolean;
  filePickerRef: RefObject<HTMLInputElement | null>;
  threadMessages: ThreadMessage[];
  threadError: string;
  receivedFiles: Record<string, ReceivedFile>;
  fileProgress: Record<string, FileTransferProgress>;
  editingId: string | null;
  editDraft: string;
  replyTo: string | null;
  draft: string;
  sending: boolean;
  outboxCount: number;
  messageListRef: RefObject<HTMLElement | null>;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  detailsOpen: boolean;
  openFolderComposerRequest: boolean;
  onFolderComposerRequestHandled: () => void;
  audioCall: AudioCallView | null;
  remoteAudioStream: MediaStream | null;
  audioCallDisabled: boolean;
  audioCallLabel: string;
  deviceIdentity: DeviceIdentity | null;
  previewSessionManager: PreviewSessionManager;
  onBack: () => void;
  onToggleDetails: () => void;
  onRefreshPeerKey: () => void;
  onStartAudioCall: () => void;
  onAcceptAudioCall: () => Promise<void>;
  onDeclineAudioCall: () => void;
  onCancelAudioCall: () => void;
  onHangupAudioCall: () => void;
  onToggleAudioMute: () => void;
  onBlock: () => void;
  onUnblock: () => void;
  onRetryThread: () => void;
  onMessageListScroll: (nearBottom: boolean) => void;
  onLoadOlderMessages: () => void;
  onAcceptFile: (item: ThreadMessage) => void;
  onDeclineFile: (item: ThreadMessage) => void;
  onCancelFile: (item: ThreadMessage) => void;
  onEditDraftChange: (value: string) => void;
  onEditTextMessage: (item: ThreadMessage) => void;
  onCancelEdit: () => void;
  onRetryQueuedMessage: (clientMsgId: string) => void;
  onDeleteTextMessage: (item: ThreadMessage) => void;
  onStartEdit: (item: ThreadMessage) => void;
  onReply: (id: string) => void;
  onReact: (item: ThreadMessage, reaction: string) => void;
  onOfferFile: (file: File) => void;
  onShareFolder: (manifest: SharedFolderManifest, shareId: string, picked: PickedFolder, allowDownloads: boolean) => Promise<void>;
  onPreviewSignal: (signal: PreviewSignal) => void;
  onShareViewing: (shareId: string, viewing: boolean) => void;
  onRequestAccess: (shareId: string, kind: 'availability' | 'download_permission' | 'reshare') => void;
  watchedShareIds: Set<string>;
  onToggleWatch: (shareId: string) => void;
  onRevokeFolder: (id: string) => void;
  onReplyChange: (id: string | null) => void;
  onDraftChange: (value: string) => void;
  onRetryAllQueued: () => void;
  onSendMessage: (event: FormEvent<HTMLFormElement>) => void;
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function dayLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function shareAvailabilityLabel(
  status: SharedFolderTimelineItem['status'],
  availability: ClientAvailability | undefined,
  ownerName: string,
  ownerOnline: boolean,
): string {
  if (status === 'revoked') return 'No longer shared';
  if (status === 'pending') return 'Checking availability…';
  if (!ownerOnline) return 'Owner offline';
  if (!availability) return ownerOnline ? 'Checking availability…' : 'Owner offline';
  switch (availability.state) {
    case 'available': return 'Available';
    case 'needs_permission': return `${ownerName} needs to re-allow folder access`;
    case 'needs_reselect': return `${ownerName} needs to re-select the folder`;
    case 'unavailable': return 'Sharing paused';
    case 'revoked': return 'No longer shared';
  }
}

export function ConversationThread({
  conversation,
  user,
  connection,
  deviceIdentityAvailable,
  peerBlocked,
  peerPresenceStatus,
  availabilityByShare,
  viewersByShare,
  refreshingPeerKey,
  fileSending,
  filePickerRef,
  threadMessages,
  threadError,
  receivedFiles,
  fileProgress,
  editingId,
  editDraft,
  replyTo,
  draft,
  sending,
  outboxCount,
  messageListRef,
  hasOlderMessages,
  loadingOlderMessages,
  detailsOpen,
  openFolderComposerRequest,
  onFolderComposerRequestHandled,
  audioCall,
  remoteAudioStream,
  audioCallDisabled,
  audioCallLabel,
  deviceIdentity,
  previewSessionManager,
  onBack,
  onToggleDetails,
  onRefreshPeerKey,
  onStartAudioCall,
  onAcceptAudioCall,
  onDeclineAudioCall,
  onCancelAudioCall,
  onHangupAudioCall,
  onToggleAudioMute,
  onBlock,
  onUnblock,
  onRetryThread,
  onMessageListScroll,
  onLoadOlderMessages,
  onAcceptFile,
  onDeclineFile,
  onCancelFile,
  onEditDraftChange,
  onEditTextMessage,
  onCancelEdit,
  onRetryQueuedMessage,
  onDeleteTextMessage,
  onStartEdit,
  onReply,
  onReact,
  onOfferFile,
  onShareFolder,
  onPreviewSignal,
  onShareViewing,
  onRequestAccess,
  watchedShareIds,
  onToggleWatch,
  onRevokeFolder,
  onReplyChange,
  onDraftChange,
  onRetryAllQueued,
  onSendMessage,
}: ConversationThreadProps) {
  let previousDay = '';
  const [folderComposerOpen, setFolderComposerOpen] = useState(false);

  useEffect(() => {
    if (!openFolderComposerRequest) return;
    setFolderComposerOpen(true);
    onFolderComposerRequestHandled();
  }, [onFolderComposerRequestHandled, openFolderComposerRequest]);
  const [viewerShareId, setViewerShareId] = useState<string | null>(null);
  const [previewEntryId, setPreviewEntryId] = useState<number | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [remoteDownloadAllowed, setRemoteDownloadAllowed] = useState<boolean | null>(null);
  const [downloadStarter, setDownloadStarter] = useState<
    typeof import('../shared-folders/downloadEngine').startFileDownload | null
  >(null);
  const [folderDownloadStarter, setFolderDownloadStarter] = useState<
    typeof import('../shared-folders/downloadEngine').startFolderDownload | null
  >(null);
  const [folderDownloadProgress, setFolderDownloadProgress] = useState<{
    completedFiles: number;
    totalFiles: number;
    currentPath: string;
  } | null>(null);
  const attachButtonRef = useRef<HTMLButtonElement | null>(null);
  const viewerItem = threadMessages.find((item) => item.sharedFolder?.id === viewerShareId);
  const activeViewerShareId = viewerItem?.sharedFolder?.id;
  const activeViewerOwnerId = viewerItem?.sharedFolder?.ownerId;
  const viewerAvailability = viewerItem?.sharedFolder
    ? availabilityByShare[viewerItem.sharedFolder.id]
    : undefined;
  const viewerAccessMessage = viewerItem?.sharedFolder?.ownerId !== user.id
    ? viewerAvailability?.state === 'unavailable'
      ? 'The owner has paused this folder. You can ask them to open it again.'
      : viewerAvailability?.state === 'needs_permission'
        ? 'The owner needs to allow Orbit to access this folder again.'
        : viewerAvailability?.state === 'needs_reselect'
          ? 'The owner needs to choose this folder again before it can be opened.'
          : viewerAvailability?.state === 'revoked'
            ? 'This folder is no longer shared.'
            : viewerAvailability?.state === 'available' && !viewerAvailability.downloads
              ? 'Preview is available, but the owner has disabled downloads.'
              : viewerAvailability?.state === 'available' && !downloadStarter
                ? 'Downloads are preparing on this device.'
                        : viewerAvailability?.state === 'available' && viewerAvailability.downloads && remoteDownloadAllowed === null
                  ? 'Checking the owner’s download permission.'
                          : viewerAvailability?.state === 'available' && viewerAvailability.downloads && remoteDownloadAllowed === false
                            ? 'Downloads are not currently permitted by the owner.'
                        : viewerAvailability?.state === 'available'
                          ? undefined
                  : peerPresenceStatus === 'offline'
                    ? 'The folder owner is offline. Try again when they are online.'
                    : 'Checking whether the folder owner is available.'
    : undefined;
  const previewEntry: SharedFolderEntry | undefined = viewerItem?.sharedFolder?.manifest?.entries
    .find((entry) => entry.id === previewEntryId && entry.k === 'f');
  const parentPath = (path: string) => {
    const separator = path.lastIndexOf('/');
    return separator < 0 ? '' : path.slice(0, separator);
  };
  const previewSiblings = previewEntry && viewerItem?.sharedFolder?.manifest
    ? viewerItem.sharedFolder.manifest.entries.filter((entry) =>
        entry.k === 'f' && parentPath(entry.p) === parentPath(previewEntry.p),
      )
    : [];
  const previewSiblingIndex = previewSiblings.findIndex(({ id }) => id === previewEntry?.id);
  useEffect(() => {
    if (!viewerShareId || !activeViewerShareId || !activeViewerOwnerId ||
      activeViewerOwnerId === user.id) return;
    let hiddenTimer: number | null = null;
    const sendViewing = () => {
      if (document.visibilityState === 'visible') onShareViewing(viewerShareId, true);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenTimer = window.setTimeout(() => {
          onShareViewing(viewerShareId, false);
        }, 60_000);
      } else {
        if (hiddenTimer !== null) window.clearTimeout(hiddenTimer);
        hiddenTimer = null;
        sendViewing();
      }
    };
    sendViewing();
    const refresh = window.setInterval(sendViewing, 20_000);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(refresh);
      if (hiddenTimer !== null) window.clearTimeout(hiddenTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      onShareViewing(viewerShareId, false);
    };
  }, [activeViewerOwnerId, activeViewerShareId, onShareViewing, user.id, viewerShareId]);
  useEffect(() => {
    const shared = viewerItem?.sharedFolder
    if (!shared || shared.status !== 'ready' || shared.ownerId === user.id || !deviceIdentity) {
      setRemoteDownloadAllowed(false)
      return
    }
    setRemoteDownloadAllowed(null)
    let active = true
    void import('../shared-folders/downloadEngine').then(({ startFileDownload, startFolderDownload }) => {
      if (active) {
        setDownloadStarter(() => startFileDownload)
        setFolderDownloadStarter(() => startFolderDownload)
      }
    }).catch((error: unknown) => {
      if (active) setDownloadError(error instanceof Error ? error.message : 'Downloads could not be loaded.')
    })
    const session = previewSessionManager.open(shared.id, conversation, deviceIdentity, onPreviewSignal)
    const unsubscribe = session.subscribeDownloadCapabilities((caps) => setRemoteDownloadAllowed(caps.download))
    void session.getDownloadCapabilities().then((caps) => {
      setRemoteDownloadAllowed(caps.download)
    }).catch((error: unknown) => {
      setRemoteDownloadAllowed(false)
      setDownloadError(error instanceof Error ? error.message : 'Could not verify download access.')
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [conversation, deviceIdentity, onPreviewSignal, previewSessionManager, user.id, viewerItem?.sharedFolder])
  const downloadSharedFile = (entryId: number) => {
    const shared = viewerItem?.sharedFolder;
    const entry = shared?.manifest?.entries.find((item) => item.id === entryId && item.k === 'f');
    if (!shared || shared.ownerId === user.id || !entry || !deviceIdentity) return;
    if (!downloadStarter) {
      setDownloadError('Downloads are still loading. Try again in a moment.')
      return
    }
    setDownloadError('');
    const session = previewSessionManager.open(shared.id, conversation, deviceIdentity, onPreviewSignal);
    const name = entry.p.split('/').pop() ?? `file-${entry.id}`;
    void downloadStarter({
      session,
      info: {
        shareId: shared.id,
        conversation,
        entryId: entry.id,
        path: entry.p,
        size: entry.s ?? 0,
        mtime: entry.m,
      },
      localName: sanitizePathSegment(name, entry.id),
      onProgress: (progress, id) => updateDownloadProgress(id, progress),
      onCreated: (engine) => registerDownload(engine, name),
    }).catch((error: unknown) => {
      setDownloadError(error instanceof Error ? error.message : 'Could not start this download.');
    });
  };
  const retryDownloadAccess = () => {
    const shared = viewerItem?.sharedFolder;
    if (!shared || !deviceIdentity) return;
    setDownloadError('');
    setRemoteDownloadAllowed(null);
    const session = previewSessionManager.open(shared.id, conversation, deviceIdentity, onPreviewSignal);
    void session.getDownloadCapabilities().then((caps) => {
      setRemoteDownloadAllowed(caps.download);
      if (!caps.download) setDownloadError('The owner has disabled downloads for this folder.');
    }).catch((error: unknown) => {
      setRemoteDownloadAllowed(false);
      setDownloadError(error instanceof Error ? error.message : 'Could not verify download access.');
    });
  };

  const downloadSharedFolder = () => {
    const shared = viewerItem?.sharedFolder;
    if (!shared?.manifest || shared.ownerId === user.id || !deviceIdentity) return;
    if (!folderDownloadStarter) {
      setDownloadError('Folder downloads are still loading. Try again in a moment.');
      return;
    }
    setDownloadError('');
    setFolderDownloadProgress({
      completedFiles: 0,
      totalFiles: shared.manifest.entries.filter(({ k }) => k === 'f').length,
      currentPath: '',
    });
    const session = previewSessionManager.open(shared.id, conversation, deviceIdentity, onPreviewSignal);
    void folderDownloadStarter({
      session,
      info: { shareId: shared.id, conversation },
      manifest: shared.manifest,
      onProgress: (completedFiles, totalFiles, currentPath) => {
        setFolderDownloadProgress({ completedFiles, totalFiles, currentPath });
      },
      onFileProgress: (progress, id) => updateDownloadProgress(id, progress),
      onCreated: (engine, path) => registerDownload(engine, path),
    }).then(() => {
      setFolderDownloadProgress(null);
    }).catch((error: unknown) => {
      setFolderDownloadProgress(null);
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setDownloadError(error instanceof Error ? error.message : 'The folder download could not be completed.');
    });
  };

  return <div className="orbit-thread">
    <header className="orbit-thread-header">
      <button className="orbit-thread-back" type="button" onClick={onBack} aria-label="Back to conversations">
        <OrbitIcon name="back" />
      </button>
      <span className="orbit-avatar orbit-thread-avatar">{initials(conversation.peer.displayName)}<PresenceIndicator status={peerPresenceStatus} compact /></span>
      <div className="orbit-thread-person">
        <h1>{conversation.peer.displayName}</h1>
        <PresenceIndicator status={peerPresenceStatus} />
      </div>
      <div className={`orbit-thread-actions${audioCall ? ' has-audio-call' : ''}`}>
        {audioCall
          ? <AudioCallPanel
              call={audioCall}
              remoteStream={remoteAudioStream}
              onAccept={onAcceptAudioCall}
              onDecline={onDeclineAudioCall}
              onCancel={onCancelAudioCall}
              onHangup={onHangupAudioCall}
              onToggleMute={onToggleAudioMute}
            />
          : <IconButton action="call" className="orbit-audio-call-button" label={audioCallLabel} onClick={onStartAudioCall} disabled={audioCallDisabled} />}
        <IconButton
          action="toggleInspector"
          className={`orbit-details-toggle${detailsOpen ? ' is-active' : ''}`}
          label={detailsOpen ? 'Hide conversation details' : 'Show conversation details'}
          onClick={onToggleDetails}
          pressed={detailsOpen}
          aria-expanded={detailsOpen}
          aria-controls="orbit-details-panel"
        />
        {!peerBlocked && <IconButton action="blockContact" className="orbit-thread-block" onClick={onBlock} />}
      </div>
    </header>

    {peerBlocked && <div className="orbit-blocked-banner" role="status">
      <span>You blocked @{conversation.peer.username}. Messages and files are paused.</span>
      <button type="button" onClick={onUnblock}>Unblock</button>
    </div>}
    {!conversation.peer.keyAvailable && <div className="orbit-key-warning" role="status">
      <span><strong>Encryption key unavailable.</strong> Ask @{conversation.peer.username} to sign in and restore their device key, then refresh.</span>
      <button type="button" disabled={refreshingPeerKey} onClick={onRefreshPeerKey}>
        {refreshingPeerKey ? 'Checking…' : 'Refresh key'}
      </button>
    </div>}
    <section ref={messageListRef} className="orbit-message-list" aria-label="Encrypted messages" aria-live="polite" onScroll={(event) => {
      const element = event.currentTarget;
      if (element.scrollTop <= 72 && hasOlderMessages && !loadingOlderMessages) onLoadOlderMessages();
      onMessageListScroll(element.scrollHeight - element.scrollTop - element.clientHeight < 96);
    }}>
      {(hasOlderMessages || loadingOlderMessages) && <div className="orbit-history-loader" role="status">
        <span className={loadingOlderMessages ? 'is-loading' : ''} />
        {loadingOlderMessages ? 'Loading earlier messages' : 'Scroll up for earlier messages'}
      </div>}
      {threadMessages.length === 0 && !threadError && <div className="orbit-thread-empty">
        <span className="orbit-empty-glyph"><OrbitIcon name="spark" size={23} /></span>
        <span className="eyebrow">A PRIVATE SPACE FOR TWO</span>
        <p>No messages yet. Send a note to start your conversation.</p>
      </div>}
      {threadError && <div className="orbit-thread-error" role="alert">{threadError}<button type="button" onClick={onRetryThread}>Retry</button></div>}
      {threadMessages.map((item) => {
        const currentDay = new Date(item.createdAt).toDateString();
        const showDay = currentDay !== previousDay;
        previousDay = currentDay;
        const reactionGroups = item.decryptedReactions.reduce<Array<{ value: string; count: number; mine: boolean }>>((groups, reaction) => {
          const group = groups.find(({ value }) => value === reaction.value);
          if (group) {
            group.count += 1;
            group.mine ||= reaction.userId === user.id;
          } else {
            groups.push({ value: reaction.value, count: 1, mine: reaction.userId === user.id });
          }
          return groups;
        }, []);
        return <div className="orbit-message-row" key={item.id} id={`orbit-message-${item.id}`} tabIndex={-1}>
          {showDay && <div className="orbit-day-divider"><span>{dayLabel(item.createdAt)}</span></div>}
          <article className={`orbit-message${item.senderId === user.id ? ' is-own' : ''}${item.sendState ? ` is-${item.sendState}` : ''}${item.kind === 'file' ? ' is-file-message' : ''}${item.kind === 'shared_folder' ? ' is-folder-message' : ''}`}>
            {item.replyToId && <span className="orbit-reply-caption">REPLY TO / {item.replyToId.slice(0, 8)}</span>}
            {item.kind === 'shared_folder' && item.sharedFolder ? <div className="orbit-shared-folder-card">
              <div className="orbit-shared-folder-heading">
                <span className="orbit-shared-folder-icon"><OrbitIcon name="tree" /></span>
                <div>
                  <strong>{item.senderId === user.id ? 'You shared a folder' : `${conversation.peer.displayName} shared a folder`}</strong>
                  <small className="orbit-share-availability" role="status">
                    {shareAvailabilityLabel(
                      item.sharedFolder.status,
                      availabilityByShare[item.sharedFolder.id],
                      conversation.peer.displayName,
                      peerPresenceStatus !== 'offline',
                    )}
                  </small>
                  {item.sharedFolder.status === 'ready' && item.sharedFolder.manifest
                    ? <small>{item.sharedFolder.manifest.rootName} · {item.sharedFolder.fileCount?.toLocaleString()} files · {item.sharedFolder.folderCount?.toLocaleString()} folders · {formatFileSize(item.sharedFolder.totalSize ?? 0)}</small>
                    : <small>{item.sharedFolder.status === 'pending' ? 'Opening encrypted folder…' : item.sharedFolder.status === 'revoked' ? 'This folder is no longer shared' : "Couldn't open this shared folder"}</small>}
                  {item.senderId === user.id && viewersByShare[item.sharedFolder.id]?.some(
                    (viewer) => viewer.userId === conversation.peer.id,
                  ) && <small>{conversation.peer.displayName} is browsing</small>}
                </div>
              </div>
              {item.sharedFolder.status === 'pending' && <div className="orbit-folder-card-skeleton" aria-hidden="true"><span /><span /></div>}
              {item.sharedFolder.status === 'error' && <div className="orbit-folder-card-error" role="alert">
                <span>{item.sharedFolder.errorMessage ?? "Couldn't open this shared folder"}</span>
                <button type="button" onClick={onRetryThread}>Retry</button>
              </div>}
              {item.sharedFolder.status === 'revoked' && <div className="orbit-folder-card-revoked" role="status">
                <span>This folder is no longer shared.</span>
                {item.senderId !== user.id && <button type="button" onClick={() => onRequestAccess(item.sharedFolder!.id, 'reshare')}>Ask {conversation.peer.displayName} to share again</button>}
              </div>}
              {item.sharedFolder.status === 'ready' && <div className="orbit-shared-folder-actions">
                <IconButton action="openFolder" onClick={() => setViewerShareId(item.sharedFolder!.id)} />
                {item.senderId !== user.id && availabilityByShare[item.sharedFolder.id]?.state !== 'available' &&
                  <IconButton
                    action="requestAccess"
                    label={`Ask ${conversation.peer.displayName} to open the folder`}
                    onClick={() => onRequestAccess(item.sharedFolder!.id, 'availability')}
                  />}
                {item.senderId !== user.id && availabilityByShare[item.sharedFolder.id]?.state !== 'available' && <IconButton
                  action="notifyShare"
                  label={watchedShareIds.has(item.sharedFolder.id) ? 'Stop notifications' : 'Notify me when available'}
                  pressed={watchedShareIds.has(item.sharedFolder.id)}
                  onClick={() => onToggleWatch(item.sharedFolder!.id)}
                />}
                {item.senderId !== user.id && availabilityByShare[item.sharedFolder.id]?.state === 'available' &&
                  availabilityByShare[item.sharedFolder.id]?.downloads === false &&
                  <IconButton
                    action="requestAccess"
                    label="Ask for download permission"
                    onClick={() => onRequestAccess(item.sharedFolder!.id, 'download_permission')}
                  />}
                {item.senderId === user.id && <IconButton
                  action="stopSharing"
                  label={`Stop sharing ${item.sharedFolder.manifest?.rootName ?? 'this folder'}`}
                  onClick={() => onRevokeFolder(item.sharedFolder!.id)}
                />}
              </div>}
            </div> : item.kind === 'file' && item.file ? <div className="orbit-file-card">
              <div className="orbit-file-card-heading">
                <span aria-hidden="true"><OrbitIcon name="file" /></span>
                <div><strong>{item.decryptedFileName ?? 'Encrypted file'}</strong><small>{formatFileSize(Number(item.file.size))} · {item.file.mime}</small></div>
              </div>
              {(() => {
                const progress = fileProgress[item.file.fileId];
                const total = Number(item.file.size);
                const transferring = item.file.status === 'transferring' || item.file.status === 'accepted';
                const verifiedBytes = Boolean(progress && progress.total > 0 && progress.transferred > 0);
                const percentage = verifiedBytes
                  ? Math.min(100, Math.round((progress.transferred / Math.max(progress.total, 1)) * 100))
                  : 0;
                const complete = item.file.status === 'received' || progress?.verified === true;
                const waiting = item.file.status === 'offered';
                const error = progress?.error;
                const label = complete
                  ? 'Verified'
                  : error
                    ? 'Transfer failed'
                    : waiting
                      ? item.senderId === user.id ? 'Waiting for acceptance' : 'Ready to share'
                      : item.file.status === 'accepted'
                        ? 'Connecting'
                        : !verifiedBytes
                          ? 'Connecting'
                        : percentage >= 100
                          ? 'Verifying'
                          : 'Sending';
                const detail = complete
                  ? 'Ready'
                  : error
                    ? error
                    : item.file.status === 'failed'
                      ? 'Retry with a TURN relay'
                      : waiting
                        ? item.senderId === user.id ? '' : 'Accept to receive'
                        : item.file.status === 'accepted'
                          ? 'Secure peer connection'
                        : !verifiedBytes
                          ? 'Secure peer connection'
                        : percentage >= 100
                          ? 'Checking file'
                          : `${percentage}% · ${formatFileSize(progress?.transferred ?? 0)} / ${formatFileSize(total)}`;
                return <div className={`orbit-transfer-status${error ? ' has-error' : ''}${complete ? ' is-complete' : ''}`} role={error ? 'alert' : 'status'}>
                  <span className={`orbit-transfer-mark${transferring && !error && !complete ? ' is-active' : ''}`}>
                    {complete ? <OrbitIcon name="check" size={14} /> : error || item.file.status === 'failed' ? <OrbitIcon name="close" size={14} /> : <OrbitIcon name={waiting ? 'file' : 'link'} size={14} />}
                  </span>
                  <span className="orbit-transfer-copy"><strong>{label}</strong>{detail && <small>{detail}</small>}</span>
                  {transferring && !error && !complete && <span className={`orbit-transfer-track${verifiedBytes && percentage < 100 ? ' is-determinate' : ' is-indeterminate'}`} aria-label={verifiedBytes ? `${percentage}% transferred` : 'Connecting'}>
                    <span style={verifiedBytes && percentage < 100 ? { width: `${percentage}%` } : undefined} />
                  </span>}
                </div>;
              })()}
              {receivedFiles[item.file.fileId] && item.file.mime.startsWith('image/') && <img className="orbit-file-preview" src={receivedFiles[item.file.fileId].url} alt={item.decryptedFileName ?? 'Shared image'} />}
              {receivedFiles[item.file.fileId] && item.file.mime.startsWith('video/') && <video className="orbit-file-preview" src={receivedFiles[item.file.fileId].url} controls />}
              {receivedFiles[item.file.fileId] && item.file.mime.startsWith('audio/') && <audio className="orbit-file-audio" src={receivedFiles[item.file.fileId].url} controls />}
              <div className="orbit-file-card-footer">
                {receivedFiles[item.file.fileId] && <a className="orbit-icon-button" href={receivedFiles[item.file.fileId].url} download={receivedFiles[item.file.fileId].name} aria-label={`Download ${receivedFiles[item.file.fileId].name}`}><OrbitIcon name="download" /></a>}
                {item.senderId !== user.id && item.file.status === 'offered' && <>
                  <IconButton action="acceptFile" onClick={() => onAcceptFile(item)} />
                  <IconButton action="declineFile" onClick={() => onDeclineFile(item)} />
                </>}
                {item.file.status === 'offered' && item.senderId === user.id && <IconButton action="cancelTransfer" label="Cancel file offer" onClick={() => onCancelFile(item)} />}
                {(item.file.status === 'accepted' || item.file.status === 'transferring') && <IconButton action="cancelTransfer" label="Cancel file transfer" onClick={() => onCancelFile(item)} />}
              </div>
            </div> : editingId === item.id ? <div className="orbit-edit-form">
              <textarea aria-label="Edit message" value={editDraft} onChange={(event) => onEditDraftChange(event.target.value)} />
              <button type="button" onClick={() => onEditTextMessage(item)}>Save edit</button>
              <button type="button" onClick={onCancelEdit}>Cancel</button>
            </div> : <p className={item.decryptionError ? 'orbit-message-undecryptable' : undefined} title={item.decryptionError}>
              {item.decryptionError ? 'Encrypted message · key unavailable on this device' : item.plaintext}
            </p>}
            <div className="orbit-message-meta-row">
              <footer>
                {item.senderId === user.id && <span className="orbit-message-status" title={item.sendState === 'failed' ? "Couldn't send" : item.sendState === 'queued' ? 'Queued' : item.sendState === 'sending' ? 'Sending' : item.receipts.some((entry) => entry.status === 'read') ? 'Seen' : item.receipts.some((entry) => entry.status === 'delivered') ? 'Delivered' : 'Sent'}>
                  {item.sendState === 'failed'
                    ? <><OrbitIcon name="close" size={13} /><span className="orbit-visually-hidden">Could not send</span></>
                    : item.sendState === 'queued' || item.sendState === 'sending'
                      ? <><span className="orbit-sending-indicator" /><span className="orbit-visually-hidden">{item.sendState === 'queued' ? 'Queued' : 'Sending'}</span></>
                      : item.receipts.some((entry) => entry.status === 'read')
                        ? <><OrbitIcon name="checkDouble" size={14} /><span className="orbit-visually-hidden">Seen</span></>
                        : item.receipts.some((entry) => entry.status === 'delivered')
                          ? <><OrbitIcon name="checkDouble" size={14} /><span className="orbit-visually-hidden">Delivered</span></>
                          : <><OrbitIcon name="check" size={14} /><span className="orbit-visually-hidden">Sent</span></>}
                </span>}
                <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{item.editedAt ? ' · edited' : ''}</time>
              </footer>
              {reactionGroups.length > 0 && <div className="orbit-reaction-list" aria-label="Message reactions">
              {reactionGroups.map((reaction) => <button
                className={`orbit-reaction-pill${reaction.mine ? ' is-mine' : ''}`}
                type="button"
                disabled={!conversation.peer.keyAvailable}
                key={reaction.value}
                aria-pressed={reaction.mine}
                aria-label={`${reaction.value}, ${reaction.count} ${reaction.count === 1 ? 'reaction' : 'reactions'}${reaction.mine ? ', yours' : ''}`}
                title={reaction.mine ? 'Remove your reaction' : 'React with ' + reaction.value}
                onClick={() => onReact(item, reaction.value)}
              >
                {reaction.value === '❤️' ? <OrbitIcon name="heart" size={13} /> : <span>{reaction.value}</span>}
                <span>{reaction.count}</span>
              </button>)}
              </div>}
              {!item.deletedAt && item.kind !== 'shared_folder' && <div className="orbit-message-actions" aria-label="Message actions">
                {item.senderId === user.id && !item.sendState && <>
                  <IconButton action="editMessage" onClick={() => onStartEdit(item)} disabled={!conversation.peer.keyAvailable} />
                  <IconButton action="deleteMessage" className="is-destructive" onClick={() => onDeleteTextMessage(item)} />
                </>}
                <IconButton action="reply" label="Reply to message" onClick={() => onReply(item.id)} />
                {(() => {
                  const hasHeart = item.decryptedReactions.some((reaction) => reaction.userId === user.id && reaction.value === '❤️');
                  return <IconButton action="react" className={`orbit-heart-action${hasHeart ? ' is-active' : ''}`} label={hasHeart ? 'Remove your heart reaction' : 'React with heart'} pressed={hasHeart} onClick={() => onReact(item, '❤️')} />;
                })()}
              </div>}
            </div>
            {item.senderId === user.id && item.sendState === 'failed' && <div className="orbit-message-error" role="alert">
              <span>{item.sendError ?? 'Could not send this message.'}</span>
              <IconButton action="retry" label="Retry sending message" disabled={!conversation.peer.keyAvailable} onClick={() => onRetryQueuedMessage(item.clientMsgId)} />
            </div>}
          </article>
        </div>;
      })}
    </section>

    <form className="orbit-composer" onSubmit={onSendMessage}>
      <input ref={filePickerRef} className="orbit-file-picker" type="file" aria-label="Choose a file or media" onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        if (file) onOfferFile(file);
        event.currentTarget.value = '';
      }} />
      {replyTo && <div className="orbit-replying">Replying to {threadMessages.find((item) => item.id === replyTo)?.plaintext.slice(0, 80) ?? 'message'}<IconButton action="close" label="Cancel reply" onClick={() => onReplyChange(null)} /></div>}
      <textarea value={draft} onChange={(event) => onDraftChange(event.target.value)} maxLength={8000} aria-label="Message" placeholder={peerBlocked ? 'Unblock this contact to send messages…' : !conversation.peer.keyAvailable ? "Waiting for your contact's encryption key…" : deviceIdentityAvailable ? 'Write an encrypted message…' : 'Loading your device key…'} disabled={!deviceIdentityAvailable || !conversation.peer.keyAvailable || peerBlocked} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} />
      <div className="orbit-composer-bottom">
        <span>{outboxCount > 0 ? `${outboxCount} encrypted message${outboxCount === 1 ? '' : 's'} in outbox` : 'End-to-end encrypted · Enter to send'}</span>
        {outboxCount > 0 && <button className="orbit-outbox-retry" type="button" disabled={connection !== 'connected' || !conversation.peer.keyAvailable} onClick={onRetryAllQueued}>Retry queued</button>}
        <IconButton
          action="attach"
          className="orbit-attach-action"
          ref={attachButtonRef}
          label="Open attachment options"
          disabled={!deviceIdentityAvailable || !conversation.peer.keyAvailable || peerBlocked}
          onClick={() => setAttachMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={attachMenuOpen}
        />
        {attachMenuOpen && <div className="orbit-attach-menu" role="menu" aria-label="Attachment options" onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setAttachMenuOpen(false);
            attachButtonRef.current?.focus();
          }
        }}>
          <button type="button" role="menuitem" disabled={fileSending} onClick={() => {
            setAttachMenuOpen(false);
            filePickerRef.current?.click();
          }}>
            <OrbitIcon name="file" /><span>{fileSending ? 'Preparing…' : 'Attach file'}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => {
            setAttachMenuOpen(false);
            setFolderComposerOpen(true);
          }}>
            <OrbitIcon name="tree" /><span>Share folder</span>
          </button>
        </div>}
        <button className="orbit-primary-action" type="submit" disabled={!draft.trim() || sending || !deviceIdentityAvailable || !conversation.peer.keyAvailable || peerBlocked}>
          <span className="orbit-button-text">{sending ? 'Sending…' : 'Send'}</span><OrbitIcon name="send" size={16}  />
        </button>
      </div>
    </form>
    {folderComposerOpen && <SharedFolderComposer
      peerName={conversation.peer.displayName}
      disabled={!deviceIdentityAvailable || !conversation.peer.keyAvailable || peerBlocked}
      onShare={onShareFolder}
      onClose={() => setFolderComposerOpen(false)}
    />}
    {viewerItem?.sharedFolder?.status === 'ready' && viewerItem.sharedFolder.manifest && <SharedFolderViewer
      manifest={viewerItem.sharedFolder.manifest}
      invalidCount={viewerItem.sharedFolder.invalidCount ?? 0}
      accessMessage={viewerAccessMessage}
      downloadError={downloadError}
      onRetryDownload={retryDownloadAccess}
      onRequestAccess={() => onRequestAccess(
        viewerItem.sharedFolder!.id,
        viewerAvailability?.state === 'available' &&
          (viewerAvailability.downloads === false || remoteDownloadAllowed === false)
          ? 'download_permission'
          : 'availability',
      )}
      onClose={() => setViewerShareId(null)}
      onDownloadFolder={downloadSharedFolder}
      folderDownloadProgress={folderDownloadProgress}
      previewDisabled={viewerItem.sharedFolder.ownerId === user.id || viewerAvailability?.state !== 'available'}
      onPreviewFile={(entryId) => setPreviewEntryId(entryId)}
      onDownloadFile={downloadSharedFile}
      downloadDisabled={viewerItem.sharedFolder.ownerId === user.id || !deviceIdentity || remoteDownloadAllowed !== true || !downloadStarter || !folderDownloadStarter || viewerAvailability?.state !== 'available' || !viewerAvailability.downloads}
    />}
    {downloadError && <p className="orbit-download-error" role="alert">{downloadError}</p>}
    {viewerItem?.sharedFolder?.status === 'ready' &&
      viewerItem.sharedFolder.ownerId !== user.id &&
      previewEntry &&
      deviceIdentity && <PreviewPane
        key={`${previewEntry.id}:${viewerAvailability?.state ?? 'unknown'}:${viewerAvailability?.since ?? 0}`}
        shareId={viewerItem.sharedFolder.id}
        conversation={conversation}
        identity={deviceIdentity}
        entry={previewEntry}
        previousEntry={previewSiblingIndex > 0 ? previewSiblings[previewSiblingIndex - 1] : undefined}
        nextEntry={previewSiblingIndex >= 0 ? previewSiblings[previewSiblingIndex + 1] : undefined}
        sessionManager={previewSessionManager}
        onDownload={remoteDownloadAllowed === true && downloadStarter && viewerAvailability?.state === 'available' && viewerAvailability.downloads
          ? () => downloadSharedFile(previewEntry.id)
          : undefined}
        onSignal={onPreviewSignal}
        onNavigate={(entryId) => setPreviewEntryId(entryId)}
        onClose={() => setPreviewEntryId(null)}
      />}
    {viewerItem?.sharedFolder?.status === 'revoked' && <div className="orbit-folder-backdrop" role="presentation">
      <section className="orbit-folder-dialog" role="dialog" aria-modal="true" aria-labelledby="orbit-folder-revoked-title">
        <h2 id="orbit-folder-revoked-title">This folder is no longer shared</h2>
        <button type="button" onClick={() => setViewerShareId(null)}>Close</button>
      </section>
    </div>}
  </div>;
}
