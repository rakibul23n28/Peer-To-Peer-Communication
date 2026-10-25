import { Inject, Injectable } from "@nestjs/common"

import { MessageKind, Prisma, ReceiptStatus, WhisperMode } from "@prisma/client"

import { PrismaService } from "../prisma/prisma.service.js"

import { prismaBytes } from "../prisma/bytes.js"

import { badRequest, notFound } from "../shared/http-error.filter.js"

import { ConversationsRepository } from "../conversations/conversations.repository.js"

export interface NewMessage {
  clientMsgId: string

  ciphertext: Buffer

  iv: Buffer

  keyVersion: number

  senderKeyVersion: number

  recipientKeyVersion: number

  kind: MessageKind

  replyToId?: string

  whisperMode?: WhisperMode

  whisperTtlS?: number
}

@Injectable()
export class MessagesRepository {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,

    @Inject(ConversationsRepository)
    private readonly conversations: ConversationsRepository,
  ) {}

  async list(conversationId: string, userId: string, cursor?: string) {
    await this.conversations.getMemberConversation(conversationId, userId)

    const cursorSeq = cursor ? BigInt(cursor) : undefined

    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,

        ...(cursorSeq === undefined ? {} : { seq: { lt: cursorSeq } }),
      },

      include: {
        receipts: { select: { userId: true, status: true, at: true } },

        reactions: { select: { userId: true, reactionEnc: true, iv: true } },

        file: true,
      },

      orderBy: { seq: "desc" },

      take: 51,
    })

    const hasMore = rows.length > 50

    const page = rows.slice(0, 50).reverse()

    return {
      messages: page.map(serializeMessage),

      nextCursor: hasMore && page.length ? page[0].seq.toString() : null,
    }
  }

  async create(conversationId: string, senderId: string, input: NewMessage) {
    return this.prisma.$transaction(async (tx) => {
      const prior = await tx.message.findUnique({
        where: {
          senderId_clientMsgId: { senderId, clientMsgId: input.clientMsgId },
        },
      })

      if (prior) {
        if (prior.conversationId !== conversationId)
          throw badRequest(
            "IDEMPOTENCY_CONFLICT",
            "Message ID was already used",
          )

        return serializeMessage(prior)
      }

      await lockConversation(tx, conversationId, senderId)

      if (input.replyToId) {
        const reply = await tx.message.findFirst({
          where: { id: input.replyToId, conversationId },

          select: { id: true },
        })

        if (!reply) throw notFound("Reply target not found")
      }

      const [updatedConversation] = await tx.$queryRaw<{ last_seq: bigint }[]>`
        UPDATE conversations
           SET last_seq = last_seq + 1
         WHERE id = ${conversationId}::uuid
         RETURNING last_seq
      `
      if (!updatedConversation) throw notFound("Conversation not found")
      const seq = updatedConversation.last_seq

      const message = await tx.message.create({
        data: {
          conversationId,

          senderId,

          clientMsgId: input.clientMsgId,

          seq,

          ciphertext: prismaBytes(input.ciphertext),

          iv: prismaBytes(input.iv),

          keyVersion: input.keyVersion,

          senderKeyVersion: input.senderKeyVersion,

          recipientKeyVersion: input.recipientKeyVersion,

          kind: input.kind,

          replyToId: input.replyToId,

          whisperMode: input.whisperMode,

          whisperTtlS: input.whisperTtlS,
        },
      })

      return serializeMessage(message)
    })
  }

  async edit(
    conversationId: string,
    messageId: string,
    senderId: string,
    input: { ciphertext: Buffer; iv: Buffer; keyVersion: number },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockConversation(tx, conversationId, senderId)

      const message = await tx.message.findFirst({
        where: { id: messageId, conversationId, senderId, deletedAt: null },
        select: { id: true },
      })
      if (!message) throw notFound("Message not found")

      await tx.message.update({
        where: { id: messageId },
        data: {
          ciphertext: prismaBytes(input.ciphertext),
          iv: prismaBytes(input.iv),
          keyVersion: input.keyVersion,
          editedAt: new Date(),
        },
      })

      return { ok: true as const }
    })
  }

  async addReceipt(
    conversationId: string,
    messageId: string,
    userId: string,
    status: ReceiptStatus,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockConversation(tx, conversationId, userId)

      const message = await tx.message.findFirst({
        where: { id: messageId, conversationId, deletedAt: null },

        select: { id: true },
      })

      if (!message) throw notFound("Message not found")

      await tx.messageReceipt.upsert({
        where: { messageId_userId_status: { messageId, userId, status } },

        create: { messageId, userId, status },

        update: { at: new Date() },
      })

      return { ok: true as const }
    })
  }

  async setReaction(
    conversationId: string,

    messageId: string,

    userId: string,

    reactionEnc: Buffer,

    iv: Buffer,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockConversation(tx, conversationId, userId)

      const message = await tx.message.findFirst({
        where: { id: messageId, conversationId, deletedAt: null },

        select: { id: true },
      })

      if (!message) throw notFound("Message not found")

      await tx.reaction.upsert({
        where: { messageId_userId: { messageId, userId } },

        create: {
          messageId,
          userId,
          reactionEnc: prismaBytes(reactionEnc),
          iv: prismaBytes(iv),
        },

        update: { reactionEnc: prismaBytes(reactionEnc), iv: prismaBytes(iv) },
      })

      return { ok: true as const }
    })
  }

  async removeReaction(
    conversationId: string,
    messageId: string,
    userId: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockConversation(tx, conversationId, userId)

      const message = await tx.message.findFirst({
        where: { id: messageId, conversationId },

        select: { id: true },
      })

      if (!message) throw notFound("Message not found")

      await tx.reaction.deleteMany({ where: { messageId, userId } })

      return { ok: true as const }
    })
  }

  async tombstone(conversationId: string, messageId: string, senderId: string) {
    return this.prisma.$transaction(async (tx) => {
      await lockConversation(tx, conversationId, senderId)

      const message = await tx.message.findFirst({
        where: { id: messageId, conversationId, senderId, deletedAt: null },

        select: { id: true },
      })

      if (!message) throw notFound("Message not found")

      await tx.fileTransfer.deleteMany({ where: { messageId } })

      await tx.reaction.deleteMany({ where: { messageId } })

      await tx.message.update({
        where: { id: messageId },

        data: { deletedAt: new Date(), ciphertext: null, iv: null },
      })

      return { ok: true as const }
    })
  }
}

export async function lockConversation(
  tx: Prisma.TransactionClient,

  conversationId: string,

  userId: string,
): Promise<{ id: string; user_a: string; user_b: string }> {
  const rows = await tx.$queryRaw<{
    id: string
    user_a: string
    user_b: string
  }[]>`
    SELECT id, user_a, user_b
      FROM conversations
     WHERE id = ${conversationId}::uuid
     FOR UPDATE
  `

  const conversation = rows[0]

  if (
    !conversation ||
    (conversation.user_a !== userId && conversation.user_b !== userId)
  ) {
    throw notFound("Conversation not found")
  }

  return conversation
}

function serializeMessage(
  message: Prisma.MessageGetPayload<{
    include: {
      receipts: true

      reactions: true

      file: true
    }
  }> | Prisma.MessageGetPayload<object>,
) {
  const extended = message as typeof message & {
    receipts?: Array<{ userId: string; status: ReceiptStatus; at: Date }>

    reactions?: Array<{ userId: string; reactionEnc: Uint8Array; iv: Uint8Array }>

    file?: {
      fileId: string

      nameEnc: Uint8Array

      nameIv: Uint8Array

      size: bigint

      mime: string

      sha256: Uint8Array

      thumbEnc: Uint8Array | null

      thumbIv: Uint8Array | null

      width: number | null

      height: number | null

      status: string
    } | null
  }

  return {
    id: message.id,

    conversationId: message.conversationId,

    senderId: message.senderId,

    clientMsgId: message.clientMsgId,

    seq: message.seq.toString(),

    ciphertext: message.ciphertext
      ? Buffer.from(message.ciphertext).toString("base64")
      : null,

    iv: message.iv ? Buffer.from(message.iv).toString("base64") : null,

    keyVersion: message.keyVersion,

    senderKeyVersion: message.senderKeyVersion,

    recipientKeyVersion: message.recipientKeyVersion,

    replyToId: message.replyToId,

    kind: message.kind,

    whisperMode: message.whisperMode,

    whisperTtlS: message.whisperTtlS,

    createdAt: message.createdAt.toISOString(),

    editedAt: message.editedAt?.toISOString() ?? null,

    deletedAt: message.deletedAt?.toISOString() ?? null,

    receipts:
      extended.receipts?.map((receipt) => ({
        userId: receipt.userId,

        status: receipt.status,

        at: receipt.at.toISOString(),
      })) ?? [],

    reactions:
      extended.reactions?.map((reaction) => ({
        userId: reaction.userId,

        reactionEnc: Buffer.from(reaction.reactionEnc).toString("base64"),

        iv: Buffer.from(reaction.iv).toString("base64"),
      })) ?? [],

    file: extended.file
      ? {
          fileId: extended.file.fileId,

          nameEnc: Buffer.from(extended.file.nameEnc).toString("base64"),

          nameIv: Buffer.from(extended.file.nameIv).toString("base64"),

          size: extended.file.size.toString(),

          mime: extended.file.mime,

          sha256: Buffer.from(extended.file.sha256).toString("base64"),

          thumbEnc: extended.file.thumbEnc
            ? Buffer.from(extended.file.thumbEnc).toString("base64")
            : null,

          thumbIv: extended.file.thumbIv
            ? Buffer.from(extended.file.thumbIv).toString("base64")
            : null,

          width: extended.file.width,

          height: extended.file.height,

          status: extended.file.status,
        }
      : null,
  }
}

export function decodeBase64(
  value: string,
  minLength: number,
  maxLength: number,
  label: string,
): Buffer {
  const decoded = Buffer.from(value, "base64")

  if (
    decoded.length < minLength ||
    decoded.length > maxLength ||
    decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")
  ) {
    throw badRequest("INVALID_BINARY_FIELD", `${label} is invalid`)
  }

  return decoded
}
