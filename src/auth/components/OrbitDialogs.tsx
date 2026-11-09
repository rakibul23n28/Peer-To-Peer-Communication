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
  searchIndexEnabled: boolean;
  onQueryChange: (value: string) => void;
  onOpenConversation: (person: UserSearchResult) => void;
  onClose: () => void;
  onCopyFingerprint: () => void;
  onRefreshBlocks: () => void;
  onUnblock: (id: string) => void;
  onPrivacySettingsChange: (settings: PrivacySettings) => void;
  onEnableBrowserNotifications: (enabled: boolean) => void;
  onIncludeFolderNamesChange: (enabled: boolean) => void;
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
  searchIndexEnabled,
  onQueryChange,
  onOpenConversation,
  onClose,
  onCopyFingerprint,
  onRefreshBlocks,
  onUnblock,
  onPrivacySettingsChange,
  onEnableBrowserNotifications,
  onIncludeFolderNamesChange,
  onSignOut,
}: OrbitDialogsProps) {
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
        <span className="eyebrow">SETTINGS / DEVICE</span>
        <h2 id="orbit-dialog-title">Your space, your keys.</h2>
        <p>Account and device details currently available for this session.</p>
        <dl className="orbit-settings-list"><div><dt>Username</dt><dd>@{user.username}</dd></div><div><dt>Active key version</dt><dd>{user.keyVersion}</dd></div><div><dt>Device key</dt><dd>Verified against the active server key</dd></div><div><dt>Connection</dt><dd>{connectionLabel(connection)}</dd></div></dl>
        <button className="orbit-primary-action" type="button" onClick={onCopyFingerprint}>Copy device fingerprint <span aria-hidden="true">↗</span></button>
        <section className="orbit-privacy-settings" aria-labelledby="orbit-privacy-title">
          <h3 id="orbit-privacy-title">Privacy & presence</h3>
          <label>
            <input
              type="checkbox"
              checked={!privacySettings.presenceVisible}
              disabled={privacySettingsBusy}
              onChange={(event) => onPrivacySettingsChange({
                ...privacySettings,
                presenceVisible: !event.target.checked,
              })}
            />
            <span><strong>Appear offline</strong><small>Others see you as offline and can't start new previews or downloads until you turn this off. Transfers already in progress continue.</small><small>Who can see this: your conversation partners see offline while enabled.</small></span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={privacySettings.showViewingActivity}
              disabled={privacySettingsBusy}
              onChange={(event) => onPrivacySettingsChange({
                ...privacySettings,
                showViewingActivity: event.target.checked,
              })}
            />
            <span><strong>Show when I'm viewing shared folders</strong><small>Actual file reads are visible to the folder owner because their device serves the data.</small><small>Who can see this: only the owner of the folder you open.</small></span>
          </label>
          <label className="orbit-privacy-select">
            <span><strong>Accept access requests</strong><small>Who can send: contacts with an existing conversation.</small></span>
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
          <label>
            <input type="checkbox" checked={browserNotifications} onChange={(event) => onEnableBrowserNotifications(event.target.checked)} />
            <span><strong>Browser notifications</strong><small>Notifications work only while Orbit is open in a tab. No push notification is sent when Orbit is closed.</small></span>
          </label>
          <label>
            <input type="checkbox" checked={includeFolderNames} onChange={(event) => onIncludeFolderNamesChange(event.target.checked)} />
            <span><strong>Include folder names in notifications</strong><small>Names are local-only and may appear on your lock screen. Off by default.</small></span>
          </label>
          <label>
            <input type="checkbox" checked={searchIndexEnabled} disabled />
            <span><strong>Index shared folders for search</strong><small>Local shared-folder search is not available yet. No search index is uploaded.</small></span>
          </label>
          <p><strong>What the server can see:</strong> ephemeral online/away/offline state, each active share’s availability and download-permission flag, a per-share viewing boolean, privacy settings, and access-request IDs, kind, status, timestamps, and optional opaque encrypted notes. It never sees folder or file names, paths, contents, which file is being read, transfer byte counts or speeds, or search queries.</p>
        </section>
        <div className="orbit-blocked-list">
          <div className="orbit-blocked-list-heading"><strong>Blocked contacts</strong><button type="button" onClick={onRefreshBlocks}>Refresh</button></div>
          {loadingBlocks ? <p>Loading blocked contacts…</p> : blockedUsers.length === 0
            ? <p>No blocked contacts.</p>
            : blockedUsers.map((contact) => <div className="orbit-blocked-contact" key={contact.id}>
              <span><strong>{contact.displayName}</strong><small>@{contact.username}</small></span>
              <button type="button" onClick={() => onUnblock(contact.id)}>Unblock</button>
            </div>)}
        </div>
        <button className="orbit-dialog-signout" type="button" disabled={busy} onClick={onSignOut}>Sign out of Orbit</button>
      </>}
    </section>
  </div>;
}
