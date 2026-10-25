import { getAccessToken, refreshAccessToken, subscribeAuth } from './session';

export type OrbitConnectionState = 'connected' | 'reconnecting' | 'offline' | 'connecting' | 'auth_failed' | 'idle';
export interface OrbitEnvelope {
  event: string;
  data: unknown;
}

type SocketListener = (state: OrbitConnectionState, error?: string) => void;
type EnvelopeListener = (envelope: OrbitEnvelope) => void;

const listeners = new Set<SocketListener>();
const envelopeListeners = new Set<EnvelopeListener>();
const pendingRequests = new Map<string, {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
let socket: WebSocket | null = null;
let stopped = true;
let attempt = 0;
let generation = 0;
let ownerId = 0;
let refreshBeforeReconnect = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let state: OrbitConnectionState = 'offline';
let lastError = '';

function notify(next: OrbitConnectionState, error = '') {
  state = next;
  lastError = error;
  for (const listener of listeners) listener(state, lastError || undefined);
}

export function normalizeOrbitMessage(raw: unknown): OrbitEnvelope {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid WebSocket envelope.');
  }

  const candidate = raw as Record<string, unknown>;

  if ('event' in candidate && 'data' in candidate && typeof candidate.event === 'string') {
    return { event: candidate.event, data: candidate.data };
  }

  if ('type' in candidate && typeof candidate.type === 'string') {
    return { event: candidate.type, data: candidate };
  }

  throw new Error('Invalid WebSocket envelope.');
}

function socketUrl(): string {
  const apiBase = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
  const path = `${apiBase}/ws`;
  if (/^https?:\/\//.test(path)) {
    const url = new URL(path);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path.startsWith('/') ? path : `/${path}`}`;
}

function socketProtocols(token: string | null): string[] {
  return token ? ['orbit.v1', `orbit.token.${token}`] : ['orbit.v1'];
}

function scheduleReconnect(error = '') {
  if (stopped) {
    notify('offline', error);
    return;
  }
  if (retryTimer) clearTimeout(retryTimer);
  const base = Math.min(30_000, 750 * 2 ** Math.min(attempt, 6));
  const delay = Math.round(base * (0.8 + Math.random() * 0.4));
  attempt += 1;
  notify(attempt > 1 ? 'reconnecting' : 'offline', error);
  const currentGeneration = generation;
  retryTimer = setTimeout(() => {
    if (currentGeneration === generation) void connect(currentGeneration);
  }, delay);
}

async function connect(currentGeneration: number) {
  if (stopped || currentGeneration !== generation) return;

  let token = refreshBeforeReconnect ? null : getAccessToken();
  refreshBeforeReconnect = false;
  if (!token) {
    try {
      token = await refreshAccessToken();
    } catch (error) {
      if (currentGeneration === generation) {
        scheduleReconnect(error instanceof Error ? error.message : 'Session refresh failed.');
      }
      return;
    }
  }
  if (stopped || currentGeneration !== generation) return;
  if (!token) {
    stopped = true;
    notify('offline', 'Your session has expired. Sign in again to reconnect.');
    return;
  }

  try {
    const ws = new WebSocket(socketUrl(), socketProtocols(token));
    socket = ws;
    ws.addEventListener('open', () => {
      if (socket !== ws || stopped) return;
      notify('connecting');
      ws.send(JSON.stringify({ event: 'auth', data: { accessToken: token } }));
    });
    ws.addEventListener('message', (message) => {
      if (socket !== ws) return;
      let envelope: OrbitEnvelope;
      try {
        const parsed: unknown = JSON.parse(String(message.data));
        envelope = normalizeOrbitMessage(parsed);
      } catch {
        ws.close(4400, 'Invalid WebSocket response');
        return;
      }

      const data = envelope.data;
      const ack = data && typeof data === 'object' ? data as { id?: string; type?: string; payload?: unknown; message?: string; error?: string } : null;
      const ackType = ack?.type ?? envelope.event;
      if (import.meta.env.DEV && (ackType === 'message.ack' || ackType === 'message.error')) {
        const payload = ack?.payload && typeof ack.payload === 'object'
          ? ack.payload as { code?: string }
          : undefined;
        console.debug('[Orbit WS] message response', {
          type: ackType,
          requestId: ack?.id,
          errorCode: payload?.code,
        });
      }
      const shouldResolvePending = (envelope.event === 'message.send' || envelope.event === 'message.ack' || ackType === 'message.ack' || ackType === 'message.error' || ackType === 'message.send') && !!ack?.id;
      if (shouldResolvePending) {
        const pending = pendingRequests.get(ack!.id!);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(ack!.id!);
          if (ackType === 'message.error') {
            const payload = ack!.payload as { code?: string; message?: string } | undefined;
            const error = new Error(payload?.message ?? 'The server could not save this message.');
            Object.assign(error, { code: payload?.code ?? 'MESSAGE_SEND_FAILED' });
            pending.reject(error);
          } else {
            pending.resolve(ack!.payload ?? data);
          }
        }
      }

      if (envelope.event === 'exception' && data && typeof data === 'object') {
        const exception = data as { message?: string; cause?: { data?: { clientMsgId?: string } } };
        const clientMsgId = exception.cause?.data?.clientMsgId;
        if (clientMsgId) {
          const pending = pendingRequests.get(clientMsgId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingRequests.delete(clientMsgId);
            pending.reject(new Error(exception.message ?? 'The server rejected the message.'));
          }
        }
      }

      for (const listener of envelopeListeners) listener(envelope);

      if ((envelope.event === 'auth' || envelope.event === 'auth.ok' || envelope.event === 'auth.error') && data && typeof data === 'object') {
        const response = data as { type?: string; error?: string; message?: string };
        if (response.type === 'auth.ok' || envelope.event === 'auth.ok') {
          attempt = 0;
          notify('connected');
        } else if (response.type === 'auth.error' || response.error || response.message || envelope.event === 'auth.error') {
          refreshBeforeReconnect = true;
          notify('auth_failed', response.error ?? response.message ?? 'WebSocket authentication failed.');
          ws.close(4401, response.error ?? response.message ?? 'WebSocket authentication failed.');
        }
      }
      if (envelope.event === 'exception') {
        const error = data && typeof data === 'object' && 'message' in data
          ? String(data.message)
          : 'The server rejected a WebSocket event.';
        notify(state, error);
      }
    });
    ws.addEventListener('error', () => {
      if (socket === ws) notify('reconnecting', 'Could not connect to the Orbit WebSocket.');
    });
    ws.addEventListener('close', (event) => {
      if (socket !== ws || currentGeneration !== generation) return;
      socket = null;
      rejectPendingRequests('Orbit connection closed before the request was confirmed.');
      if (event.code === 4401) refreshBeforeReconnect = true;
      scheduleReconnect(event.reason || (event.code === 1000 ? '' : `Connection closed (${event.code}).`));
    });
  } catch (error) {
    if (currentGeneration === generation) {
      scheduleReconnect(error instanceof Error ? error.message : 'Could not open WebSocket.');
    }
  }
}

export function subscribeOrbitConnection(listener: SocketListener): () => void {
  listeners.add(listener);
  listener(state, lastError || undefined);
  return () => listeners.delete(listener);
}

export function subscribeOrbitEvents(listener: EnvelopeListener): () => void {
  envelopeListeners.add(listener);
  return () => envelopeListeners.delete(listener);
}

export function sendOrbitEvent(event: string, data: unknown): void {
  if (state !== 'connected' || !socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error('Orbit is not connected. The event was not sent.');
  }
  socket.send(JSON.stringify({ event, data }));
  if (import.meta.env.DEV && event === 'message.send') {
    const message = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    console.debug('[Orbit WS] sent message.send', {
      clientMsgId: typeof message.clientMsgId === 'string' ? message.clientMsgId : undefined,
      hasConversationId: typeof message.conversationId === 'string',
      hasCiphertext: typeof message.ciphertext === 'string',
      hasIv: typeof message.iv === 'string',
      hasSenderKeyVersion: Number.isInteger(message.senderKeyVersion),
      hasRecipientKeyVersion: Number.isInteger(message.recipientKeyVersion),
    });
  }
}

export function requestOrbitEvent<T>(event: string, data: unknown, requestId: string): Promise<T> {
  if (pendingRequests.has(requestId)) return Promise.reject(new Error('This request is already in progress.'));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Orbit did not confirm the message. Check the connection before retrying.'));
    }, 15_000);
    pendingRequests.set(requestId, {
      resolve: (result) => resolve(result as T),
      reject,
      timer,
    });
    try {
      sendOrbitEvent(event, data);
    } catch (error) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error('The event could not be sent.'));
    }
  });
}

function rejectPendingRequests(message: string) {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
  pendingRequests.clear();
}

export function startOrbitSocket() {
  stopped = false;
  const owner = ++ownerId;
  generation += 1;
  const currentGeneration = generation;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  attempt = 0;
  notify('idle');
  void connect(currentGeneration);
  return () => {
    if (owner !== ownerId) return;
    ownerId += 1;
    stopped = true;
    generation += 1;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    const current = socket;
    socket = null;
    current?.close(1000, 'App disconnected');
    rejectPendingRequests('Orbit connection stopped before the message was confirmed.');
    notify('offline');
  };
}

export function retryOrbitSocket() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  attempt = 0;
  generation += 1;
  stopped = false;
  const current = socket;
  socket = null;
  current?.close(1000, 'Retry requested');
  notify('connecting');
  void connect(generation);
}

subscribeAuth((event) => {
  if (event.type === 'sign-out' || event.type === 'session-expired') {
    stopped = true;
    ownerId += 1;
    generation += 1;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    socket?.close(1000, 'Session ended');
    socket = null;
    rejectPendingRequests('Your session ended before the message was confirmed.');
    notify('offline', 'Your session has ended.');
  }
});
