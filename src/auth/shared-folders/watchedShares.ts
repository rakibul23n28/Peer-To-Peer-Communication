import Dexie, { type Table } from "dexie"
import type { ClientAvailability } from "../presenceStore"

export interface WatchedShare {
  shareId: string
  conversationId: string
  createdAt: number
  lastNotifiedSince: number
  lastNotifiedAt: number
}

class PresenceLocalDatabase extends Dexie {
  watchedShares!: Table<WatchedShare, string>

  constructor() {
    super("orbit-presence-local")
    this.version(1).stores({
      watchedShares: "shareId, conversationId, createdAt, lastNotifiedSince",
    })
  }
}

const database = new PresenceLocalDatabase()

export function watchShare(
  shareId: string,
  conversationId: string,
  currentSince = 0,
): Promise<string> {
  return database.watchedShares.put({
    shareId,
    conversationId,
    createdAt: Date.now(),
    lastNotifiedSince: currentSince,
    lastNotifiedAt: 0,
  })
}

export function unwatchShare(shareId: string): Promise<void> {
  return database.watchedShares.delete(shareId)
}

export function getWatchedShare(shareId: string): Promise<WatchedShare | undefined> {
  return database.watchedShares.get(shareId)
}

export function listWatchedShares(): Promise<WatchedShare[]> {
  return database.watchedShares.toArray()
}

export function shouldNotifyAvailability(
  watch: WatchedShare,
  availability: ClientAvailability,
  now: number,
): boolean {
  return availability.state === "available" &&
    availability.since > watch.lastNotifiedSince &&
    now - watch.lastNotifiedAt >= 30_000
}

export function markWatchNotified(
  watch: WatchedShare,
  availability: ClientAvailability,
  now: number,
): WatchedShare {
  return {
    ...watch,
    lastNotifiedSince: availability.since,
    lastNotifiedAt: now,
  }
}

export function saveWatchedShare(watch: WatchedShare): Promise<string> {
  return database.watchedShares.put(watch)
}
