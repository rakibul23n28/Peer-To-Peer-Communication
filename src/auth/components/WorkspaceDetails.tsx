import { useMemo, useState } from 'react';
import type { ThreadMessage } from './ConversationThread';
import type { ConversationSummary, UserIdentity } from '../session';
import { OrbitIcon } from './OrbitIcon';
import { initials } from './OrbitMark';

type Appearance = 'storybook' | 'minimal' | 'watercolor' | 'anime' | 'midnight';
const appearances: Array<{ value: Appearance; label: string; detail: string; icon: 'tree' | 'list' | 'water' | 'spark' | 'moon' }> = [
  { value: 'storybook', label: 'Storybook', detail: 'Garden', icon: 'tree' },
  { value: 'minimal', label: 'Minimal', detail: 'Paper', icon: 'list' },
  { value: 'watercolor', label: 'Watercolor', detail: 'Wash', icon: 'water' },
  { value: 'anime', label: 'Anime', detail: 'Magic', icon: 'spark' },
  { value: 'midnight', label: 'Midnight', detail: 'Dark', icon: 'moon' },
];

function isAppearance(value: string): value is Appearance {
  return appearances.some((appearance) => appearance.value === value);
}

interface WorkspaceDetailsProps {
  conversation: ConversationSummary;
  user: UserIdentity;
  messages: ThreadMessage[];
  appearance: Appearance;
  onAppearanceChange: (appearance: Appearance) => void;
  onClose: () => void;
  onCopyFingerprint: () => void;
  onJumpToMessage: (id: string) => void;
}

function messageTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function WorkspaceDetails({
  conversation,
  user,
  messages,
  appearance,
  onAppearanceChange,
  onClose,
  onCopyFingerprint,
  onJumpToMessage,
}: WorkspaceDetailsProps) {
  const [search, setSearch] = useState('');
  const matches = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return [];
    return messages
      .filter((message) =>
        message.kind === 'text' &&
        !message.decryptionError &&
        message.plaintext.toLocaleLowerCase().includes(query),
      )
      .slice(-20)
      .reverse();
  }, [messages, search]);
  return <section className="orbit-details-panel orbit-details-page" id="orbit-details-panel" aria-label="Conversation details">
    <header className="orbit-details-header">
      <div>
        <span className="orbit-details-kicker">WORKSPACE</span>
        <h2>Conversation details</h2>
      </div>
      <button className="orbit-details-close" type="button" onClick={onClose} aria-label="Back to conversation">
        <OrbitIcon name="back" size={17} />
      </button>
    </header>

    <div className="orbit-details-content">
      <section className="orbit-details-person">
        <span className="orbit-avatar orbit-details-avatar">{initials(conversation.peer.displayName)}</span>
        <h3>{conversation.peer.displayName}</h3>
        <p>@{conversation.peer.username}</p>
        <span className={`orbit-details-status${conversation.peer.keyAvailable ? ' is-secure' : ''}`}>
          <OrbitIcon name="shield" size={14} />
          {conversation.peer.keyAvailable ? 'Encrypted conversation' : 'Encryption key unavailable'}
        </span>
        {!conversation.peer.keyAvailable && <p className="orbit-details-hint">
          This contact needs to sign in to restore their device key. Refresh this conversation afterward.
        </p>}
      </section>

      <section className="orbit-details-section" aria-labelledby="orbit-search-title">
        <h3 id="orbit-search-title"><OrbitIcon name="search" size={15} />Search loaded messages</h3>
        <label className="orbit-details-search">
          <span className="orbit-visually-hidden">Search in loaded messages</span>
          <OrbitIcon name="search" size={15} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a phrase…" />
        </label>
        <p className="orbit-details-hint">Search covers messages currently loaded in this conversation.</p>
        {search && <div className="orbit-details-results" role="list" aria-label="Message search results">
          {matches.length
            ? matches.map((message) => <button
                type="button"
                key={message.id}
                onClick={() => onJumpToMessage(message.id)}
              >
                <span>{message.senderId === user.id ? 'You' : conversation.peer.displayName} · {messageTime(message.createdAt)}</span>
                <strong>{message.plaintext}</strong>
              </button>)
            : <p className="orbit-details-empty">No matches in loaded messages.</p>}
        </div>}
      </section>

      <section className="orbit-details-section" aria-labelledby="orbit-security-title">
        <h3 id="orbit-security-title"><OrbitIcon name="shield" size={15} />Security</h3>
        <div className="orbit-key-detail"><span>Contact key</span><strong>Version {conversation.peer.keyVersion}</strong></div>
        <div className="orbit-fingerprint">
          <span>Your device fingerprint</span>
          <code>{user.fingerprint}</code>
          <button type="button" onClick={onCopyFingerprint}><OrbitIcon name="copy" size={14} />Copy fingerprint</button>
        </div>
      </section>

      <section className="orbit-details-section" aria-labelledby="orbit-layout-title">
        <h3 id="orbit-layout-title"><OrbitIcon name="settings" size={15} />Workspace</h3>
        <fieldset className="orbit-appearance-picker">
          <legend>Chat appearance</legend>
          <div className="orbit-appearance-options">
            {appearances.map((option) => <button
              className={`orbit-appearance-option is-${option.value}`}
              type="button"
              key={option.value}
              aria-pressed={appearance === option.value}
              aria-label={`${option.label}, ${option.detail}`}
              title={`${option.label} · ${option.detail}`}
              onClick={() => {
                if (isAppearance(option.value)) onAppearanceChange(option.value);
              }}
            >
              <OrbitIcon name={option.icon} size={17} />
              <span>{option.label}</span>
            </button>)}
          </div>
        </fieldset>
      </section>
    </div>
  </section>;
}
