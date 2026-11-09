import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccessRequestRecord, ConversationSummary } from '../session';
import { getAccessRequests, resolveAccessRequest } from '../session';
import type { DeviceIdentity } from '../keyStore';
import { decryptAccessRequestNote } from '../messageCrypto';
import { subscribeOrbitEvents } from '../orbitSocket';
import type { OrbitConnectionState } from '../orbitSocket';
import { OrbitIcon } from './OrbitIcon';

interface IncomingRequest extends AccessRequestRecord {
  requesterName: string;
  conversation: ConversationSummary | null;
  note: string;
}

interface IncomingAccessRequestsProps {
  connection: OrbitConnectionState;
  conversations: ConversationSummary[];
  identity: DeviceIdentity | null;
  onOpenConversation: (id: string) => void;
}

function requestLabel(kind: AccessRequestRecord['kind']): string {
  if (kind === 'availability') return 'Asked to open a shared folder';
  if (kind === 'download_permission') return 'Asked for download permission';
  return 'Asked you to share a folder again';
}

export function IncomingAccessRequests({
  connection,
  conversations,
  identity,
  onOpenConversation,
}: IncomingAccessRequestsProps) {
  const [requests, setRequests] = useState<IncomingRequest[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (connection !== 'connected' || loadingRef.current) return;
    loadingRef.current = true;
    try {
      const incoming = await getAccessRequests('incoming', 'pending');
      const conversationById = new Map(conversations.map((item) => [item.id, item]));
      const mapped = await Promise.all(incoming.map(async (request): Promise<IncomingRequest> => {
        const conversation = conversationById.get(request.conversationId) ?? null;
        let note = '';
        if (request.noteCiphertext && request.noteIv) {
          if (identity && conversation) {
            try {
              note = await decryptAccessRequestNote(
                identity,
                conversation,
                request.id,
                request.noteCiphertext,
                request.noteIv,
              );
            } catch {
              note = 'Encrypted note could not be opened on this device.';
            }
          } else {
            note = 'Encrypted note unavailable on this device.';
          }
        }
        return {
          ...request,
          requesterName: conversation?.peer.displayName ?? 'A contact',
          conversation,
          note,
        };
      }));
      setRequests(mapped);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Incoming requests could not be loaded.');
    } finally {
      loadingRef.current = false;
    }
  }, [connection, conversations, identity]);

  useEffect(() => {
    if (connection !== 'connected') return;
    void refresh();
    const unsubscribe = subscribeOrbitEvents((envelope) => {
      if (envelope.event === 'access_request.created' || envelope.event === 'access_request.updated') {
        void refresh();
      }
    });
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [connection, refresh]);

  async function resolve(id: string, action: 'fulfill' | 'decline') {
    setBusyId(id);
    setError('');
    try {
      await resolveAccessRequest(id, action);
      setRequests((current) => current.filter((request) => request.id !== id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The request could not be updated.');
    } finally {
      setBusyId(null);
    }
  }

  if (!requests.length && !error) return null;

  return <aside className="orbit-incoming-requests" aria-label="Incoming folder requests" aria-live="polite">
    {error && <p className="orbit-incoming-request-error" role="alert">{error}</p>}
    {requests.slice(0, 3).map((request) => <article className="orbit-incoming-request" key={request.id}>
      <span className="orbit-incoming-request-icon"><OrbitIcon name="hand" size={16} /></span>
      <div className="orbit-incoming-request-copy">
        <strong>{request.requesterName}</strong>
        <span>{requestLabel(request.kind)}</span>
        {request.note && <p>{request.note}</p>}
      </div>
      <div className="orbit-incoming-request-actions">
        {request.conversation && <button type="button" onClick={() => onOpenConversation(request.conversation!.id)}>Open chat</button>}
        <button type="button" disabled={busyId === request.id} onClick={() => void resolve(request.id, 'fulfill')}>
          {busyId === request.id ? 'Saving…' : 'Handled'}
        </button>
        <button type="button" disabled={busyId === request.id} onClick={() => void resolve(request.id, 'decline')}>Decline</button>
      </div>
    </article>)}
  </aside>;
}
