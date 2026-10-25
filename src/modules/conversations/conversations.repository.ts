import { randomUUID } from "node:crypto"

import { Inject, Injectable } from "@nestjs/common"

import { PrismaService } from "../prisma/prisma.service.js"

import { badRequest, notFound } from "../shared/http-error.filter.js"

const publicUserSelection = {
  id: true,

  username: true,

  displayName: true,

  keys: {
    where: { revokedAt: null },
    take: 1,
    select: { publicKey: true, fingerprint: true, keyVersion: true },
  },
} as const

@Injectable()
export class ConversationsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(userId: string) {
    const rows = await this.prisma.conversation.findMany({
      where: {
        OR: [{ userA: userId }, { userB: userId }],

        AND: [
          { memberA: { deletedAt: null } },
          { memberB: { deletedAt: null } },
        ],
      },

      select: {
        id: true,
        userA: true,
        userB: true,
        memberA: { select: publicUserSelection },
        memberB: { select: publicUserSelection },
      },

      orderBy: { createdAt: "desc" },
    })

    return rows.map((conversation) => {
      const peer =
        conversation.userA === userId
          ? conversation.memberB
          : conversation.memberA

      const key = peer.keys[0]

      return {
        id: conversation.id,

        peer: {
          id: peer.id,

          username: peer.username,

          displayName: peer.displayName,

          publicKey: key ? Buffer.from(key.publicKey).toString("base64") : "",

          fingerprint: key?.fingerprint ?? "",

          keyVersion: key?.keyVersion ?? 0,
        },
      }
    })
  }

  async create(userId: string, peerId: string) {
    if (userId === peerId)
      throw badRequest(
        "INVALID_CONVERSATION",
        "You cannot start a conversation with yourself",
      )

    const ordered = [userId, peerId].sort()

    const [user, peer, blocked] = await Promise.all([
      this.prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { id: true },
      }),

      this.prisma.user.findFirst({
        where: { id: peerId, deletedAt: null },
        select: { id: true },
      }),

      this.prisma.block.findFirst({
        where: {
          OR: [
            { blockerId: userId, blockedId: peerId },

            { blockerId: peerId, blockedId: userId },
          ],
        },
      }),
    ])

    if (!user || !peer) throw notFound("User not found")

    if (blocked) throw notFound("User not found")

    const [conversation] = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO conversations (id, user_a, user_b)
      VALUES (${randomUUID()}::uuid, ${ordered[0]}::uuid, ${ordered[1]}::uuid)
      ON CONFLICT (user_a, user_b) DO UPDATE
        SET user_a = EXCLUDED.user_a
      RETURNING id
    `

    if (!conversation) throw new Error("Conversation upsert returned no row")

    return conversation
  }

  async getMemberConversation(conversationId: string, userId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,

        OR: [{ userA: userId }, { userB: userId }],
      },

      select: { id: true, userA: true, userB: true },
    })

    if (!conversation) throw notFound("Conversation not found")

    return conversation
  }

  async memberIds(conversationId: string, userId: string): Promise<string[]> {
    const conversation = await this.getMemberConversation(
      conversationId,
      userId,
    )

    return [conversation.userA, conversation.userB]
  }
}
