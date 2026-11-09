import { PRESENCE_LIMITS } from "./presence.constants.js"

export type PresenceStatus = "online" | "away" | "offline"
export type AvailabilityState =
  | "available"
  | "needs_permission"
  | "needs_reselect"
  | "unavailable"
  | "revoked"

export interface ConnectionPresence {
  userId: string
  idle: boolean
  visible: boolean
  lastHeartbeatAt: number
  availability: Map<string, ConnectionAvailability>
}

export interface ConnectionAvailability {
  state: Exclude<AvailabilityState, "revoked">
  downloads: boolean
  since: number
}

export interface EffectiveAvailability {
  state: AvailabilityState
  downloads: boolean
  since: number
}

interface GracePresence {
  status: Exclude<PresenceStatus, "offline">
  expiresAt: number
}

export interface ViewingRecord {
  userId: string
  since: number
  expiresAt: number
}

export interface PresenceStore {
  connect(connectionId: string, userId: string, visible: boolean, now: number): void
  disconnect(connectionId: string): ConnectionPresence | undefined
  connection(connectionId: string): ConnectionPresence | undefined
  connectionsForUser(userId: string): ConnectionPresence[]
  heartbeat(connectionId: string, now: number): boolean
  setIdle(connectionId: string, idle: boolean): boolean
  setVisible(userId: string, visible: boolean, now: number): void
  setGraceStatus(userId: string, status: Exclude<PresenceStatus, "offline">, expiresAt: number): void
  status(userId: string, now: number): PresenceStatus
  setAvailability(connectionId: string, shareId: string, value: ConnectionAvailability): void
  clearAvailability(shareId: string): void
  availability(shareId: string, ownerId: string, now: number): EffectiveAvailability | undefined
  setViewing(shareId: string, viewerId: string, viewing: boolean, now: number): void
  viewing(shareId: string, now: number): ViewingRecord[]
  clearViewer(viewerId: string): string[]
  sweep(now: number): { connections: string[]; shares: string[]; viewers: string[] }
}

export const PRESENCE_STORE = Symbol.for("orbit.presence-store")

export class InMemoryPresenceStore implements PresenceStore {
  private readonly connectionMap = new Map<string, ConnectionPresence>()
  private readonly grace = new Map<string, GracePresence>()
  private readonly views = new Map<string, Map<string, ViewingRecord>>()

  connect(connectionId: string, userId: string, visible: boolean, now: number): void {
    this.grace.delete(userId)
    this.connectionMap.set(connectionId, {
      userId,
      idle: false,
      visible,
      lastHeartbeatAt: now,
      availability: new Map(),
    })
  }

  disconnect(connectionId: string): ConnectionPresence | undefined {
    const connection = this.connectionMap.get(connectionId)
    this.connectionMap.delete(connectionId)
    return connection
  }

  connection(connectionId: string): ConnectionPresence | undefined {
    return this.connectionMap.get(connectionId)
  }

  connectionsForUser(userId: string): ConnectionPresence[] {
    return [...this.connectionMap.values()].filter((connection) => connection.userId === userId)
  }

  heartbeat(connectionId: string, now: number): boolean {
    const connection = this.connectionMap.get(connectionId)
    if (!connection) return false
    connection.lastHeartbeatAt = now
    return true
  }

  setIdle(connectionId: string, idle: boolean): boolean {
    const connection = this.connectionMap.get(connectionId)
    if (!connection || connection.idle === idle) return false
    connection.idle = idle
    return true
  }

  setVisible(userId: string, visible: boolean, now: number): void {
    this.grace.delete(userId)
    for (const connection of this.connectionMap.values()) {
      if (connection.userId !== userId) continue
      connection.visible = visible
      connection.lastHeartbeatAt = now
      if (!visible) connection.availability.clear()
    }
  }

  setGraceStatus(userId: string, status: Exclude<PresenceStatus, "offline">, expiresAt: number): void {
    this.grace.set(userId, { status, expiresAt })
  }

  status(userId: string, now: number): PresenceStatus {
    const visible = this.connectionsForUser(userId).filter(({ visible }) => visible)
    if (visible.length > 0) return visible.every(({ idle }) => idle) ? "away" : "online"
    const grace = this.grace.get(userId)
    if (grace && grace.expiresAt > now) return grace.status
    this.grace.delete(userId)
    return "offline"
  }

  setAvailability(
    connectionId: string,
    shareId: string,
    value: ConnectionAvailability,
  ): void {
    this.connectionMap.get(connectionId)?.availability.set(shareId, value)
  }

  clearAvailability(shareId: string): void {
    for (const connection of this.connectionMap.values()) connection.availability.delete(shareId)
  }

  availability(shareId: string, ownerId: string, now: number): EffectiveAvailability | undefined {
    if (this.status(ownerId, now) === "offline") return undefined
    const values = this.connectionsForUser(ownerId)
      .filter(({ visible }) => visible)
      .map(({ availability }) => availability.get(shareId))
      .filter((value): value is NonNullable<typeof value> => Boolean(value))
    if (values.length === 0) return undefined
    const rank = { available: 4, needs_permission: 3, needs_reselect: 2, unavailable: 1 } as const
    const best = values.sort((left, right) => rank[right.state] - rank[left.state])[0]
    return {
      state: best.state,
      downloads: best.state === "available" && values.some((value) =>
        value.state === best.state && value.downloads,
      ),
      since: best.since,
    }
  }

  setViewing(shareId: string, viewerId: string, viewing: boolean, now: number): void {
    let viewers = this.views.get(shareId)
    if (!viewers && viewing) {
      viewers = new Map()
      this.views.set(shareId, viewers)
    }
    if (!viewers) return
    if (viewing) {
      const current = viewers.get(viewerId)
      viewers.set(viewerId, {
        userId: viewerId,
        since: current?.since ?? now,
        expiresAt: now + PRESENCE_LIMITS.viewingTtlMs,
      })
    } else {
      viewers.delete(viewerId)
      if (viewers.size === 0) this.views.delete(shareId)
    }
  }

  viewing(shareId: string, now: number): ViewingRecord[] {
    const viewers = this.views.get(shareId)
    if (!viewers) return []
    for (const [userId, record] of viewers) {
      if (record.expiresAt <= now) viewers.delete(userId)
    }
    if (viewers.size === 0) this.views.delete(shareId)
    return [...viewers.values()]
  }

  clearViewer(viewerId: string): string[] {
    const cleared: string[] = []
    for (const [shareId, viewers] of this.views) {
      if (!viewers.delete(viewerId)) continue
      cleared.push(shareId)
      if (viewers.size === 0) this.views.delete(shareId)
    }
    return cleared
  }

  sweep(now: number): { connections: string[]; shares: string[]; viewers: string[] } {
    const lost: string[] = []
    const shares = new Set<string>()
    for (const [connectionId, connection] of this.connectionMap) {
      if (now - connection.lastHeartbeatAt <= PRESENCE_LIMITS.connectionTtlMs) continue
      lost.push(connectionId)
      for (const shareId of connection.availability.keys()) shares.add(shareId)
    }
    const viewers: string[] = []
    for (const [shareId, entries] of this.views) {
      for (const [viewerId, record] of entries) {
        if (record.expiresAt > now) continue
        entries.delete(viewerId)
        viewers.push(shareId)
      }
      if (entries.size === 0) this.views.delete(shareId)
    }
    for (const [userId, value] of this.grace) {
      if (value.expiresAt <= now) this.grace.delete(userId)
    }
    return { connections: lost, shares: [...shares], viewers }
  }
}
