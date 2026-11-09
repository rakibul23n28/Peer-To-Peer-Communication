import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common"

import { randomUUID } from "node:crypto"
import { PrismaService } from "../prisma/prisma.service.js"
import { SharedFoldersEvents, type SharedFolderEvent } from "../shared-folders/shared-folders-events.js"
import { SharedFoldersService } from "../shared-folders/shared-folders.service.js"
import { AccessRequestEvents } from "../access-requests/access-request-events.js"
import { PRESENCE_LIMITS } from "./presence.constants.js"
import { PresenceEvents } from "./presence-events.js"
import {
  PRESENCE_STORE,
  type AvailabilityState,
  type PresenceStore,
  type PresenceStatus,
} from "./presence-store.js"
import { PrivacySettingsEvents } from "./privacy-settings-events.js"
import { RelationshipEvents, type RelationshipChange } from "./relationship-events.js"

interface PrivacySettings {
  presenceVisible: boolean
  showViewingActivity: boolean
  acceptAccessRequests: string
}

interface AvailabilityInput {
  shareId: string
  state: Exclude<AvailabilityState, "revoked">
  downloads: boolean
  since: number
}

@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name)
  private readonly connections = new Map<string, { userId: string; lastState: PresenceStatus }>()
  private readonly rateWindows = new Map<string, number[]>()
  private readonly coalesceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pendingAvailability = new Map<string, {
    connectionId: string
    userId: string
    input: AvailabilityInput
  }>()
  private readonly availabilityBroadcasts = new Map<string, string>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribePrivacy: (() => void) | null = null
  private unsubscribeFolders: (() => void) | null = null
  private unsubscribeRelationships: (() => void) | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly folders: SharedFoldersService,
    private readonly events: PresenceEvents,
    private readonly privacySettingsEvents: PrivacySettingsEvents,
    private readonly sharedFolderEvents: SharedFoldersEvents,
    private readonly accessRequestEvents: AccessRequestEvents,
    private readonly relationshipEvents: RelationshipEvents,
    private readonly store: PresenceStore,
  ) {}

  onModuleInit(): void {
    this.unsubscribePrivacy = this.privacySettingsEvents.subscribe((userId) => {
      void this.onPrivacySettingsChanged(userId).catch((error: unknown) =>
        this.logAsyncFailure("Privacy update", error),
      )
    })
    this.unsubscribeFolders = this.sharedFolderEvents.subscribe((event) => {
      void this.onSharedFolderEvent(event).catch((error: unknown) =>
        this.logAsyncFailure("Shared-folder event", error),
      )
    })
    this.unsubscribeRelationships = this.relationshipEvents.subscribe((change) => {
      void this.onRelationshipChanged(change).catch((error: unknown) =>
        this.logAsyncFailure("Relationship update", error),
      )
    })
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((error: unknown) => this.logAsyncFailure("Presence sweep", error))
    }, 5_000)
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    this.unsubscribePrivacy?.()
    this.unsubscribePrivacy = null
    this.unsubscribeFolders?.()
    this.unsubscribeFolders = null
    this.unsubscribeRelationships?.()
    this.unsubscribeRelationships = null
    for (const timer of this.coalesceTimers.values()) clearTimeout(timer)
    this.coalesceTimers.clear()
  }

  async connect(connectionId: string, userId: string): Promise<Record<string, unknown>> {
    const before = this.store.status(userId, Date.now())
    const settings = await this.settings(userId)
    this.store.connect(connectionId, userId, settings.presenceVisible, Date.now())
    const after = this.store.status(userId, Date.now())
    this.connections.set(connectionId, { userId, lastState: after })
    if (before !== after) await this.broadcastPresence(userId, after)
    return this.snapshot(userId)
  }

  async disconnect(connectionId: string): Promise<void> {
    const state = this.connections.get(connectionId)
    this.connections.delete(connectionId)
    for (const key of this.rateWindows.keys()) {
      if (key.startsWith(`${connectionId}:`)) this.rateWindows.delete(key)
    }
    const connection = this.store.disconnect(connectionId)
    if (!state || !connection) return
    const views = this.store.clearViewer(state.userId)
    for (const shareId of views) await this.publishViewers(shareId)
    const visibleRemain = this.store.connectionsForUser(state.userId).some(({ visible }) => visible)
    if (!visibleRemain && connection.visible && state.lastState !== "offline") {
      this.store.setGraceStatus(state.userId, state.lastState, Date.now() + PRESENCE_LIMITS.offlineGraceMs)
      const timer = setTimeout(() => {
        if (this.store.connectionsForUser(state.userId).some(({ visible }) => visible)) return
        void this.broadcastPresence(state.userId, "offline").catch((error: unknown) =>
          this.logAsyncFailure("Presence update", error),
        )
      }, PRESENCE_LIMITS.offlineGraceMs)
      timer.unref?.()
    } else {
      const status = this.store.status(state.userId, Date.now())
      if (status !== state.lastState) await this.broadcastPresence(state.userId, status)
    }
    for (const shareId of connection.availability.keys()) {
      await this.broadcastAvailabilityForOwner(shareId, state.userId)
    }
  }

  heartbeat(connectionId: string): boolean {
    if (!this.enforceRateLimit(
      connectionId,
      "heartbeat",
      PRESENCE_LIMITS.heartbeatMessagesPerMinute,
      60_000,
    )) return false
    return this.store.heartbeat(connectionId, Date.now())
  }

  async setIdle(connectionId: string, idle: boolean): Promise<boolean> {
    if (!this.enforceRateLimit(
      connectionId,
      "idle",
      PRESENCE_LIMITS.idleMessagesPerMinute,
      60_000,
    )) return false
    const connection = this.store.connection(connectionId)
    if (!connection?.visible || !this.store.setIdle(connectionId, idle)) return Boolean(connection)
    const state = this.store.status(connection.userId, Date.now())
    const owner = this.connections.get(connectionId)
    if (owner?.lastState === state) return true
    if (owner) owner.lastState = state
    await this.broadcastPresence(connection.userId, state)
    return true
  }

  async setAvailability(connectionId: string, input: AvailabilityInput): Promise<void> {
    if (!this.enforceRateLimit(
      connectionId,
      "availability",
      PRESENCE_LIMITS.availabilityMessagesPerMinute,
      60_000,
    )) throw new Error("Availability updates are rate limited")
    const connection = this.store.connection(connectionId)
    if (!connection) throw new Error("Presence connection is unavailable")
    const context = await this.folders.previewContext(input.shareId, connection.userId)
    if (context.ownerId !== connection.userId) {
      throw new Error("Only the folder owner can report availability")
    }
    const settings = await this.settings(connection.userId)
    if (!settings.presenceVisible) return
    const key = `${connectionId}:${input.shareId}`
    this.pendingAvailability.set(key, { connectionId, userId: connection.userId, input })
    if (this.coalesceTimers.has(key)) return
    const timer = setTimeout(() => {
      this.coalesceTimers.delete(key)
      const pending = this.pendingAvailability.get(key)
      this.pendingAvailability.delete(key)
      if (!pending || !this.store.connection(pending.connectionId)) return
      this.store.setAvailability(pending.connectionId, pending.input.shareId, {
        state: pending.input.state,
        downloads: pending.input.downloads,
        since: pending.input.since,
      })
      void this.broadcastAvailabilityForOwner(pending.input.shareId, pending.userId).catch((error: unknown) =>
        this.logAsyncFailure("Availability update", error),
      )
      void this.fulfillAvailabilityRequests(pending.input.shareId, pending.input).catch((error: unknown) =>
        this.logAsyncFailure("Access request fulfillment", error),
      )
    }, PRESENCE_LIMITS.availabilityCoalesceMs)
    timer.unref?.()
    this.coalesceTimers.set(key, timer)
  }

  async setViewing(connectionId: string, shareId: string, viewing: boolean): Promise<void> {
    if (!this.enforceRateLimit(
      connectionId,
      "viewing",
      PRESENCE_LIMITS.viewingMessagesPerMinute,
      60_000,
    )) throw new Error("Viewing updates are rate limited")
    const connection = this.store.connection(connectionId)
    if (!connection || !connection.visible) return
    const context = await this.folders.previewContext(shareId, connection.userId)
    if (connection.userId === context.ownerId) throw new Error("The owner cannot view their own share")
    const settings = await this.settings(connection.userId)
    const ownerSettings = await this.settings(context.ownerId)
    if (!settings.showViewingActivity || !settings.presenceVisible || !ownerSettings.presenceVisible) {
      this.store.setViewing(shareId, connection.userId, false, Date.now())
      await this.publishViewers(shareId)
      return
    }
    this.store.setViewing(shareId, connection.userId, viewing, Date.now())
    await this.publishViewers(shareId)
  }

  async snapshot(userId: string): Promise<Record<string, unknown>> {
    const partners = await this.partnerIds(userId)
    const visiblePartners = partners.filter((partner) => partner.visible)
    const conversations = await this.prisma.conversation.findMany({
      where: {
        OR: [{ userA: userId }, { userB: userId }],
        AND: [
          { memberA: { deletedAt: null } },
          { memberB: { deletedAt: null } },
        ],
      },
      select: { id: true, userA: true, userB: true },
      take: PRESENCE_LIMITS.maxSnapshotPartners,
    })
    const partnerVisibility = new Map(partners.map(({ userId: partnerId, visible }) => [partnerId, visible]))
    const allPartnerIds = [...new Set(conversations.map(({ userA, userB }) =>
      userA === userId ? userB : userA,
    ))]
    const now = Date.now()
    const presence = allPartnerIds.map((partnerId) => ({
      userId: partnerId,
      status: partnerVisibility.get(partnerId)
        ? this.store.status(partnerId, now)
        : "offline",
    }))
    const folders = await this.prisma.sharedFolder.findMany({
      where: {
        conversationId: { in: conversations.map(({ id }) => id) },
        revokedAt: null,
        ownerId: { in: visiblePartners.map(({ userId: partnerId }) => partnerId) },
      },
      select: { id: true, ownerId: true },
      take: PRESENCE_LIMITS.maxSnapshotPartners * 10,
    })
    const availability = folders.flatMap((folder) => {
      const effective = this.store.availability(folder.id, folder.ownerId, now)
      return effective ? [{
        shareId: folder.id,
        ownerId: folder.ownerId,
        ...effective,
      }] : []
    })
    return {
      presence,
      availability,
      truncated: conversations.length >= PRESENCE_LIMITS.maxSnapshotPartners,
    }
  }

  async getSnapshot(userId: string): Promise<Record<string, unknown>> {
    return this.snapshot(userId)
  }

  async revokeShare(shareId: string, conversationId: string, ownerId: string): Promise<void> {
    this.store.clearAvailability(shareId)
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, OR: [{ userA: ownerId }, { userB: ownerId }] },
      select: { userA: true, userB: true },
    })
    if (!conversation) return
    const peerId = conversation.userA === ownerId ? conversation.userB : conversation.userA
    const blocked = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: ownerId, blockedId: peerId },
          { blockerId: peerId, blockedId: ownerId },
        ],
      },
      select: { blockerId: true },
    })
    const ownerSettings = await this.settings(ownerId)
    if (blocked || !ownerSettings.presenceVisible) return
    this.events.publish({
      recipients: [peerId],
      event: "share.availability",
      payload: {
        shareId,
        ownerId,
        conversationId,
        state: "revoked",
        downloads: false,
        since: Date.now(),
      },
    })
  }

  async currentAvailability(shareId: string, ownerId: string): Promise<{
    visible: boolean
    online: boolean
    availability?: ReturnType<PresenceStore["availability"]>
  }> {
    const settings = await this.settings(ownerId)
    const status = this.store.status(ownerId, Date.now())
    return {
      visible: settings.presenceVisible,
      online: settings.presenceVisible && status !== "offline",
      availability: settings.presenceVisible
        ? this.store.availability(shareId, ownerId, Date.now())
        : undefined,
    }
  }

  connectionCanServe(connectionId: string, shareId: string): boolean {
    const connection = this.store.connection(connectionId)
    const share = connection?.availability.get(shareId)
    return Boolean(connection?.visible && share?.state === "available")
  }

  private async onRelationshipChanged(change: RelationshipChange): Promise<void> {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        OR: [
          { userA: change.userA, userB: change.userB },
          { userA: change.userB, userB: change.userA },
        ],
      },
      select: { id: true },
    })
    if (!conversation) return
    const blocked = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: change.userA, blockedId: change.userB },
          { blockerId: change.userB, blockedId: change.userA },
        ],
      },
      select: { blockerId: true },
    })
    if (blocked) {
      const shares = await this.prisma.sharedFolder.findMany({
        where: { conversationId: conversation.id, revokedAt: null },
        select: { id: true, ownerId: true },
      })
      for (const share of shares) {
        const viewerId = share.ownerId === change.userA ? change.userB : change.userA
        this.store.setViewing(share.id, viewerId, false, Date.now())
        this.events.publish({
          recipients: [share.ownerId],
          event: "share.viewers",
          payload: { shareId: share.id, viewers: [] },
        })
      }
      this.publishPresenceTo(change.userA, change.userB, "offline")
      this.publishPresenceTo(change.userB, change.userA, "offline")
      return
    }
    for (const [observerId, subjectId] of [
      [change.userA, change.userB],
      [change.userB, change.userA],
    ]) {
      const settings = await this.settings(subjectId)
      this.publishPresenceTo(
        observerId,
        subjectId,
        settings.presenceVisible ? this.store.status(subjectId, Date.now()) : "offline",
      )
    }
    await this.broadcastCurrentAvailability(change.userA)
    await this.broadcastCurrentAvailability(change.userB)
  }

  private async onPrivacySettingsChanged(userId: string): Promise<void> {
    const settings = await this.settings(userId)
    const previous = this.store.status(userId, Date.now())
    this.store.setVisible(userId, settings.presenceVisible, Date.now())
    const current = settings.presenceVisible ? this.store.status(userId, Date.now()) : "offline"
    if (previous !== current || !settings.presenceVisible) await this.broadcastPresence(userId, current)
    if (!settings.presenceVisible) {
      for (const key of this.availabilityBroadcasts.keys()) {
        if (key.startsWith(`${userId}:`)) this.availabilityBroadcasts.delete(key)
      }
    }
    if (!settings.showViewingActivity || !settings.presenceVisible) {
      for (const shareId of this.store.clearViewer(userId)) await this.publishViewers(shareId)
    }
    if (settings.presenceVisible) {
      await this.broadcastCurrentAvailability(userId)
    }
  }

  private async onSharedFolderEvent(event: SharedFolderEvent): Promise<void> {
    if (event.type === "shared_folder.revoked") {
      await this.revokeShare(event.id, event.conversationId, event.ownerId)
      return
    }
    const requests = await this.prisma.accessRequest.findMany({
      where: {
        conversationId: event.conversationId,
        ownerId: event.ownerId,
        kind: "reshare",
        status: "pending",
        OR: [{ shareId: null }, { shareId: { not: event.id } }],
      },
      select: { id: true, conversationId: true, shareId: true, requesterId: true, ownerId: true, kind: true },
    })
    for (const request of requests) {
      if (await this.isBlocked(request.requesterId, request.ownerId)) continue
      const updated = await this.prisma.accessRequest.update({
        where: { id: request.id },
        data: { status: "fulfilled", resolvedAt: new Date() },
        select: { status: true },
      })
      this.accessRequestEvents.publish({
        type: "access_request.updated",
        requestId: request.id,
        conversationId: request.conversationId,
        shareId: request.shareId,
        requesterId: request.requesterId,
        ownerId: request.ownerId,
        kind: request.kind,
        status: updated.status,
      })
    }
  }

  private async fulfillAvailabilityRequests(
    shareId: string,
    input: AvailabilityInput,
  ): Promise<void> {
    if (input.state !== "available") return
    const requests = await this.prisma.accessRequest.findMany({
      where: {
        shareId,
        status: "pending",
        OR: [
          { kind: "availability" },
          ...(input.downloads ? [{ kind: "download_permission" }] : []),
        ],
      },
      select: {
        id: true,
        conversationId: true,
        shareId: true,
        requesterId: true,
        ownerId: true,
        kind: true,
      },
    })
    for (const request of requests) {
      if (await this.isBlocked(request.requesterId, request.ownerId)) continue
      const updated = await this.prisma.accessRequest.updateMany({
        where: { id: request.id, status: "pending" },
        data: { status: "fulfilled", resolvedAt: new Date() },
      })
      if (updated.count !== 1) continue
      this.accessRequestEvents.publish({
        type: "access_request.updated",
        requestId: request.id,
        conversationId: request.conversationId,
        shareId: request.shareId,
        requesterId: request.requesterId,
        ownerId: request.ownerId,
        kind: request.kind,
        status: "fulfilled",
      })
    }
  }

  private async broadcastCurrentAvailability(userId: string): Promise<void> {
    const connections = this.store.connectionsForUser(userId)
    const shares = new Map<string, string>()
    for (const connection of connections) {
      for (const shareId of connection.availability.keys()) shares.set(shareId, userId)
    }
    for (const shareId of shares.keys()) await this.broadcastAvailabilityForOwner(shareId, userId)
  }

  private async broadcastAvailabilityForOwner(shareId: string, ownerId: string): Promise<void> {
    const current = await this.currentAvailability(shareId, ownerId)
    const key = `${ownerId}:${shareId}`
    if (!current.visible || !current.online || !current.availability) {
      this.availabilityBroadcasts.delete(key)
      return
    }
    const context = await this.folders.previewContext(shareId, ownerId).catch(() => null)
    if (!context) return
    const signature = JSON.stringify(current.availability)
    if (this.availabilityBroadcasts.get(key) === signature) return
    this.availabilityBroadcasts.set(key, signature)
    const recipients = context.participantIds.filter((userId) => userId !== ownerId)
    if (recipients.length === 0) return
    this.events.publish({
      recipients,
      event: "share.availability",
      payload: {
        shareId,
        ownerId,
        conversationId: context.conversationId,
        ...current.availability,
      },
    })
  }

  private async broadcastPresence(userId: string, status: PresenceStatus): Promise<void> {
    const recipients = await this.partnerIds(userId)
    for (const recipient of recipients) this.publishPresenceTo(recipient.userId, userId, status)
  }

  private publishPresenceTo(observerId: string, subjectId: string, status: PresenceStatus): void {
    this.events.publish({
      recipients: [observerId],
      event: "presence.update",
      payload: { userId: subjectId, status },
    })
  }

  private async publishViewers(shareId: string): Promise<void> {
    const share = await this.prisma.sharedFolder.findFirst({
      where: { id: shareId, revokedAt: null },
      select: { ownerId: true },
    })
    if (!share) return
    const context = await this.folders.previewContext(shareId, share.ownerId).catch(() => null)
    if (!context) return
    const ownerSettings = await this.settings(share.ownerId)
    if (!ownerSettings.presenceVisible) return
    const viewers = this.store.viewing(shareId, Date.now())
    const visibleViewers: Array<{ userId: string; since: number }> = []
    for (const viewer of viewers) {
      const settings = await this.settings(viewer.userId)
      if (settings.presenceVisible && settings.showViewingActivity) {
        visibleViewers.push({ userId: viewer.userId, since: viewer.since })
      } else {
        this.store.setViewing(shareId, viewer.userId, false, Date.now())
      }
    }
    this.events.publish({
      recipients: [share.ownerId],
      event: "share.viewers",
      payload: { shareId, viewers: visibleViewers },
    })
  }

  private async partnerIds(userId: string): Promise<Array<{ userId: string; visible: boolean }>> {
    const rows = await this.prisma.conversation.findMany({
      where: {
        OR: [{ userA: userId }, { userB: userId }],
        AND: [
          { memberA: { deletedAt: null } },
          { memberB: { deletedAt: null } },
        ],
      },
      select: { userA: true, userB: true },
      take: PRESENCE_LIMITS.maxSnapshotPartners + 1,
    })
    const ids = [...new Set(rows.map(({ userA, userB }) => userA === userId ? userB : userA))]
      .slice(0, PRESENCE_LIMITS.maxSnapshotPartners)
    if (ids.length === 0) return []
    const blocks = await this.prisma.block.findMany({
      where: {
        OR: [
          { blockerId: userId, blockedId: { in: ids } },
          { blockerId: { in: ids }, blockedId: userId },
        ],
      },
      select: { blockerId: true, blockedId: true },
    })
    const blocked = new Set(blocks.map(({ blockerId, blockedId }) =>
      blockerId === userId ? blockedId : blockerId,
    ))
    const unblocked = ids.filter((id) => !blocked.has(id))
    const privacy = await this.prisma.userPrivacySettings.findMany({
      where: { userId: { in: unblocked } },
      select: { userId: true, presenceVisible: true },
    })
    const visibility = new Map(privacy.map(({ userId: id, presenceVisible }) => [id, presenceVisible]))
    return unblocked.map((id) => ({ userId: id, visible: visibility.get(id) ?? true }))
  }

  private async settings(userId: string): Promise<PrivacySettings> {
    const value = await this.prisma.userPrivacySettings.findUnique({
      where: { userId },
      select: {
        presenceVisible: true,
        showViewingActivity: true,
        acceptAccessRequests: true,
      },
    })
    return value ?? {
      presenceVisible: true,
      showViewingActivity: true,
      acceptAccessRequests: "contacts",
    }
  }

  private async isBlocked(userA: string, userB: string): Promise<boolean> {
    return Boolean(await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: userA, blockedId: userB },
          { blockerId: userB, blockedId: userA },
        ],
      },
      select: { blockerId: true },
    }))
  }

  private enforceRateLimit(
    connectionId: string,
    event: string,
    limit: number,
    windowMs: number,
  ): boolean {
    const now = Date.now()
    const key = `${connectionId}:${event}`
    const recent = (this.rateWindows.get(key) ?? [])
      .filter((timestamp) => now - timestamp < windowMs)
    if (recent.length >= limit) return false
    recent.push(now)
    this.rateWindows.set(key, recent)
    return true
  }

  private async sweep(): Promise<void> {
    const now = Date.now()
    const expired = this.store.sweep(now)
    for (const connectionId of expired.connections) await this.disconnect(connectionId)
    for (const shareId of new Set(expired.viewers)) await this.publishViewers(shareId)
  }

  createConnectionId(): string {
    return randomUUID()
  }

  private logAsyncFailure(action: string, error: unknown): void {
    this.logger.warn(`${action} failed (${error instanceof Error ? error.name : "unknown"})`)
  }
}

Inject(PrismaService)(PresenceService, undefined, 0)
Inject(SharedFoldersService)(PresenceService, undefined, 1)
Inject(PresenceEvents)(PresenceService, undefined, 2)
Inject(PrivacySettingsEvents)(PresenceService, undefined, 3)
Inject(SharedFoldersEvents)(PresenceService, undefined, 4)
Inject(AccessRequestEvents)(PresenceService, undefined, 5)
Inject(RelationshipEvents)(PresenceService, undefined, 6)
Inject(PRESENCE_STORE)(PresenceService, undefined, 7)
