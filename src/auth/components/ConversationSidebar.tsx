import { useState } from 'react';
import type { ConversationSummary, UserIdentity } from '../session';
import type { OrbitConnectionState } from '../orbitSocket';
import { OrbitMark, initials } from './OrbitMark';
import { OrbitIcon } from './OrbitIcon';
import { PresenceIndicator } from './PresenceIndicator';
import type { ClientPresenceStatus } from '../presenceStore';

interface ConversationSidebarProps {
  workspaceView: 'dashboard' | 'chats' | 'activity' | 'details';
  user: UserIdentity;
  busy: boolean;
  conversations: ConversationSummary[];
  selectedId: string | null;
  previews: Record<string, string>;
  presenceByUser: Record<string, ClientPresenceStatus>;
  loading: boolean;
  error: string;
  connection: OrbitConnectionState;
  connectionError: string;
  onChangeWorkspaceView: (view: 'dashboard' | 'chats' | 'activity') => void;
  onSelect: (id: string) => void;
  onRetryConversations: () => void;
  onRetryConnection: () => void;
  onFindSomeone: () => void;
  onSendFile: () => void;
  onCopyFingerprint: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}

function connectionLabel(state: OrbitConnectionState): string {
  if (state === 'connected') return 'Connected';
  if (state === 'connecting') return 'Connecting';
  if (state === 'auth_failed') return 'Session expired';
  if (state === 'reconnecting') return 'Reconnecting';
  if (state === 'idle') return 'Idle';
  return 'Offline';
}

function messageTime(value: string | null): string {
  if (!value) return '';
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function ConversationSidebar({
  workspaceView,
  user,
  busy,
  conversations,
  selectedId,
  previews,
  presenceByUser,
  loading,
  error,
  connection,
  connectionError,
  onChangeWorkspaceView,
  onSelect,
  onRetryConversations,
  onRetryConnection,
  onFindSomeone,
  onSendFile,
  onCopyFingerprint,
  onOpenSettings,
  onSignOut,
}: ConversationSidebarProps) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const hasConnectionIssue = connection === 'offline' || connection === 'reconnecting' || connection === 'auth_failed';
  const onlineConversations = conversations.filter(({ peer }) => presenceByUser[peer.id] === 'online');

  return <aside className="orbit-sidebar" aria-label="People and conversations">
    <a className="home-brand" href="/" aria-label="Orbit home"><OrbitMark /> orbit<span>.</span></a>
    <nav className="orbit-sidebar-workspace-nav" aria-label="Workspace pages">
      <button type="button" className={workspaceView === 'dashboard' ? 'is-active' : ''} aria-current={workspaceView === 'dashboard' ? 'page' : undefined} onClick={() => onChangeWorkspaceView('dashboard')}><OrbitIcon name="grid" size={16} /><span>Home</span></button>
      <button type="button" className={workspaceView === 'chats' || workspaceView === 'details' ? 'is-active' : ''} aria-current={workspaceView === 'chats' || workspaceView === 'details' ? 'page' : undefined} onClick={() => onChangeWorkspaceView('chats')}><OrbitIcon name="chat" size={16} /><span>People</span></button>
      <button type="button" className={workspaceView === 'activity' ? 'is-active' : ''} aria-current={workspaceView === 'activity' ? 'page' : undefined} onClick={() => onChangeWorkspaceView('activity')}><OrbitIcon name="list" size={16} /><span>Downloads</span></button>
    </nav>
    <div className="orbit-sidebar-heading">
      <span className="orbit-list-title">Your people</span>
      <div className="orbit-add-wrap">
        <button className="orbit-add" type="button" aria-label="New conversation or send a file" aria-haspopup="true" aria-expanded={addMenuOpen} aria-controls="orbit-add-menu" onClick={() => setAddMenuOpen((open) => !open)}><OrbitIcon name="plus" size={17} /></button>
        {addMenuOpen && <div className="orbit-popover" id="orbit-add-menu">
          <button type="button" onClick={() => { onFindSomeone(); setAddMenuOpen(false); }}><OrbitIcon name="search" size={15} />Find someone by username</button>
          <button type="button" onClick={() => { onSendFile(); setAddMenuOpen(false); }}><OrbitIcon name="paperclip" size={15} />Send a file</button>
        </div>}
      </div>
    </div>
    {onlineConversations.length > 0 && <div className="orbit-people-online" aria-label="Online contacts">
      {onlineConversations.slice(0, 8).map(({ id, peer }) => <button
        type="button"
        key={id}
        aria-label={`Open chat with ${peer.displayName}, online`}
        title={`${peer.displayName} · online`}
        onClick={() => onSelect(id)}
      >
        <span className="orbit-avatar">{initials(peer.displayName)}<PresenceIndicator status="online" compact /></span>
      </button>)}
      {onlineConversations.length > 8 && <span className="orbit-people-overflow">+{onlineConversations.length - 8}</span>}
    </div>}
    <p className="orbit-people-section-label">Recent conversations</p>
    <div className="orbit-conversation-list">
      {loading && <p className="orbit-list-note">Loading conversations…</p>}
      {error && <div className="orbit-inline-error" role="alert"><span>{error}</span><button type="button" onClick={onRetryConversations}>Retry</button></div>}
      {conversations.map(({ id, peer, lastMessage, unreadCount }) => <button
        className={`orbit-conversation${selectedId === id ? ' is-selected' : ''}`}
        type="button"
        key={id}
        aria-label={`Conversation with ${peer.displayName}${unreadCount ? `, ${unreadCount} unread` : ''}`}
        onClick={() => onSelect(id)}
        aria-current={selectedId === id ? 'page' : undefined}
      >
        <span className="orbit-avatar">{initials(peer.displayName)}<PresenceIndicator status={presenceByUser[peer.id] ?? 'offline'} compact /></span>
        <span className="orbit-conversation-copy">
          <span className="orbit-conversation-title"><strong>{peer.displayName}</strong><time dateTime={lastMessage?.createdAt ?? undefined}>{messageTime(lastMessage?.createdAt ?? null)}</time></span>
          <small>{previews[id] ?? (lastMessage ? 'Decrypting message…' : 'No messages yet')}</small>
        </span>
        {unreadCount > 0 && <span className="orbit-unread-count" aria-hidden="true">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>)}
    </div>
    <div className="orbit-sidebar-bottom">
      <div className={`orbit-connection is-${connection}`} role="status">
        <i />
        <span className={`orbit-connection-label${hasConnectionIssue ? ' is-visible' : ''}`}>{connectionLabel(connection)}</span>
        {hasConnectionIssue && <button type="button" onClick={onRetryConnection}>Retry</button>}
      </div>
      {hasConnectionIssue && connectionError && <p className="orbit-connection-error" role="alert">{connectionError}</p>}
      <button className="orbit-profile" type="button" aria-label={`Account menu for ${user.displayName}`} aria-haspopup="true" aria-expanded={accountMenuOpen} aria-controls="orbit-account-menu" onClick={() => setAccountMenuOpen((open) => !open)}>
        <span className="orbit-avatar orbit-avatar--self">{initials(user.displayName)}</span>
        <span><strong>{user.displayName}</strong><small>@{user.username}</small></span>
        <span className="orbit-more" aria-hidden="true">···</span>
      </button>
      {accountMenuOpen && <div className="orbit-account-menu" id="orbit-account-menu" aria-label="Account">
        <span className="orbit-account-version"><OrbitIcon name="shield" size={14} />Device key · version {user.keyVersion}</span>
        <code className="orbit-account-fingerprint">{user.fingerprint}</code>
        <button type="button" onClick={onCopyFingerprint}><OrbitIcon name="copy" size={15} />Copy device fingerprint</button>
        <button type="button" onClick={() => { onOpenSettings(); setAccountMenuOpen(false); }}>Settings</button>
        <button type="button" disabled={busy} onClick={onSignOut}><OrbitIcon name="logout" size={15} />Sign out</button>
      </div>}
    </div>
  </aside>;
}
