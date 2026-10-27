export interface ApiErrorEnvelope {
  error?: {
    code?: string

    message?: string

    requestId?: string
  }
}

export interface UserIdentity {
  id: string

  username: string

  displayName: string

  publicKey: string

  fingerprint: string

  keyVersion: number
}

export interface ConversationSummary {
  id: string
  peer: UserIdentity
  unreadCount: number
  lastMessage: {
    id: string
    senderId: string | null
    clientMsgId: string | null
    seq: string
    ciphertext: string
    iv: string
    keyVersion: number | null
    senderKeyVersion?: number | null
    recipientKeyVersion?: number | null
    kind: string | null
    createdAt: string | null
  } | null
}

export interface UserSearchResult {
  id: string
  username: string
  displayName: string
}

export interface EncryptedMessage {
  id: string
  conversationId: string
  senderId: string
  clientMsgId: string
  seq: string
  ciphertext: string | null
  iv: string | null
  keyVersion: number
  senderKeyVersion: number
  recipientKeyVersion: number
  replyToId: string | null
  kind: "text" | "file"
  whisperMode?: "burn_after_read" | "timed"
  whisperTtlS?: number
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  receipts: Array<{ userId: string; status: "delivered" | "read"; at: string }>
  reactions: Array<{ userId: string; reactionEnc: string; iv: string }>
  file?: {
    fileId: string
    nameEnc: string
    nameIv: string
    size: string
    mime: string
    sha256: string
    thumbEnc: string | null
    thumbIv: string | null
    width: number | null
    height: number | null
    status: 'offered' | 'accepted' | 'transferring' | 'received' | 'declined' | 'cancelled' | 'failed' | 'expired'
  } | null
}

export interface PublicKeyResponse {
  id: string
  publicKey: string
  fingerprint: string
  keyVersion: number
}

export interface TurnIceConfiguration {
  iceServers: RTCIceServer[]
  expiresAt?: number
}

export interface SessionResponse {
  accessToken: string

  user: UserIdentity
}

type AuthMessage = { type: "access-token"; token: string } | {
  type: "sign-out"
} | { type: "session-expired" }

type AuthListener = (message: AuthMessage) => void

const apiBase = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "")

const listeners = new Set<AuthListener>()

const channel =
  typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel("orbit-auth")

let accessToken: string | null = null

let refreshInFlight: Promise<string | null> | null = null

let refreshTimer: ReturnType<typeof setTimeout> | null = null

channel?.addEventListener("message", (event: MessageEvent<AuthMessage>) => {
  const message = event.data

  if (message.type === "access-token") {
    updateAccessToken(message.token, false)
  } else if (
    message.type === "sign-out" ||
    message.type === "session-expired"
  ) {
    updateAccessToken(null, false)
  }

  for (const listener of listeners) listener(message)
})

export function subscribeAuth(listener: AuthListener): () => void {
  listeners.add(listener)

  return () => listeners.delete(listener)
}

export function getAccessToken(): string | null {
  return accessToken
}

export function setAccessToken(token: string): void {
  updateAccessToken(token, true)
}

function tokenExpiry(token: string): number | null {
  try {
    const payloadPart = token.split(".")[1]

    if (!payloadPart) return null

    const payload = JSON.parse(
      atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: number }

    return typeof payload.exp === "number" ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

function scheduleRefresh(token: string): void {
  if (refreshTimer) clearTimeout(refreshTimer)

  const expiresAt = tokenExpiry(token)

  if (!expiresAt) return

  const delay = Math.max(1_000, expiresAt - Date.now() - 60_000)

  refreshTimer = setTimeout(() => {
    void refreshAccessToken().catch(() => undefined)
  }, delay)
}

function updateAccessToken(token: string | null, broadcast: boolean): void {
  accessToken = token

  if (refreshTimer) clearTimeout(refreshTimer)

  refreshTimer = null

  if (token) {
    scheduleRefresh(token)

    if (broadcast)
      channel?.postMessage({
        type: "access-token",
        token,
      } satisfies AuthMessage)
  }
}

export function clearSession(broadcast = false): void {
  updateAccessToken(null, false)

  if (broadcast) {
    channel?.postMessage({ type: "sign-out" } satisfies AuthMessage)

    for (const listener of listeners) listener({ type: "sign-out" })
  }
}

async function refreshRequest(): Promise<string | null> {
  const response = await fetch(`${apiBase}/auth/refresh`, {
    method: "POST",

    credentials: "include",

    headers: { "X-Orbit-Client": "web" },
  })

  if (response.status === 401) {
    const hadSession = accessToken !== null

    updateAccessToken(null, false)

    if (hadSession) {
      const message: AuthMessage = { type: "session-expired" }

      channel?.postMessage(message)

      for (const listener of listeners) listener(message)
    }

    return null
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorEnvelope

    throw apiError(response, body)
  }

  const body = (await response.json()) as { accessToken: string }

  updateAccessToken(body.accessToken, true)

  return body.accessToken
}

export async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request("orbit-refresh", refreshRequest)
    }

    return refreshRequest()
  })().finally(() => {
    refreshInFlight = null
  })

  return refreshInFlight
}

export class ApiError extends Error {
  constructor(
    readonly status: number,

    readonly code: string,

    message: string,

    readonly requestId?: string,

    readonly retryAfterSeconds?: number,
  ) {
    super(message)

    this.name = "ApiError"
  }
}

function apiError(response: Response, body: ApiErrorEnvelope): ApiError {
  const retryHeader = response.headers.get("Retry-After")

  return new ApiError(
    response.status,

    body.error?.code ?? "REQUEST_FAILED",

    body.error?.message ?? "The request could not be completed",

    body.error?.requestId,

    retryHeader ? Number(retryHeader) : undefined,
  )
}

export async function apiRequest<T>(
  path: string,

  init: RequestInit = {},

  options: { authenticated?: boolean; retryOnUnauthorized?: boolean } = {},
): Promise<T> {
  const authenticated = options.authenticated ?? true

  const tokenUsed = authenticated ? accessToken : null

  const headers = new Headers(init.headers)

  headers.set("X-Orbit-Client", "web")

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }

  if (tokenUsed) headers.set("Authorization", `Bearer ${tokenUsed}`)
  const response = await fetch(`${apiBase}${path}`, {
    ...init,

    headers,

    credentials: "include",
  })

  if (
    response.status === 401 &&
    authenticated &&
    options.retryOnUnauthorized !== false
  ) {
    const refreshed =
      accessToken !== tokenUsed ? accessToken : await refreshAccessToken()

    if (refreshed) {
      return apiRequest<T>(path, init, {
        authenticated,
        retryOnUnauthorized: false,
      })
    }

    updateAccessToken(null, false)

    channel?.postMessage({ type: "session-expired" } satisfies AuthMessage)

    for (const listener of listeners) listener({ type: "session-expired" })
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorEnvelope

    throw apiError(response, body)
  }

  if (response.status === 204) return undefined as T

  return response.json() as Promise<T>
}

export function getTurnIceConfiguration(): Promise<TurnIceConfiguration> {
  return apiRequest<TurnIceConfiguration>("/turn/credentials")
}

export async function signOutRequest(): Promise<void> {
  await apiRequest<{ ok: true }>("/auth/logout", { method: "POST" })

  clearSession(true)
}

export function registerRequest(input: {
  username: string

  password: string

  publicKey: string
}): Promise<SessionResponse> {
  return apiRequest<SessionResponse>(
    "/auth/register",
    {
      method: "POST",

      body: JSON.stringify(input),
    },
    { authenticated: false },
  )
}

export function loginRequest(input: {
  username: string
  password: string
}): Promise<SessionResponse> {
  return apiRequest<SessionResponse>(
    "/auth/login",
    {
      method: "POST",

      body: JSON.stringify(input),
    },
    { authenticated: false },
  )
}

export function getMe(): Promise<UserIdentity> {
  return apiRequest<UserIdentity>("/users/me")
}

export function getConversations(): Promise<{ conversations: ConversationSummary[] }> {
  return apiRequest<{ conversations: ConversationSummary[] }>("/conversations")
}

export function searchUsers(query: string): Promise<{ users: UserSearchResult[] }> {
  return apiRequest<{ users: UserSearchResult[] }>(
    `/users/search?q=${encodeURIComponent(query)}`,
  )
}

export function createConversation(peerId: string): Promise<{ conversation: { id: string } }> {
  return apiRequest<{ conversation: { id: string } }>("/conversations", {
    method: "POST",
    body: JSON.stringify({ peerId }),
  })
}

export function getMessages(
  conversationId: string,
  cursor?: string | null,
): Promise<{ messages: EncryptedMessage[]; nextCursor: string | null }> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiRequest(`/conversations/${encodeURIComponent(conversationId)}/messages${query}`)
}

export function getUserPublicKey(userId: string, keyVersion: number): Promise<PublicKeyResponse> {
  return apiRequest(`/users/${encodeURIComponent(userId)}/public-key?version=${keyVersion}`)
}

export function updateFileStatus(
  conversationId: string,
  fileId: string,
  status: 'accepted' | 'declined' | 'transferring' | 'received' | 'cancelled' | 'failed',
): Promise<{ fileId: string; status: string }> {
  return apiRequest(`/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

export interface FileOfferInput {
  fileId: string
  clientMsgId: string
  ciphertext: string
  iv: string
  keyVersion: number
  senderKeyVersion?: number
  recipientKeyVersion?: number
  nameEnc: string
  nameIv: string
  size: string
  mime: string
  sha256: string
  thumbEnc?: string
  thumbIv?: string
  width?: number
  height?: number
}

export function createFileOffer(conversationId: string, input: FileOfferInput): Promise<{
  messageId: string
  seq: string
  fileId: string
}> {
  return apiRequest(`/conversations/${encodeURIComponent(conversationId)}/files/offer`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function listBlocks(): Promise<{ blocks: UserSearchResult[] }> {
  return apiRequest('/users/me/blocks')
}

export function blockUser(userId: string): Promise<{ ok: true }> {
  return apiRequest(`/users/me/blocks/${encodeURIComponent(userId)}`, { method: 'PUT' })
}

export function unblockUser(userId: string): Promise<{ ok: true }> {
  return apiRequest(`/users/me/blocks/${encodeURIComponent(userId)}`, { method: 'DELETE' })
}

export function editMessage(
  conversationId: string,
  messageId: string,
  input: { ciphertext: string; iv: string; keyVersion: number },
): Promise<{ ok: true }> {
  return apiRequest(`/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  })
}

export function deleteMessage(conversationId: string, messageId: string): Promise<{ ok: true }> {
  return apiRequest(`/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`, {
    method: "DELETE",
  })
}

export function setMessageReaction(
  conversationId: string,
  messageId: string,
  input: { reactionEnc: string; iv: string },
): Promise<{ ok: true }> {
  return apiRequest(`/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/reaction`, {
    method: "PUT",
    body: JSON.stringify(input),
  })
}

export function removeMessageReaction(
  conversationId: string,
  messageId: string,
): Promise<{ ok: true }> {
  return apiRequest(`/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/reaction`, {
    method: "DELETE",
  })
}

export function addMessageReceipt(
  conversationId: string,
  messageId: string,
  status: "delivered" | "read",
): Promise<{ ok: true }> {
  return apiRequest(`/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/receipts`, {
    method: "POST",
    body: JSON.stringify({ status }),
  })
}

export function replacePublicKey(publicKey: string): Promise<{ ok: true }> {
  return apiRequest<{ ok: true }>("/users/me/public-key", {
    method: "PUT",

    body: JSON.stringify({ publicKey }),
  })
}
