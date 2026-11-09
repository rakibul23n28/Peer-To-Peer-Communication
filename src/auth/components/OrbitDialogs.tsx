import { useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import type { OrbitConnectionState } from '../orbitSocket';
import type { PrivacySettings, UserIdentity, UserSearchResult } from '../session';
import { initials } from './OrbitMark';
import { OrbitIcon } from './OrbitIcon';

export type OrbitDialogKind = 'search' | 'settings' | null;

interface OrbitDialogsProps {
  dialog: OrbitDialogKind;
  user: UserIdentity;
  busy: boolean;
  connection: OrbitConnectionState;
  fileShortcutPending: boolean;
  query: string;
  results: UserSearchResult[];
  searching: boolean;
  searchError: string;
  loadingBlocks: boolean;
  blockedUsers: UserSearchResult[];
  privacySettings: PrivacySettings;
  privacySettingsBusy: boolean;
  browserNotifications: boolean;
  includeFolderNames: boolean;
  compactDensity: boolean;
  actionLabelMode: 'auto' | 'icons';
  onQueryChange: (value: string) => void;
  onOpenConversation: (person: UserSearchResult) => void;
  onClose: () => void;
  onCopyFingerprint: () => void;
  onRefreshBlocks: () => void;
  onUnblock: (id: string) => void;
  onPrivacySettingsChange: (settings: PrivacySettings) => void;
  onEnableBrowserNotifications: (enabled: boolean) => void;
  onIncludeFolderNamesChange: (enabled: boolean) => void;
  onDensityChange: (compact: boolean) => void;
  onActionLabelModeChange: (mode: 'auto' | 'icons') => void;
  onSignOut: () => void;
}

function connectionLabel(connection: OrbitConnectionState): string {
  if (connection === 'connected') return 'Connected';
  if (connection === 'connecting') return 'Connecting…';
  if (connection === 'auth_failed') return 'Session expired';
  if (connection === 'reconnecting') return 'Reconnecting';
  if (connection === 'idle') return 'Idle';
  return 'Offline';
}

export function OrbitDialogs({
  dialog,
  user,
  busy,
  connection,
  fileShortcutPending,
  query,
  results,
  searching,
  searchError,
  loadingBlocks,
  blockedUsers,
  privacySettings,
  privacySettingsBusy,
  browserNotifications,
  includeFolderNames,
  compactDensity,
  actionLabelMode,
  onQueryChange,
  onOpenConversation,
  onClose,
  onCopyFingerprint,
  onRefreshBlocks,
  onUnblock,
  onPrivacySettingsChange,
  onEnableBrowserNotifications,
  onIncludeFolderNamesChange,
  onDensityChange,
  onActionLabelModeChange,
  onSignOut,
}: OrbitDialogsProps) {
  const [settingsSection, setSettingsSection] = useState<'account' | 'appearance' | 'privacy' | 'contacts'>('account');
  if (!dialog) return null;

  function closeOnBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) onClose();
  }

  function closeOnEscape(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') onClose();
  }

  return <div className="orbit-dialog-backdrop" onMouseDown={closeOnBackdrop}>
    <section className="orbit-dialog" role="dialog" aria-modal="true" aria-labelledby="orbit-dialog-title" onKeyDown={closeOnEscape}>
      <button className="orbit-dialog-close" type="button" onClick={onClose} aria-label="Close dialog"><OrbitIcon name="close" size={16} /></button>
      {dialog === 'search' && <>
        <span className="eyebrow">FIND YOUR PEOPLE / 01</span>
        <h2 id="orbit-dialog-title">{fileShortcutPending ? 'Who would you like to send a file to?' : 'Find someone.'}</h2>
        <p>Search by username. Enter at least three characters.</p>
        <label className="orbit-search-label" htmlFor="orbit-user-search">Username</label>
        <div className="orbit-search-input-wrap"><OrbitIcon name="search" size={17} /><input id="orbit-user-search" autoFocus value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Start typing a username" autoComplete="off" /></div>
        {query.trim().length < 3 ? <p className="orbit-dialog-hint">Search starts at 3 characters.</p> : searching ? <p className="orbit-dialog-hint" role="status">Searching Orbit…</p> : searchError ? <p className="orbit-dialog-error" role="alert">{searchError}</p> : results.length === 0 ? <p className="orbit-dialog-hint">No people found for that username.</p> : <div className="orbit-search-results">
          {results.map((person) => <button type="button" key={person.id} onClick={() => onOpenConversation(person)}>
            <span className="orbit-avatar">{initials(person.displayName)}</span><span><strong>{person.displayName}</strong><small>@{person.username}</small></span><span aria-hidden="true">↗</span>
          </button>)}
        </div>}
      </>}
      {dialog === 'settings' && <>
        <div className="orbit-settings-heading">
          <span className="eyebrow">SETTINGS / DEVICE</span>
          <h2 id="orbit-dialog-title">Your space, your keys.</h2>
        </div>
        <nav className="orbit-settings-nav" aria-label="Settings sections">
          <button type="button" aria-current={settingsSection === 'account' ? 'page' : undefined} onClick={() => setSettingsSection('account')}><OrbitIcon name="user" size={16} /><span>Account</span></button>
          <button type="button" aria-current={settingsSection === 'appearance' ? 'page' : undefined} onClick={() => setSettingsSection('appearance')}><OrbitIcon name="palette" size={16} /><span>Appearance</span></button>
          <button type="button" aria-current={settingsSection === 'privacy' ? 'page' : undefined} onClick={() => setSettingsSection('privacy')}><OrbitIcon name="lock" size={16} /><span>Privacy</span></button>
          <button type="button" aria-current={settingsSection === 'contacts' ? 'page' : undefined} onClick={() => setSettingsSection('contacts')}><OrbitIcon name="userX" size={16} /><span>Contacts</span></button>
        </nav>
        <div className="orbit-settings-page" key={settingsSection}>
        {settingsSection === 'account' && <section className="orbit-settings-account">
          <p>Essential details for this device and session.</p>
          <div className="orbit-settings-status">
            <span className={`orbit-settings-status-dot is-${connection}`} />
            <span>{connectionLabel(connection)}</span>
            <span className="orbit-settings-status-separator">·</span>
            <span>End-to-end encrypted</span>
          </div>
          <dl className="orbit-settings-list">
            <div><dt>Username</dt><dd>@{user.username}</dd></div>
            <div><dt>Key version</dt><dd>{user.keyVersion}</dd></div>
            <div><dt>Device identity</dt><dd>Verified</dd></div>
          </dl>
          <button className="orbit-primary-action" type="button" onClick={onCopyFingerprint}>
            <OrbitIcon name="copy" size={16} />Copy device fingerprint
          </button>
          <button className="orbit-dialog-signout" type="button" disabled={busy} onClick={onSignOut}>Sign out of Orbit</button>
        </section>}
        {settingsSection === 'appearance' && <section className="orbit-privacy-settings" aria-labelledby="orbit-display-title">
          <h3 id="orbit-display-title">Display</h3>
          <label className="orbit-settings-row">
            <input type="checkbox" checked={compactDensity} onChange={(event) => onDensityChange(event.target.checked)} />
            <span><strong>Compact layout</strong></span>
          </label>
          <label className="orbit-privacy-select orbit-settings-row">
            <span><strong>Controls</strong></span>
            <select value={actionLabelMode} onChange={(event) => {
              const value = event.target.value;
              if (value === 'auto' || value === 'icons') onActionLabelModeChange(value);
            }}>
              <option value="auto">Automatic</option>
              <option value="icons">Icons only</option>
            </select>
          </label>
        </section>
        }
        {settingsSection === 'privacy' && <section className="orbit-privacy-settings" aria-labelledby="orbit-privacy-title">
          <h3 id="orbit-privacy-title">Privacy</h3>
          <label className="orbit-settings-row">
            <input
              type="checkbox"
              checked={!privacySettings.presenceVisible}
              disabled={privacySettingsBusy}
              onChange={(event) => onPrivacySettingsChange({
                ...privacySettings,
                presenceVisible: !event.target.checked,
              })}
            />
            <span><strong>Appear offline</strong><small>Hide your presence</small></span>
          </label>
          <label className="orbit-settings-row">
            <input
              type="checkbox"
              checked={privacySettings.showViewingActivity}
              disabled={privacySettingsBusy}
              onChange={(event) => onPrivacySettingsChange({
                ...privacySettings,
                showViewingActivity: event.target.checked,
              })}
            />
            <span><strong>Viewing activity</strong><small>Let folder owners see when you browse</small></span>
          </label>
          <label className="orbit-privacy-select orbit-settings-row">
            <span><strong>Access requests</strong></span>
            <select
              value={privacySettings.acceptAccessRequests}
              disabled={privacySettingsBusy}
              onChange={(event) => onPrivacySettingsChange({
                ...privacySettings,
                acceptAccessRequests: event.target.value as PrivacySettings['acceptAccessRequests'],
              })}
            >
              <option value="contacts">Contacts</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="orbit-settings-row">
            <input type="checkbox" checked={browserNotifications} onChange={(event) => onEnableBrowserNotifications(event.target.checked)} />
            <span><strong>Browser alerts</strong><small>Only while Orbit is open</small></span>
          </label>
          <label className="orbit-settings-row">
            <input type="checkbox" checked={includeFolderNames} onChange={(event) => onIncludeFolderNamesChange(event.target.checked)} />
            <span><strong>Show folder names</strong><small>Names may appear in alerts</small></span>
          </label>
          <details className="orbit-privacy-disclosure">
            <summary>Data visibility</summary>
            <p>Ephemeral online/away/offline state, each active share’s availability and download-permission flag, a per-share viewing boolean, privacy settings, and access-request IDs, kind, status, timestamps, and optional opaque encrypted notes. It never sees folder or file names, paths, contents, which file is being read, transfer byte counts or speeds, or search queries.</p>
          </details>
        </section>
        }
        {settingsSection === 'contacts' && <div className="orbit-blocked-list">
          <div className="orbit-blocked-list-heading"><strong>Blocked contacts</strong><button type="button" onClick={onRefreshBlocks}>Refresh</button></div>
          {loadingBlocks ? <p>Loading blocked contacts…</p> : blockedUsers.length === 0
            ? <p>No blocked contacts.</p>
            : blockedUsers.map((contact) => <div className="orbit-blocked-contact" key={contact.id}>
              <span><strong>{contact.displayName}</strong><small>@{contact.username}</small></span>
              <button type="button" onClick={() => onUnblock(contact.id)}>Unblock</button>
            </div>)}
        </div>}
        </div>
      </>}
    </section>
  </div>;
}
