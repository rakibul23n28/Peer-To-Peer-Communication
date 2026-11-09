import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common"
import { Prisma } from "@prisma/client"

import { PrismaService } from "../prisma/prisma.service.js"
import { notFound } from "../shared/http-error.filter.js"

export type AccessRequestKind = "availability" | "download_permission" | "reshare"
export type AccessRequestRole = "incoming" | "outgoing"

export interface CreateAccessRequest {
  requestId?: string
  conversationId: string
  shareId?: string
  requesterId: string
  kind: AccessRequestKind
  noteCiphertext?: Buffer
  noteIv?: Buffer
}

@Injectable()
export class AccessRequestsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, role: AccessRequestRole, status?: string) {
    const now = new Date()
    await this.prisma.accessRequest.updateMany({
      where: { status: "pending", expiresAt: { lte: now } },
      data: { status: "expired", resolvedAt: now },
    })
    const requests = await this.prisma.accessRequest.findMany({
      where: {
        [role === "incoming" ? "ownerId" : "requesterId"]: userId,
        ...(status ? { status } : {}),
      },
      select: {
        id: true,
        conversationId: true,
        shareId: true,
        requesterId: true,
        ownerId: true,
        kind: true,
        noteCiphertext: true,
        noteIv: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
        expiresAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    if (requests.length === 0) return requests
    const counterpartIds = [...new Set(requests.map((request) =>
      role === "incoming" ? request.requesterId : request.ownerId,
    ))]
    const blocks = await this.prisma.block.findMany({
      where: {
        OR: [
          { blockerId: userId, blockedId: { in: counterpartIds } },
          { blockerId: { in: counterpartIds }, blockedId: userId },
        ],
      },
      select: { blockerId: true, blockedId: true },
    })
    const blockedIds = new Set(blocks.map(({ blockerId, blockedId }) =>
      blockerId === userId ? blockedId : blockerId,
    ))
    return requests.filter((request) =>
      !blockedIds.has(role === "incoming" ? request.requesterId : request.ownerId),
    )
  }

  async create(input: CreateAccessRequest) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const conversation = await tx.conversation.findFirst({
          where: {
            id: input.conversationId,
            OR: [{ userA: input.requesterId }, { userB: input.requesterId }],
          },
          select: { userA: true, userB: true },
        })
        if (!conversation) throw notFound("Conversation not found")
        await tx.$queryRaw<{ id: string }[]>`
          SELECT id
            FROM conversations
           WHERE id = ${input.conversationId}::uuid
           FOR UPDATE
        `
        const ownerId = conversation.userA === input.requesterId
          ? conversation.userB
          : conversation.userA
        const blocked = await tx.block.findFirst({
          where: {
            OR: [
              { blockerId: input.requesterId, blockedId: ownerId },
              { blockerId: ownerId, blockedId: input.requesterId },
            ],
          },
          select: { blockerId: true },
        })
        if (blocked) throw notFound("Conversation not found")

        if (input.kind !== "reshare" && !input.shareId) {
          throw new ConflictException({
            code: "ACCESS_REQUEST_SHARE_REQUIRED",
            message: "Choose the shared folder this request is about.",
          })
        }
        if (input.shareId) {
          const share = await tx.sharedFolder.findFirst({
            where: {
              id: input.shareId,
              conversationId: input.conversationId,
              ownerId,
              ...(input.kind === "reshare" ? {} : { revokedAt: null }),
            },
            select: { id: true },
          })
          if (!share) throw notFound("Shared folder not found")
        }
        const settings = await tx.userPrivacySettings.findUnique({
          where: { userId: ownerId },
          select: { acceptAccessRequests: true },
        })
        if (settings?.acceptAccessRequests === "off") {
          throw new ConflictException({
            code: "ACCESS_REQUESTS_DISABLED",
            message: "This contact is not accepting access requests.",
          })
        }

        const now = new Date()
        const pending = await tx.accessRequest.count({
          where: {
            requesterId: input.requesterId,
            conversationId: input.conversationId,
            status: "pending",
          },
        })
        if (pending >= 3) {
          throw new ConflictException({
            code: "ACCESS_REQUEST_LIMIT",
            message: "You already have three pending requests in this conversation.",
          })
        }
        const duplicate = await tx.accessRequest.findFirst({
          where: {
            conversationId: input.conversationId,
            shareId: input.shareId ?? null,
            kind: input.kind,
            status: "pending",
          },
          select: { id: true },
        })
        if (duplicate) {
          throw new ConflictException({
            code: "ACCESS_REQUEST_PENDING",
            message: "A request for this action is already pending.",
          })
        }
        const cooldown = await tx.accessRequest.findFirst({
          where: {
            conversationId: input.conversationId,
            shareId: input.shareId ?? null,
            requesterId: input.requesterId,
            kind: input.kind,
            status: "declined",
            resolvedAt: { gt: new Date(now.getTime() - 10 * 60_000) },
          },
          select: { id: true },
        })
        if (cooldown) {
          throw new ConflictException({
            code: "ACCESS_REQUEST_COOLDOWN",
            message: "Please wait 10 minutes before sending this request again.",
          })
        }

        return tx.accessRequest.create({
          data: {
            ...(input.requestId ? { id: input.requestId } : {}),
            conversationId: input.conversationId,
            shareId: input.shareId,
            requesterId: input.requesterId,
            ownerId,
            kind: input.kind,
            noteCiphertext: input.noteCiphertext
              ? new Uint8Array(input.noteCiphertext)
              : undefined,
            noteIv: input.noteIv ? new Uint8Array(input.noteIv) : undefined,
            expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000),
          },
        })
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException({
          code: "ACCESS_REQUEST_PENDING",
          message: "A request for this action is already pending.",
        })
      }
      throw error
    }
  }

  async cancel(id: string, requesterId: string) {
    return this.resolve(id, requesterId, "requesterId", "canceled")
  }

  async decline(id: string, ownerId: string) {
    return this.resolve(id, ownerId, "ownerId", "declined")
  }

  private async resolve(
    id: string,
    userId: string,
    field: "requesterId" | "ownerId",
    status: "canceled" | "declined",
  ) {
    const request = await this.prisma.accessRequest.findFirst({
      where: { id, [field]: userId, status: "pending", expiresAt: { gt: new Date() } },
    })
    if (!request) throw notFound("Access request not found")
    const otherId = field === "ownerId" ? request.requesterId : request.ownerId
    const blocked = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: userId, blockedId: otherId },
          { blockerId: otherId, blockedId: userId },
        ],
      },
      select: { blockerId: true },
    })
    if (blocked) throw notFound("Access request not found")
    const now = new Date()
    const result = await this.prisma.accessRequest.updateMany({
      where: { id, status: "pending", expiresAt: { gt: now } },
      data: { status, resolvedAt: now },
    })
    if (result.count !== 1) throw notFound("Access request not found")
    return this.prisma.accessRequest.findUniqueOrThrow({ where: { id } })
  }
}
