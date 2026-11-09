import assert from "node:assert/strict"
import test from "node:test"

import {
  markWatchNotified,
  shouldNotifyAvailability,
  type WatchedShare,
} from "../src/auth/shared-folders/watchedShares.ts"
import type { ClientAvailability } from "../src/auth/presenceStore.ts"

const watch: WatchedShare = {
  shareId: "share-a",
  conversationId: "conversation-a",
  createdAt: 1_000,
  lastNotifiedSince: 2_000,
  lastNotifiedAt: 10_000,
}

function availability(state: ClientAvailability["state"], since: number): ClientAvailability {
  return {
    shareId: "share-a",
    ownerId: "owner-a",
    state,
    downloads: false,
    since,
  }
}

test("notification policy requires an available transition newer than the saved timestamp", () => {
  assert.equal(shouldNotifyAvailability(watch, availability("available", 2_001), 40_000), true)
  assert.equal(shouldNotifyAvailability(watch, availability("available", 2_000), 40_000), false)
  assert.equal(shouldNotifyAvailability(watch, availability("needs_permission", 3_000), 40_000), false)
})

test("notification policy debounces repeated availability and records the notified transition", () => {
  assert.equal(shouldNotifyAvailability(watch, availability("available", 2_001), 39_999), false)
  const updated = markWatchNotified(watch, availability("available", 2_001), 40_000)
  assert.equal(updated.lastNotifiedSince, 2_001)
  assert.equal(updated.lastNotifiedAt, 40_000)
  assert.equal(shouldNotifyAvailability(updated, availability("available", 2_002), 50_000), false)
})
