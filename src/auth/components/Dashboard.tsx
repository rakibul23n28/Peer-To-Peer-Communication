import { useEffect, useState } from 'react';
import type { ConversationSummary } from '../session';
import type { ClientAvailability, ClientPresenceStatus } from '../presenceStore';
import { getDownloadItems, subscribeDownloads, type DownloadItem } from '../shared-folders/downloadStore';
import type { ThreadMessage } from './ConversationThread';
import { IconButton } from './IconButton';
import { OrbitIcon } from './OrbitIcon';
import { PresenceIndicator } from './PresenceIndicator';

interface DashboardProps {
  userId: string;
  conversations: ConversationSummary[];
  previews: Record<string, string>;
  sharedMessages: ThreadMessage[];
  sharedFoldersError: string;
  presenceByUser: Record<string, ClientPresenceStatus>;
  availabilityByShare: Record<string, ClientAvailability>;
  deviceIdentityAvailable: boolean;
  compactDensity: boolean;
  connectionLabel: string;
  onOpenConversation: (id: string) => void;
  onFindSomeone: () => void;
  onShareFolder: () => void;
  onOpenActivity: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function relativeTime(value: string | null): string {
  if (!value) return 'No activity';
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsed < 60_000) return 'now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function Dashboard({
  userId,
  conversations,
  previews,
  sharedMessages,
  sharedFoldersError,
  presenceByUser,
  availabilityByShare,
  deviceIdentityAvailable,
  compactDensity,
  connectionLabel,
  onOpenConversation,
  onFindSomeone,
  onShareFolder,
  onOpenActivity,
}: DashboardProps) {
  const [downloads, setDownloads] = useState<DownloadItem[]>(getDownloadItems);
  useEffect(() => subscribeDownloads(() => setDownloads(getDownloadItems())), []);

  const activeDownloads = downloads.filter(({ progress }) =>
    !['completed', 'failed', 'canceled', 'interrupted'].includes(progress.state),
  );
  const onlineContacts = conversations.filter(({ peer }) =>
    presenceByUser[peer.id] === 'online',
  );
  const availableShares = Object.values(availabilityByShare).filter(({ state, ownerId }) =>
    state === 'available' && ownerId !== userId,
  );
  const needsAttention = [
    ...downloads.filter(({ progress }) =>
      ['failed', 'interrupted'].includes(progress.state),
    ).map(({ id, name, progress }) => ({
      id,
      label: `${name} · ${progress.state.replaceAll('_', ' ')}`,
      conversationId: undefined,
      source: 'downloads' as const,
    })),
    ...Object.values(availabilityByShare).filter(({ ownerId, state }) =>
      ownerId === userId && ['needs_permission', 'needs_reselect'].includes(state),
    ).map(({ shareId, state }) => ({
      id: shareId,
      label: state === 'needs_permission' ? 'A shared folder needs access again' : 'A shared folder needs to be selected again',
      conversationId: availabilityByShare[shareId]?.conversationId,
      source: 'share' as const,
    })),
  ];
  const folderMessages = sharedMessages.filter((message) =>
    message.kind === 'shared_folder' && message.sharedFolder?.status !== 'revoked',
  );
  const myFolders = folderMessages
    .filter(({ sharedFolder }) => sharedFolder?.ownerId === userId);
  const receivedFolders = folderMessages
    .filter(({ sharedFolder }) => sharedFolder?.ownerId !== userId);
  const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const renderFolderList = (messages: ThreadMessage[], emptyMessage: string) => messages.length
    ? <ul className="orbit-dashboard-list orbit-dashboard-folder-list">
      {messages.slice(0, 5).map(({ id, conversationId, sharedFolder }) => {
        const conversation = conversationById.get(conversationId);
        const availability = sharedFolder ? availabilityByShare[sharedFolder.id] : undefined;
        const status = sharedFolder?.status === 'error'
          ? 'Needs attention'
          : availability?.state === 'available'
            ? 'Available'
            : availability?.state === 'needs_permission'
              ? 'Needs permission'
              : availability?.state === 'needs_reselect'
                ? 'Needs folder'
                : availability?.state === 'unavailable'
                  ? 'Paused'
                  : sharedFolder?.status === 'ready' ? 'Shared' : 'Loading';
        return <li key={id} className="orbit-dashboard-folder-item">
          <span className="orbit-dashboard-file-icon"><OrbitIcon name="folderOpen" size={16} /></span>
          <span className="orbit-dashboard-folder-copy">
            <strong>{sharedFolder?.manifest?.rootName ?? 'Encrypted folder'}</strong>
            <small>
              {sharedFolder?.status === 'ready'
                ? `${conversation?.peer.displayName ?? 'Conversation'} · ${sharedFolder.fileCount ?? 0} files · ${sharedFolder.folderCount ?? 0} folders · ${formatBytes(sharedFolder.totalSize ?? 0)}`
                : `${conversation?.peer.displayName ?? 'Conversation'} · ${sharedFolder?.status === 'error' ? 'Could not decrypt folder' : 'Contents encrypted'}`}
            </small>
          </span>
          <span className={`orbit-dashboard-state${status === 'Available' ? ' is-ready' : status === 'Needs attention' ? ' is-error' : ''}`}>
            {status}
          </span>
          {conversation && <button
            type="button"
            className="orbit-dashboard-folder-open"
            onClick={() => onOpenConversation(conversation.id)}
          >Open chat</button>}
        </li>;
      })}
      {messages.length > 5 && <li className="orbit-dashboard-folder-more">
        +{messages.length - 5} more · Open a chat to view
      </li>}
    </ul>
    : <div className="orbit-dashboard-empty"><p>{emptyMessage}</p></div>;
  return <section className="orbit-dashboard" aria-labelledby="orbit-dashboard-title">
    <header className="orbit-dashboard-heading">
      <div>
        <p className="orbit-dashboard-kicker">ORBIT WORKSPACE</p>
        <h1 id="orbit-dashboard-title">Your workspace</h1>
      </div>
      <div className="orbit-dashboard-actions">
        <button type="button" className="orbit-dashboard-primary" onClick={onFindSomeone}>
          <OrbitIcon name="userPlus" size={17} />New chat
        </button>
      </div>
    </header>

    <div className="orbit-dashboard-grid" data-density={compactDensity ? 'compact' : 'comfortable'}>
      <section className="orbit-dashboard-card is-activity" aria-labelledby="orbit-dashboard-activity">
        <header><span className="orbit-dashboard-card-icon"><OrbitIcon name="list" /></span><h2 id="orbit-dashboard-activity">Live activity</h2><span className="orbit-dashboard-count">{activeDownloads.length}</span></header>
        {activeDownloads.length
          ? <ul className="orbit-dashboard-list">
            {activeDownloads.slice(0, 4).map(({ id, name, engine, progress }) => <li key={id} className="orbit-dashboard-transfer">
              <span className="orbit-dashboard-file-icon"><OrbitIcon name="file" size={16} /></span>
              <div className="orbit-dashboard-transfer-copy">
                <strong>{name}</strong>
                <small>{progress.state.replaceAll('_', ' ')} · {formatBytes(progress.bytesVerified)} of {formatBytes(progress.size)}</small>
                <div role="progressbar" aria-label={`${name} download progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
                  <span style={{ width: `${progress.percent}%` }} />
                </div>
              </div>
              <span className="orbit-dashboard-percent">{progress.percent}%</span>
              {engine && progress.state === 'downloading' && <IconButton action="pauseTransfer" onClick={() => engine.pause()} />}
              {engine && ['paused', 'waiting_for_peer'].includes(progress.state) && <IconButton action="resumeTransfer" onClick={() => { void engine.resume(); }} />}
              {engine && <IconButton action="cancelTransfer" onClick={() => { void engine.cancel(); }} />}
            </li>)}
          </ul>
          : <div className="orbit-dashboard-empty">
            <p>All clear. No transfers are underway.</p>
            <button type="button" onClick={onShareFolder}>Share folder</button>
          </div>}
      </section>

      <section className="orbit-dashboard-card" aria-labelledby="orbit-dashboard-people">
        <header><span className="orbit-dashboard-card-icon"><OrbitIcon name="user" /></span><h2 id="orbit-dashboard-people">People</h2><span className="orbit-dashboard-count">{onlineContacts.length} online</span></header>
        {conversations.length
          ? <ul className="orbit-dashboard-list">
            {conversations.filter(({ peer }) => presenceByUser[peer.id] !== 'offline').slice(0, 4).map(({ id, peer }) => <li key={id}>
              <button type="button" className="orbit-dashboard-person" onClick={() => onOpenConversation(id)}>
                <span className="orbit-dashboard-avatar">{peer.displayName.slice(0, 1).toUpperCase()}<PresenceIndicator status={presenceByUser[peer.id] ?? 'offline'} compact /></span>
                <span><strong>{peer.displayName}</strong><small>{presenceByUser[peer.id] ?? 'offline'}</small></span>
                {availableShares.some(({ ownerId }) => ownerId === peer.id) && <span className="orbit-dashboard-share-badge">Available share</span>}
              </button>
            </li>)}
          </ul>
          : <div className="orbit-dashboard-empty"><p>No conversations yet.</p><button type="button" onClick={onFindSomeone}>Find someone</button></div>}
        {conversations.length > 0 && onlineContacts.length === 0 && <p className="orbit-dashboard-note">No contacts are online right now.</p>}
      </section>

      <section className="orbit-dashboard-card orbit-dashboard-folders-card" aria-labelledby="orbit-dashboard-my-folders">
        <header><span className="orbit-dashboard-card-icon"><OrbitIcon name="folderOpen" /></span><h2 id="orbit-dashboard-my-folders">Shared by you</h2><span className="orbit-dashboard-count">{myFolders.length}</span></header>
        {sharedFoldersError && <p className="orbit-dashboard-note">{sharedFoldersError}</p>}
        {renderFolderList(myFolders, 'Folders you share will appear here.')}
        <button type="button" className="orbit-dashboard-folder-action" onClick={onShareFolder}>
          <OrbitIcon name="plus" size={14} /> Share a folder
        </button>
      </section>

      <section className="orbit-dashboard-card orbit-dashboard-folders-card" aria-labelledby="orbit-dashboard-received-folders">
        <header><span className="orbit-dashboard-card-icon"><OrbitIcon name="folderOpen" /></span><h2 id="orbit-dashboard-received-folders">Shared with you</h2><span className="orbit-dashboard-count">{receivedFolders.length}</span></header>
        {sharedFoldersError && <p className="orbit-dashboard-note">{sharedFoldersError}</p>}
        {renderFolderList(receivedFolders, 'Folders shared with you will appear here.')}
      </section>

      <section className="orbit-dashboard-card" aria-labelledby="orbit-dashboard-attention">
        <header><span className="orbit-dashboard-card-icon"><OrbitIcon name="alert" /></span><h2 id="orbit-dashboard-attention">Needs your attention</h2><span className="orbit-dashboard-count">{needsAttention.length}</span></header>
        {needsAttention.length
          ? <ul className="orbit-dashboard-list">
            {needsAttention.slice(0, 4).map(({ id, label, conversationId, source }) => <li key={id} className="orbit-dashboard-attention-row">
              <OrbitIcon name="alert" size={15} />
              <span>{label}</span>
              {conversationId
                ? <IconButton action="openFolder" label="Open conversation" onClick={() => onOpenConversation(conversationId)} />
                : <button className="orbit-dashboard-review" type="button" onClick={onOpenActivity}>Review</button>}
            </li>)}
          </ul>
          : <div className="orbit-dashboard-empty"><p>Nothing needs your attention.</p></div>}
      </section>

      <section className="orbit-dashboard-card is-recent" aria-labelledby="orbit-dashboard-recent">
        <header><span className="orbit-dashboard-card-icon"><OrbitIcon name="chat" /></span><h2 id="orbit-dashboard-recent">Recent conversations</h2><span className="orbit-dashboard-count">{conversations.length}</span></header>
        {conversations.length
          ? <ul className="orbit-dashboard-list">
            {[...conversations].sort((a, b) =>
              (b.lastMessage?.createdAt ?? '').localeCompare(a.lastMessage?.createdAt ?? ''),
            ).slice(0, 5).map(({ id, peer, lastMessage, unreadCount }) => <li key={id}>
              <button type="button" className="orbit-dashboard-recent-row" onClick={() => onOpenConversation(id)}>
                <span className="orbit-dashboard-avatar">{peer.displayName.slice(0, 1).toUpperCase()}<PresenceIndicator status={presenceByUser[peer.id] ?? 'offline'} compact /></span>
                <span className="orbit-dashboard-recent-copy"><strong>{peer.displayName}</strong><small>{previews[id] ?? 'No messages yet'}</small></span>
                <time dateTime={lastMessage?.createdAt ?? undefined}>{relativeTime(lastMessage?.createdAt ?? null)}</time>
                {unreadCount > 0 && <span className="orbit-dashboard-unread">{unreadCount > 99 ? '99+' : unreadCount}</span>}
              </button>
            </li>)}
          </ul>
          : <div className="orbit-dashboard-empty"><p>Your recent conversations will appear here.</p><button type="button" onClick={onFindSomeone}>Start a conversation</button></div>}
      </section>

      <section className="orbit-dashboard-card is-security" aria-labelledby="orbit-dashboard-security">
        <header><span className="orbit-dashboard-card-icon"><OrbitIcon name="shield" /></span><h2 id="orbit-dashboard-security">Privacy &amp; security</h2></header>
        <ul className="orbit-dashboard-security">
          <li><OrbitIcon name={deviceIdentityAvailable ? 'lock' : 'alert'} size={16} /><span>Device encryption key</span><strong>{deviceIdentityAvailable ? 'Ready' : 'Loading'}</strong></li>
          <li><OrbitIcon name={connectionLabel === 'Connected' ? 'check' : 'alert'} size={16} /><span>Connection</span><strong>{connectionLabel}</strong></li>
        </ul>
      </section>
    </div>
  </section>;
}
