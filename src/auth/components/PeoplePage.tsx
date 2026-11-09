import type { ConversationSummary } from '../session';
import type { ClientPresenceStatus } from '../presenceStore';
import { initials } from './OrbitMark';
import { OrbitIcon } from './OrbitIcon';
import { PresenceIndicator } from './PresenceIndicator';

interface PeoplePageProps {
  conversations: ConversationSummary[];
  previews: Record<string, string>;
  presenceByUser: Record<string, ClientPresenceStatus>;
  loading: boolean;
  error: string;
  onOpenConversation: (id: string) => void;
  onFindSomeone: () => void;
  onRetry: () => void;
}

export function PeoplePage({
  conversations,
  previews,
  presenceByUser,
  loading,
  error,
  onOpenConversation,
  onFindSomeone,
  onRetry,
}: PeoplePageProps) {
  const sortedPeople = [...conversations].sort((left, right) =>
    left.peer.displayName.localeCompare(right.peer.displayName),
  );
  const onlineCount = sortedPeople.filter(({ peer }) => presenceByUser[peer.id] === 'online').length;

  return <section className="orbit-people-page" aria-labelledby="orbit-people-title">
    <header className="orbit-people-page-heading">
      <div>
        <p className="orbit-dashboard-kicker">YOUR NETWORK · {sortedPeople.length}</p>
        <h1 id="orbit-people-title">People</h1>
      </div>
      <button type="button" className="orbit-dashboard-primary" onClick={onFindSomeone}>
        <OrbitIcon name="userPlus" size={16} />New chat
      </button>
    </header>
    {error && <div className="orbit-inline-error" role="alert"><span>{error}</span><button type="button" onClick={onRetry}>Retry</button></div>}
    {loading
      ? <p className="orbit-people-page-note" role="status">Loading your conversations…</p>
      : sortedPeople.length === 0
        ? <div className="orbit-people-empty">
          <span><OrbitIcon name="userPlus" size={20} /></span>
          <h2>Your network starts here</h2>
          <p>Find someone by username to start a private conversation.</p>
          <button type="button" className="orbit-dashboard-primary" onClick={onFindSomeone}>Find someone</button>
        </div>
        : <>
          <div className="orbit-people-summary">
            <span>{sortedPeople.length} {sortedPeople.length === 1 ? 'person' : 'people'}</span>
            <span><i />{onlineCount} online</span>
          </div>
          <ul className="orbit-people-grid">
            {sortedPeople.map(({ id, peer, lastMessage, unreadCount }) => {
              const status = presenceByUser[peer.id] ?? 'offline';
              return <li key={id}>
                <button type="button" className="orbit-people-card" onClick={() => onOpenConversation(id)}>
                  <span className="orbit-people-card-avatar">
                    <span className="orbit-avatar">{initials(peer.displayName)}<PresenceIndicator status={status} compact /></span>
                  </span>
                  <span className="orbit-people-card-copy">
                    <strong>{peer.displayName}</strong>
                    <small>@{peer.username}</small>
                    <span>{previews[id] ?? (lastMessage ? 'Decrypting message…' : 'Start a conversation')}</span>
                  </span>
                  <span className={`orbit-people-status is-${status}`}>{status}</span>
                  {unreadCount > 0 && <span className="orbit-unread-count">{unreadCount > 99 ? '99+' : unreadCount}</span>}
                </button>
              </li>;
            })}
          </ul>
        </>}
  </section>;
}
