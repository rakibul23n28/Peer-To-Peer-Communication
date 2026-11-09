import type { OrbitIconName } from './components/OrbitIcon';

export type OrbitActionId =
  | 'newChat'
  | 'search'
  | 'sendFile'
  | 'shareFolder'
  | 'sendMessage'
  | 'call'
  | 'acceptCall'
  | 'declineCall'
  | 'acceptFile'
  | 'declineFile'
  | 'endCall'
  | 'mute'
  | 'attach'
  | 'openFolder'
  | 'preview'
  | 'download'
  | 'pauseTransfer'
  | 'resumeTransfer'
  | 'cancelTransfer'
  | 'retry'
  | 'editMessage'
  | 'deleteMessage'
  | 'reply'
  | 'react'
  | 'copyFingerprint'
  | 'openSettings'
  | 'signOut'
  | 'blockContact'
  | 'unblockContact'
  | 'notifyShare'
  | 'requestAccess'
  | 'allowDownloads'
  | 'pauseSharing'
  | 'resumeSharing'
  | 'stopSharing'
  | 'stopTransfer'
  | 'toggleInspector'
  | 'toggleNavigation'
  | 'switchTheme'
  | 'toggleDensity'
  | 'more'
  | 'close'
  | 'clearHistory';

interface OrbitAction {
  id: OrbitActionId;
  icon: OrbitIconName;
  label: string;
  shortcut?: string;
  tone?: 'danger' | 'success' | 'warning' | 'info';
}

function defineAction(
  id: OrbitActionId,
  icon: OrbitIconName,
  label: string,
  options: Pick<OrbitAction, 'shortcut' | 'tone'> = {},
): OrbitAction {
  return { id, icon, label, ...options };
}

export const ActionRegistry = {
  newChat: defineAction('newChat', 'userPlus', 'New chat'),
  search: defineAction('search', 'search', 'Search people', { shortcut: 'Ctrl/Cmd K' }),
  sendFile: defineAction('sendFile', 'paperclip', 'Send file'),
  shareFolder: defineAction('shareFolder', 'folderUp', 'Share folder'),
  sendMessage: defineAction('sendMessage', 'send', 'Send message', { shortcut: 'Enter' }),
  call: defineAction('call', 'phone', 'Start audio call'),
  acceptCall: defineAction('acceptCall', 'phoneCheck', 'Accept call'),
  declineCall: defineAction('declineCall', 'phoneX', 'Decline call', { tone: 'danger' }),
  acceptFile: defineAction('acceptFile', 'check', 'Accept file'),
  declineFile: defineAction('declineFile', 'fileX', 'Decline file', { tone: 'danger' }),
  endCall: defineAction('endCall', 'phoneOff', 'End call', { tone: 'danger' }),
  mute: defineAction('mute', 'microphoneOff', 'Mute microphone'),
  attach: defineAction('attach', 'upload', 'Attach'),
  openFolder: defineAction('openFolder', 'folderOpen', 'Open folder'),
  preview: defineAction('preview', 'eye', 'Preview'),
  download: defineAction('download', 'download', 'Download'),
  pauseTransfer: defineAction('pauseTransfer', 'pause', 'Pause transfer'),
  resumeTransfer: defineAction('resumeTransfer', 'play', 'Resume transfer'),
  cancelTransfer: defineAction('cancelTransfer', 'cancelCircle', 'Cancel transfer', { tone: 'danger' }),
  retry: defineAction('retry', 'retry', 'Retry'),
  editMessage: defineAction('editMessage', 'edit', 'Edit message'),
  deleteMessage: defineAction('deleteMessage', 'trash', 'Delete message', { tone: 'danger' }),
  reply: defineAction('reply', 'reply', 'Reply'),
  react: defineAction('react', 'smilePlus', 'Add reaction'),
  copyFingerprint: defineAction('copyFingerprint', 'copy', 'Copy device fingerprint'),
  openSettings: defineAction('openSettings', 'settings', 'Settings'),
  signOut: defineAction('signOut', 'logout', 'Sign out'),
  blockContact: defineAction('blockContact', 'userX', 'Block contact', { tone: 'danger' }),
  unblockContact: defineAction('unblockContact', 'userCheck', 'Unblock contact'),
  notifyShare: defineAction('notifyShare', 'bellPlus', 'Notify me when available'),
  requestAccess: defineAction('requestAccess', 'hand', 'Request access'),
  allowDownloads: defineAction('allowDownloads', 'downloadCloud', 'Allow downloads'),
  pauseSharing: defineAction('pauseSharing', 'pauseCircle', 'Pause sharing'),
  resumeSharing: defineAction('resumeSharing', 'playCircle', 'Resume sharing'),
  stopSharing: defineAction('stopSharing', 'linkOff', 'Stop sharing', { tone: 'danger' }),
  stopTransfer: defineAction('stopTransfer', 'stop', 'Stop transfer', { tone: 'danger' }),
  toggleInspector: defineAction('toggleInspector', 'panelRight', 'Toggle conversation details'),
  toggleNavigation: defineAction('toggleNavigation', 'panelLeft', 'Toggle navigation'),
  switchTheme: defineAction('switchTheme', 'palette', 'Appearance'),
  toggleDensity: defineAction('toggleDensity', 'rows', 'Display density'),
  more: defineAction('more', 'more', 'More actions'),
  close: defineAction('close', 'close', 'Close'),
  clearHistory: defineAction('clearHistory', 'archive', 'Clear download history', { tone: 'danger' }),
} satisfies Record<OrbitActionId, OrbitAction>;

export function getOrbitAction(action: OrbitActionId): OrbitAction {
  return ActionRegistry[action];
}
