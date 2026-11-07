import { useMemo, useState } from 'react';
import type { ThreadMessage } from './ConversationThread';
import type { ConversationSummary, UserIdentity } from '../session';
import { OrbitIcon } from './OrbitIcon';
import { initials } from './OrbitMark';

type Theme = 'dark' | 'light';
type Density = 'comfortable' | 'compact';

interface WorkspaceDetailsProps {
  conversation: ConversationSummary;
  user: UserIdentity;
  messages: ThreadMessage[];
  theme: Theme;
  density: Density;
  sidebarWidth: number;
  panelWidth: number;
  onThemeChange: (theme: Theme) => void;
  onDensityChange: (density: Density) => void;
  onSidebarWidthChange: (width: number) => void;
  onPanelWidthChange: (width: number) => void;
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
  theme,
  density,
  sidebarWidth,
  panelWidth,
  onThemeChange,
  onDensityChange,
  onSidebarWidthChange,
  onPanelWidthChange,
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
  return <aside className="orbit-details-panel" id="orbit-details-panel" aria-label="Conversation details">
    <header className="orbit-details-header">
      <div>
        <span className="orbit-details-kicker">WORKSPACE</span>
        <h2>Conversation details</h2>
      </div>
      <button className="orbit-details-close" type="button" onClick={onClose} aria-label="Close conversation details">
        <OrbitIcon name="close" size={17} />
      </button>
    </header>

    <div className="orbit-details-content">
      <section className="orbit-details-person">
        <span className="orbit-avatar orbit-details-avatar">{initials(conversation.peer.displayName)}</span>
        <h3>{conversation.peer.displayName}</h3>
        <p>@{conversation.peer.username}</p>
        <span className={`orbit-details-status${conversation.peer.publicKey ? ' is-secure' : ''}`}>
          <OrbitIcon name="shield" size={14} />
          {conversation.peer.publicKey ? 'Encrypted conversation' : 'Encryption key unavailable'}
        </span>
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
        <div className="orbit-choice-row">
          <span>Appearance</span>
          <div className="orbit-segmented-control" role="group" aria-label="Color theme">
            <button type="button" aria-pressed={theme === 'dark'} onClick={() => onThemeChange('dark')}><OrbitIcon name="moon" size={14} /><span>Dark</span></button>
            <button type="button" aria-pressed={theme === 'light'} onClick={() => onThemeChange('light')}><OrbitIcon name="sun" size={14} /><span>Light</span></button>
          </div>
        </div>
        <div className="orbit-choice-row">
          <span>Message density</span>
          <div className="orbit-segmented-control" role="group" aria-label="Message density">
            <button type="button" aria-pressed={density === 'comfortable'} onClick={() => onDensityChange('comfortable')}>Comfort</button>
            <button type="button" aria-pressed={density === 'compact'} onClick={() => onDensityChange('compact')}>Compact</button>
          </div>
        </div>
        <label className="orbit-range-control">
          <span>Navigation width <output>{sidebarWidth}px</output></span>
          <input type="range" min="220" max="360" step="10" value={sidebarWidth} onChange={(event) => onSidebarWidthChange(Number(event.target.value))} />
        </label>
        <label className="orbit-range-control">
          <span>Details width <output>{panelWidth}px</output></span>
          <input type="range" min="260" max="400" step="10" value={panelWidth} onChange={(event) => onPanelWidthChange(Number(event.target.value))} />
        </label>
      </section>
    </div>
  </aside>;
}
