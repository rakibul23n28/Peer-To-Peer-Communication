import assert from "node:assert/strict"
import test from "node:test"

import { InMemoryPresenceStore } from "../src/modules/presence/presence-store.ts"

test("presence is multi-connection aware and away only when every visible tab is idle", () => {
  const store = new InMemoryPresenceStore()
  store.connect("tab-a", "alice", true, 1_000)
  store.connect("tab-b", "alice", true, 1_000)

  assert.equal(store.status("alice", 1_000), "online")
  store.setIdle("tab-a", true)
  assert.equal(store.status("alice", 1_000), "online")
  store.setIdle("tab-b", true)
  assert.equal(store.status("alice", 1_000), "away")

  store.disconnect("tab-a")
  assert.equal(store.status("alice", 1_000), "away")
  store.setIdle("tab-b", false)
  assert.equal(store.status("alice", 1_000), "online")
})

test("offline grace preserves the previous visible state until expiry", () => {
  const store = new InMemoryPresenceStore()
  store.connect("tab-a", "alice", true, 1_000)
  store.disconnect("tab-a")
  store.setGraceStatus("alice", "online", 9_000)

  assert.equal(store.status("alice", 8_999), "online")
  assert.equal(store.status("alice", 9_000), "offline")
  store.connect("tab-b", "alice", true, 9_000)
  assert.equal(store.status("alice", 9_000), "online")
})

test("availability uses the best visible connection and viewing expires without activity", () => {
  const store = new InMemoryPresenceStore()
  store.connect("tab-a", "alice", true, 1_000)
  store.connect("tab-b", "alice", true, 1_000)
  store.setAvailability("tab-a", "share-a", {
    state: "needs_permission",
    downloads: false,
    since: 1_000,
  })
  store.setAvailability("tab-b", "share-a", {
    state: "available",
    downloads: true,
    since: 2_000,
  })

  assert.deepEqual(store.availability("share-a", "alice", 2_000), {
    state: "available",
    downloads: true,
    since: 2_000,
  })
  store.setViewing("share-a", "bob", true, 2_000)
  assert.deepEqual(store.viewing("share-a", 46_999).map(({ userId }) => userId), ["bob"])
  assert.deepEqual(store.viewing("share-a", 47_000), [])
})

test("appear-offline clears reported availability and hides the connection", () => {
  const store = new InMemoryPresenceStore()
  store.connect("tab-a", "alice", true, 1_000)
  store.setAvailability("tab-a", "share-a", {
    state: "available",
    downloads: true,
    since: 1_000,
  })

  store.setVisible("alice", false, 2_000)
  assert.equal(store.status("alice", 2_000), "offline")
  assert.equal(store.availability("share-a", "alice", 2_000), undefined)

  store.setVisible("alice", true, 3_000)
  assert.equal(store.status("alice", 3_000), "online")
  assert.equal(store.availability("share-a", "alice", 3_000), undefined)
})

test("heartbeat sweep identifies zombie connections without keeping them online", () => {
  const store = new InMemoryPresenceStore()
  store.connect("tab-a", "alice", true, 1_000)

  const expired = store.sweep(61_001)
  assert.deepEqual(expired.connections, ["tab-a"])
  store.disconnect("tab-a")
  assert.equal(store.status("alice", 61_001), "offline")
})
