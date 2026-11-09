import { ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common"
import { Prisma } from "@prisma/client"

import { PrismaService } from "../prisma/prisma.service.js"
import { prismaBytes } from "../prisma/bytes.js"
import { notFound } from "../shared/http-error.filter.js"

export interface NewSharedFolder {
  id: string
  ciphertext: Buffer
  iv: Buffer
  formatVersion: number
  compressed: boolean
  payloadBytes: number
}

@Injectable()
export class SharedFoldersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(conversationId: string, ownerId: string, input: NewSharedFolder) {
    try {
      const record = await this.prisma.$transaction(async (tx) => {
        const conversation = await tx.conversation.findFirst({
          where: {
            id: conversationId,
            OR: [{ userA: ownerId }, { userB: ownerId }],
          },
          select: { userA: true, userB: true },
        })
        if (!conversation) throw notFound("Conversation not found")

        await tx.$queryRaw<{ id: string }[]>`
          SELECT id
            FROM conversations
           WHERE id = ${conversationId}::uuid
           FOR UPDATE
        `

        const blocked = await tx.block.findFirst({
          where: {
            OR: [
              { blockerId: conversation.userA, blockedId: conversation.userB },
              { blockerId: conversation.userB, blockedId: conversation.userA },
            ],
          },
          select: { blockerId: true },
        })
        if (blocked) {
          throw new ForbiddenException({
            code: "CONVERSATION_BLOCKED",
            message: "Folder sharing is unavailable for this conversation.",
          })
        }

        const activeCount = await tx.sharedFolder.count({
          where: { conversationId, revokedAt: null },
        })
        if (activeCount >= 10) {
          throw new ConflictException({
            code: "SHARED_FOLDER_LIMIT",
            message: "This conversation already has the maximum number of active folder shares.",
          })
        }

        return await tx.sharedFolder.create({
          data: {
            id: input.id,
            conversationId,
            ownerId,
            ciphertext: prismaBytes(input.ciphertext),
            iv: prismaBytes(input.iv),
            formatVersion: input.formatVersion,
            compressed: input.compressed,
            payloadBytes: input.payloadBytes,
          },
        })
      })
      return serializeSharedFolder(record)
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException({
          code: "SHARED_FOLDER_EXISTS",
          message: "This folder share id already exists.",
        })
      }
      throw error
    }
  }

  async list(conversationId: string, userId: string) {
    await this.requireParticipant(conversationId, userId)
    const records = await this.prisma.sharedFolder.findMany({
      where: { conversationId, revokedAt: null },
      orderBy: { createdAt: "desc" },
    })
    return records.map(serializeSharedFolder)
  }

  async get(id: string, userId: string) {
    const record = await this.prisma.sharedFolder.findFirst({
      where: {
        id,
        revokedAt: null,
        conversation: { OR: [{ userA: userId }, { userB: userId }] },
      },
    })
    if (!record) throw notFound("Shared folder not found")
    return serializeSharedFolder(record)
  }

  async previewContext(id: string, userId: string) {
    const record = await this.prisma.sharedFolder.findFirst({
      where: { id, revokedAt: null },
      select: {
        id: true,
        conversationId: true,
        ownerId: true,
        conversation: { select: { userA: true, userB: true } },
      },
    })
    if (!record) throw notFound("Shared folder not found")
    if (userId !== record.conversation.userA && userId !== record.conversation.userB) {
      throw notFound("Shared folder not found")
    }
    const blocked = await this.prisma.block.findFirst({
      where: {
        OR: [
          { blockerId: record.conversation.userA, blockedId: record.conversation.userB },
          { blockerId: record.conversation.userB, blockedId: record.conversation.userA },
        ],
      },
      select: { blockerId: true },
    })
    if (blocked) {
      throw new ForbiddenException({
        code: "CONVERSATION_BLOCKED",
        message: "Preview is unavailable for this conversation.",
      })
    }
    return {
      id: record.id,
      conversationId: record.conversationId,
      ownerId: record.ownerId,
      participantIds: [record.conversation.userA, record.conversation.userB] as const,
    }
  }

  async revoke(id: string, userId: string) {
    const record = await this.prisma.sharedFolder.findFirst({
      where: {
        id,
        revokedAt: null,
        conversation: { OR: [{ userA: userId }, { userB: userId }] },
      },
      select: { id: true, conversationId: true, ownerId: true },
    })
    if (!record) throw notFound("Shared folder not found")
    if (record.ownerId !== userId) {
      throw new ForbiddenException({
        code: "SHARED_FOLDER_OWNER_REQUIRED",
        message: "Only the owner can stop sharing this folder.",
      })
    }
    const revokedAt = new Date()
    await this.prisma.sharedFolder.update({
      where: { id },
      data: { revokedAt },
    })
    return { id: record.id, conversationId: record.conversationId }
  }

  private async requireParticipant(conversationId: string, userId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        OR: [{ userA: userId }, { userB: userId }],
      },
      select: { id: true },
    })
    if (!conversation) throw notFound("Conversation not found")
  }
}

function serializeSharedFolder(record: {
  id: string
  conversationId: string
  ownerId: string
  ciphertext: Uint8Array
  iv: Uint8Array
  formatVersion: number
  compressed: boolean
  payloadBytes: number
  createdAt: Date
  revokedAt: Date | null
}) {
  return {
    id: record.id,
    conversationId: record.conversationId,
    ownerId: record.ownerId,
    ciphertext: Buffer.from(record.ciphertext).toString("base64"),
    iv: Buffer.from(record.iv).toString("base64"),
    formatVersion: record.formatVersion,
    compressed: record.compressed,
    payloadBytes: record.payloadBytes,
    createdAt: record.createdAt.toISOString(),
    revokedAt: record.revokedAt?.toISOString() ?? null,
  }
}

Inject(PrismaService)(SharedFoldersRepository, undefined, 0)
