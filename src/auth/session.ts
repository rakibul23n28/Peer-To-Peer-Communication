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

export function replacePublicKey(publicKey: string): Promise<{ ok: true }> {
  return apiRequest<{ ok: true }>("/users/me/public-key", {
    method: "PUT",

    body: JSON.stringify({ publicKey }),
  })
}
