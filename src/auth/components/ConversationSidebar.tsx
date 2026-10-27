import { useState } from 'react';
import type { ConversationSummary, UserIdentity } from '../session';
import type { OrbitConnectionState } from '../orbitSocket';
import { OrbitMark, initials } from './OrbitMark';
import { OrbitIcon } from './OrbitIcon';

interface ConversationSidebarProps {
  user: UserIdentity;
  busy: boolean;
  conversations: ConversationSummary[];
  selectedId: string | null;
  previews: Record<string, string>;
  loading: boolean;
  error: string;
  connection: OrbitConnectionState;
  connectionError: string;
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
  user,
  busy,
  conversations,
  selectedId,
  previews,
  loading,
  error,
  connection,
  connectionError,
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

  return <aside className="orbit-sidebar" aria-label="Orbit navigation">
    <a className="home-brand" href="/" aria-label="Orbit home"><OrbitMark /> orbit<span>.</span></a>
    <div className="orbit-sidebar-heading">
      <span className="orbit-list-title">Conversations</span>
      <div className="orbit-add-wrap">
        <button className="orbit-add" type="button" aria-label="New conversation or send a file" aria-haspopup="true" aria-expanded={addMenuOpen} aria-controls="orbit-add-menu" onClick={() => setAddMenuOpen((open) => !open)}><OrbitIcon name="plus" size={17} /></button>
        {addMenuOpen && <div className="orbit-popover" id="orbit-add-menu">
          <button type="button" onClick={() => { onFindSomeone(); setAddMenuOpen(false); }}>Find someone by username</button>
          <button type="button" onClick={() => { onSendFile(); setAddMenuOpen(false); }}>Send a file</button>
        </div>}
      </div>
    </div>
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
        <span className="orbit-avatar">{initials(peer.displayName)}</span>
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
        <span className="orbit-account-version">Device key · version {user.keyVersion}</span>
        <code className="orbit-account-fingerprint">{user.fingerprint}</code>
        <button type="button" onClick={onCopyFingerprint}>Copy device fingerprint</button>
        <button type="button" onClick={() => { onOpenSettings(); setAccountMenuOpen(false); }}>Settings</button>
        <button type="button" disabled={busy} onClick={onSignOut}>Sign out</button>
      </div>}
    </div>
  </aside>;
}
