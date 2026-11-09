import type { AccessRequestRecord } from "./session"
import type { OrbitEnvelope } from "./orbitSocket"

export type ClientPresenceStatus = "online" | "away" | "offline"
export type ClientAvailabilityState =
  | "available"
  | "needs_permission"
  | "needs_reselect"
  | "unavailable"
  | "revoked"

export interface ClientAvailability {
  shareId: string
  ownerId: string
  conversationId?: string
  state: ClientAvailabilityState
  downloads: boolean
  since: number
}

export interface ClientPresenceState {
  presence: Record<string, ClientPresenceStatus>
  availability: Record<string, ClientAvailability>
  viewers: Record<string, Array<{ userId: string; since: number }>>
  requests: Record<string, Pick<AccessRequestRecord, "id" | "conversationId" | "shareId" | "requesterId" | "ownerId" | "kind" | "status">>
}

const emptyState: ClientPresenceState = {
  presence: {},
  availability: {},
  viewers: {},
  requests: {},
}

let state = emptyState
const listeners = new Set<() => void>()

function publish(next: ClientPresenceState): void {
  state = next
  for (const listener of listeners) listener()
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null
}

function isAvailabilityState(value: unknown): value is ClientAvailabilityState {
  return value === "available" || value === "needs_permission" ||
    value === "needs_reselect" || value === "unavailable" || value === "revoked"
}

function isRequestKind(value: unknown): value is AccessRequestRecord["kind"] {
  return value === "availability" || value === "download_permission" || value === "reshare"
}

function isRequestStatus(value: unknown): value is AccessRequestRecord["status"] {
  return value === "pending" || value === "fulfilled" || value === "declined" ||
    value === "canceled" || value === "expired"
}

export function getPresenceState(): ClientPresenceState {
  return state
}

export function subscribePresence(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function replacePresenceSnapshot(snapshot: unknown): void {
  const value = objectValue(snapshot)
  if (!value) return
  const presence: ClientPresenceState["presence"] = {}
  const availability: ClientPresenceState["availability"] = {}
  if (Array.isArray(value.presence)) {
    for (const raw of value.presence) {
      const item = objectValue(raw)
      if (!item || typeof item.userId !== "string" ||
        !["online", "away", "offline"].includes(String(item.status))) continue
      presence[item.userId] = item.status as ClientPresenceStatus
    }
  }
  if (Array.isArray(value.availability)) {
    for (const raw of value.availability) {
      const item = objectValue(raw)
      if (!item || typeof item.shareId !== "string" || typeof item.ownerId !== "string" ||
        !isAvailabilityState(item.state) || item.state === "revoked" ||
        typeof item.downloads !== "boolean" || typeof item.since !== "number") continue
      availability[item.shareId] = {
        shareId: item.shareId,
        ownerId: item.ownerId,
        ...(typeof item.conversationId === "string" ? { conversationId: item.conversationId } : {}),
        state: item.state,
        downloads: item.downloads,
        since: item.since,
      }
    }
  }
  publish({ presence, availability, viewers: {}, requests: {} })
}

export function applyPresenceEvent(envelope: OrbitEnvelope): void {
  const raw = objectValue(envelope.data)
  const payload = objectValue(raw?.payload)
  if (!payload) return
  if (envelope.event === "presence.snapshot") {
    replacePresenceSnapshot(payload)
    return
  }
  if (envelope.event === "presence.update" &&
    typeof payload.userId === "string" &&
    ["online", "away", "offline"].includes(String(payload.status))) {
    const presenceStatus = payload.status as ClientPresenceStatus
    const availability = presenceStatus === "offline"
      ? Object.fromEntries(Object.entries(state.availability)
        .filter(([, item]) => item.ownerId !== payload.userId))
      : state.availability
    publish({
      ...state,
      presence: { ...state.presence, [payload.userId]: presenceStatus },
      availability,
    })
    return
  }
  if (envelope.event === "share.availability" &&
    typeof payload.shareId === "string" && typeof payload.ownerId === "string" &&
    isAvailabilityState(payload.state) && typeof payload.downloads === "boolean" &&
    typeof payload.since === "number" && Number.isFinite(payload.since) &&
    payload.since >= 0) {
    const availability = { ...state.availability }
    availability[payload.shareId] = {
      shareId: payload.shareId,
      ownerId: payload.ownerId,
      ...(typeof payload.conversationId === "string" ? { conversationId: payload.conversationId } : {}),
      state: payload.state,
      downloads: payload.downloads,
      since: payload.since,
    }
    publish({ ...state, availability })
    return
  }
  if (envelope.event === "share.viewers" && typeof payload.shareId === "string" &&
    Array.isArray(payload.viewers)) {
    const viewers = payload.viewers.flatMap((rawViewer) => {
      const viewer = objectValue(rawViewer)
      return viewer && typeof viewer.userId === "string" && typeof viewer.since === "number"
        ? [{ userId: viewer.userId, since: viewer.since }]
        : []
    })
    publish({ ...state, viewers: { ...state.viewers, [payload.shareId]: viewers } })
    return
  }
  if ((envelope.event === "access_request.created" || envelope.event === "access_request.updated") &&
    typeof payload.requestId === "string" && typeof payload.conversationId === "string" &&
    isRequestKind(payload.kind) && isRequestStatus(payload.status)) {
    const request = {
      id: payload.requestId,
      conversationId: payload.conversationId,
      shareId: typeof payload.shareId === "string" ? payload.shareId : null,
      requesterId: typeof payload.requesterId === "string" ? payload.requesterId : "",
      ownerId: typeof payload.ownerId === "string" ? payload.ownerId : "",
      kind: payload.kind,
      status: payload.status,
    }
    publish({ ...state, requests: { ...state.requests, [request.id]: request } })
  }
}

export function clearPresence(): void {
  publish(emptyState)
}
