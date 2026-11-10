export const PRESENCE_LIMITS = {
  heartbeatMs: 25_000,
  connectionTtlMs: 60_000,
  offlineGraceMs: 8_000,
  idleAfterMs: 5 * 60_000,
  viewingRefreshMs: 20_000,
  viewingTtlMs: 45_000,
  availabilityCoalesceMs: 500,
  availabilityMessagesPerMinute: 20,
  heartbeatMessagesPerMinute: 10,
  idleMessagesPerMinute: 12,
  viewingMessagesPerMinute: 8,
  maxSnapshotPartners: 200,
} as const
