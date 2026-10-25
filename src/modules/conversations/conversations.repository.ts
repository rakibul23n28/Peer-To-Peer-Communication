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
        lastSeq: true,
        memberA: { select: publicUserSelection },
        memberB: { select: publicUserSelection },
      },

      orderBy: { lastSeq: "desc" },
    })

    const activity = await this.prisma.$queryRaw<{
      conversation_id: string
      id: string | null
      sender_id: string | null
      client_msg_id: string | null
      seq: bigint | null
      ciphertext: Uint8Array | null
      iv: Uint8Array | null
      key_version: number | null
      kind: string | null
      created_at: Date | null
      unread_count: bigint
    }[]>`
      SELECT c.id AS conversation_id,
             latest.id,
             latest.sender_id,
             latest.client_msg_id,
             latest.seq,
             latest.ciphertext,
             latest.iv,
             latest.key_version,
             latest.kind,
             latest.created_at,
             (
               SELECT COUNT(*)
                 FROM messages unread
                 LEFT JOIN message_receipts receipt
                   ON receipt.message_id = unread.id
                  AND receipt.user_id = ${userId}::uuid
                  AND receipt.status = 'read'
                WHERE unread.conversation_id = c.id
                  AND unread.sender_id <> ${userId}::uuid
                  AND receipt.message_id IS NULL
             ) AS unread_count
        FROM conversations c
        LEFT JOIN LATERAL (
          SELECT id, sender_id, client_msg_id, seq, ciphertext, iv,
                 key_version, kind, created_at
            FROM messages
           WHERE conversation_id = c.id
           ORDER BY seq DESC
           LIMIT 1
        ) latest ON TRUE
       WHERE (c.user_a = ${userId}::uuid OR c.user_b = ${userId}::uuid)
         AND EXISTS (
           SELECT 1 FROM users active_a WHERE active_a.id = c.user_a AND active_a.deleted_at IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM users active_b WHERE active_b.id = c.user_b AND active_b.deleted_at IS NULL
         )
    `
    const activityByConversation = new Map(activity.map((item) => [item.conversation_id, item]))

    return rows.map((conversation) => {
      const peer =
        conversation.userA === userId
          ? conversation.memberB
          : conversation.memberA

      const key = peer.keys[0]
      const latest = activityByConversation.get(conversation.id)

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

        unreadCount: Number(latest?.unread_count ?? 0),

        lastMessage: latest?.id && latest.ciphertext && latest.iv
          ? {
              id: latest.id,
              senderId: latest.sender_id,
              clientMsgId: latest.client_msg_id,
              seq: latest.seq?.toString() ?? "0",
              ciphertext: Buffer.from(latest.ciphertext).toString("base64"),
              iv: Buffer.from(latest.iv).toString("base64"),
              keyVersion: latest.key_version,
              kind: latest.kind,
              createdAt: latest.created_at?.toISOString() ?? null,
            }
          : null,
      }
    }).sort((left, right) =>
      new Date(right.lastMessage?.createdAt ?? 0).getTime() -
      new Date(left.lastMessage?.createdAt ?? 0).getTime(),
    )
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
