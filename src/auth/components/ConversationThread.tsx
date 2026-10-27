import type { FormEvent, RefObject } from 'react';
import type { ConversationSummary, EncryptedMessage, UserIdentity } from '../session';
import type { OrbitConnectionState } from '../orbitSocket';
import { OrbitIcon } from './OrbitIcon';
import { initials } from './OrbitMark';

export type ThreadMessage = EncryptedMessage & {
  plaintext: string;
  decryptedReactions: string[];
  decryptedFileName?: string;
  sendState?: 'queued' | 'sending' | 'sent' | 'failed';
  sendError?: string;
};

export type FileTransferProgress = { transferred: number; total: number; error?: string };
export type ReceivedFile = { name: string; blob: Blob; url: string };

interface ConversationThreadProps {
  conversation: ConversationSummary;
  user: UserIdentity;
  connection: OrbitConnectionState;
  deviceIdentityAvailable: boolean;
  peerBlocked: boolean;
  fileSending: boolean;
  filePickerRef: RefObject<HTMLInputElement | null>;
  peerRequestState: 'idle' | 'requested' | 'received' | 'accepted';
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
  threadEndRef: RefObject<HTMLDivElement | null>;
  onBack: () => void;
  onRequestPeer: () => void;
  onBlock: () => void;
  onUnblock: () => void;
  onRespondPeer: (accepted: boolean) => void;
  onRetryThread: () => void;
  onMessageListScroll: (nearBottom: boolean) => void;
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

export function ConversationThread({
  conversation,
  user,
  connection,
  deviceIdentityAvailable,
  peerBlocked,
  fileSending,
  filePickerRef,
  peerRequestState,
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
  threadEndRef,
  onBack,
  onRequestPeer,
  onBlock,
  onUnblock,
  onRespondPeer,
  onRetryThread,
  onMessageListScroll,
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
  onReplyChange,
  onDraftChange,
  onRetryAllQueued,
  onSendMessage,
}: ConversationThreadProps) {
  let previousDay = '';

  return <div className="orbit-thread">
    <header className="orbit-thread-header">
      <button className="orbit-thread-back" type="button" onClick={onBack} aria-label="Back to conversations">
        <OrbitIcon name="back" />
      </button>
      <span className="orbit-avatar orbit-thread-avatar">{initials(conversation.peer.displayName)}</span>
      <div className="orbit-thread-person">
        <h1>{conversation.peer.displayName}</h1>
        <div className="orbit-thread-meta"><span>@{conversation.peer.username}</span><span className={`orbit-connection-pill${connection === 'connected' ? ' is-connected' : ''}`}><i />{connection === 'connected' ? 'Secure link' : 'Reconnecting'}</span></div>
      </div>
      <div className="orbit-thread-actions">
        <button type="button" title="Share a file or media" aria-label="Share file or media" disabled={!deviceIdentityAvailable || fileSending || peerBlocked} onClick={() => filePickerRef.current?.click()}>
          <OrbitIcon name="paperclip" /><span>{fileSending ? 'Preparing' : 'Share media'}</span>
        </button>
        <button type="button" title="Request direct peer access" aria-label="Request direct peer access" disabled={connection !== 'connected'} onClick={onRequestPeer}>
          <OrbitIcon name="link" /><span>{peerRequestState === 'requested' ? 'Request sent' : 'Direct link'}</span>
        </button>
        {!peerBlocked && <button className="orbit-thread-block" type="button" title="Block contact" aria-label="Block contact" onClick={onBlock}>
          <OrbitIcon name="shield" />
        </button>}
      </div>
    </header>

    {peerRequestState === 'received' && <div className="orbit-peer-request" role="status">
      <span>This contact is requesting direct file-sharing access.</span>
      <button type="button" onClick={() => onRespondPeer(true)}>Allow</button>
      <button type="button" onClick={() => onRespondPeer(false)}>Decline</button>
    </div>}
    {peerBlocked && <div className="orbit-blocked-banner" role="status">
      You blocked @{conversation.peer.username}. Messages and file sharing are disabled.
      <button type="button" onClick={onUnblock}>Unblock</button>
    </div>}
    <section className="orbit-message-list" aria-label="Encrypted messages" aria-live="polite" onScroll={(event) => {
      const element = event.currentTarget;
      onMessageListScroll(element.scrollHeight - element.scrollTop - element.clientHeight < 96);
    }}>
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
        return <div className="orbit-message-row" key={item.id}>
          {showDay && <div className="orbit-day-divider"><span>{dayLabel(item.createdAt)}</span></div>}
          <article className={`orbit-message${item.senderId === user.id ? ' is-own' : ''}${item.kind === 'file' ? ' is-file-message' : ''}`}>
            {item.replyToId && <span className="orbit-reply-caption">REPLY TO / {item.replyToId.slice(0, 8)}</span>}
            {item.kind === 'file' && item.file ? <div className="orbit-file-card">
              <div className="orbit-file-card-heading">
                <span aria-hidden="true"><OrbitIcon name="file" /></span>
                <div><strong>{item.decryptedFileName ?? 'Encrypted file'}</strong><small>{formatFileSize(Number(item.file.size))} · {item.file.mime}</small></div>
              </div>
              {receivedFiles[item.file.fileId] && item.file.mime.startsWith('image/') && <img className="orbit-file-preview" src={receivedFiles[item.file.fileId].url} alt={item.decryptedFileName ?? 'Shared image'} />}
              {receivedFiles[item.file.fileId] && item.file.mime.startsWith('video/') && <video className="orbit-file-preview" src={receivedFiles[item.file.fileId].url} controls />}
              {receivedFiles[item.file.fileId] && item.file.mime.startsWith('audio/') && <audio className="orbit-file-audio" src={receivedFiles[item.file.fileId].url} controls />}
              {fileProgress[item.file.fileId] && <div className="orbit-file-progress">
                {fileProgress[item.file.fileId].error
                  ? <span role="alert">{fileProgress[item.file.fileId].error}</span>
                  : <><progress max={Math.max(fileProgress[item.file.fileId].total, 1)} value={fileProgress[item.file.fileId].transferred} /><small>{formatFileSize(fileProgress[item.file.fileId].transferred)} / {formatFileSize(fileProgress[item.file.fileId].total)}</small></>}
              </div>}
              <div className="orbit-file-card-footer">
                <span>{item.file.status === 'offered' ? 'Waiting for acceptance' : item.file.status === 'accepted' ? 'Accepted · waiting for peer' : item.file.status === 'transferring' ? 'Transferring directly' : item.file.status === 'received' ? 'Received and verified' : item.file.status}</span>
                {receivedFiles[item.file.fileId] && <a href={receivedFiles[item.file.fileId].url} download={receivedFiles[item.file.fileId].name}>Download</a>}
                {item.senderId !== user.id && item.file.status === 'offered' && <>
                  <button type="button" onClick={() => onAcceptFile(item)}>Accept</button>
                  <button type="button" onClick={() => onDeclineFile(item)}>Decline</button>
                </>}
                {item.file.status === 'offered' && item.senderId === user.id && <button type="button" onClick={() => onCancelFile(item)}>Cancel offer</button>}
                {(item.file.status === 'accepted' || item.file.status === 'transferring') && <button type="button" onClick={() => onCancelFile(item)}>Cancel transfer</button>}
              </div>
              <p className="orbit-file-privacy">File bytes travel through an encrypted peer-to-peer connection; Orbit stores only the encrypted offer and transfer metadata.</p>
            </div> : editingId === item.id ? <div className="orbit-edit-form">
              <textarea aria-label="Edit message" value={editDraft} onChange={(event) => onEditDraftChange(event.target.value)} />
              <button type="button" onClick={() => onEditTextMessage(item)}>Save edit</button>
              <button type="button" onClick={onCancelEdit}>Cancel</button>
            </div> : <p>{item.plaintext}</p>}
            {item.decryptedReactions.length > 0 && <div className="orbit-message-reactions">{item.decryptedReactions.map((reaction, index) => <span key={`${item.id}-${index}`}>{reaction}</span>)}</div>}
            <footer><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{item.editedAt ? ' · edited' : ''}</time>
              {item.senderId === user.id && <span>{item.sendState === 'failed' ? "Couldn't send" : item.sendState === 'queued' || item.sendState === 'sending' ? 'Sending' : item.receipts.some((entry) => entry.status === 'read') ? 'Seen' : item.receipts.some((entry) => entry.status === 'delivered') ? 'Delivered' : 'Sent'}</span>}
            </footer>
            {item.senderId === user.id && item.sendState === 'failed' && <div className="orbit-message-error" role="alert">
              <span>{item.sendError ?? 'Could not send this message.'}</span>
              <button type="button" onClick={() => onRetryQueuedMessage(item.clientMsgId)}>Retry</button>
            </div>}
            {item.senderId === user.id && !item.deletedAt && !item.sendState && <div className="orbit-message-actions">
              <button type="button" onClick={() => onStartEdit(item)}>Edit</button>
              <button type="button" onClick={() => onDeleteTextMessage(item)}>Delete</button>
            </div>}
            {!item.deletedAt && <div className="orbit-message-actions">
              <button type="button" onClick={() => onReply(item.id)}>Reply</button>
              <button type="button" aria-label="React with heart" onClick={() => onReact(item, '❤️')}>React ♥</button>
            </div>}
          </article>
        </div>;
      })}
      <div ref={threadEndRef} />
    </section>

    <form className="orbit-composer" onSubmit={onSendMessage}>
      <input ref={filePickerRef} className="orbit-file-picker" type="file" aria-label="Choose a file or media" onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        if (file) onOfferFile(file);
        event.currentTarget.value = '';
      }} />
      {replyTo && <div className="orbit-replying">Replying to {threadMessages.find((item) => item.id === replyTo)?.plaintext.slice(0, 80) ?? 'message'}<button type="button" onClick={() => onReplyChange(null)} aria-label="Cancel reply"><OrbitIcon name="close" size={15} /></button></div>}
      <textarea value={draft} onChange={(event) => onDraftChange(event.target.value)} maxLength={8000} aria-label="Message" placeholder={peerBlocked ? 'Unblock this contact to send messages…' : deviceIdentityAvailable ? 'Write an encrypted message…' : 'Loading your device key…'} disabled={!deviceIdentityAvailable || peerBlocked} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }} />
      <div className="orbit-composer-bottom">
        <span>{outboxCount > 0 ? `${outboxCount} encrypted message${outboxCount === 1 ? '' : 's'} in outbox` : 'End-to-end encrypted · Enter to send'}</span>
        {outboxCount > 0 && <button className="orbit-outbox-retry" type="button" disabled={connection !== 'connected'} onClick={onRetryAllQueued}>Retry queued</button>}
        <button className="orbit-attach-action" type="button" disabled={!deviceIdentityAvailable || fileSending || peerBlocked} onClick={() => filePickerRef.current?.click()} aria-label="Attach file or media">
          <OrbitIcon name="paperclip" /><span>{fileSending ? 'Preparing…' : 'Attach media'}</span>
        </button>
        <button className="orbit-primary-action" type="submit" disabled={!draft.trim() || sending || !deviceIdentityAvailable || peerBlocked}>
          <span>{sending ? 'Sending…' : 'Send'}</span><OrbitIcon name="send" size={16} />
        </button>
      </div>
    </form>
  </div>;
}
