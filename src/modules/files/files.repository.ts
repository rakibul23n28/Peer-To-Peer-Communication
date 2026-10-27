import { Inject, Injectable } from "@nestjs/common"

import { FileTransferStatus, MessageKind } from "@prisma/client"

import { PrismaService } from "../prisma/prisma.service.js"

import { prismaBytes } from "../prisma/bytes.js"

import { badRequest, notFound } from "../shared/http-error.filter.js"

import { lockConversation } from "../messages/messages.repository.js"

export interface FileOffer {
  fileId: string

  clientMsgId: string

  ciphertext: Buffer

  iv: Buffer

  keyVersion: number

  nameEnc: Buffer

  nameIv: Buffer

  size: bigint

  mime: string

  sha256: Buffer

  thumbEnc?: Buffer

  thumbIv?: Buffer

  width?: number

  height?: number
}

@Injectable()
export class FilesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async offer(conversationId: string, senderId: string, input: FileOffer) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.message.findUnique({
        where: {
          senderId_clientMsgId: { senderId, clientMsgId: input.clientMsgId },
        },

        include: { file: true },
      })

      if (existing) {
        if (
          existing.conversationId !== conversationId ||
          existing.file?.fileId !== input.fileId
        ) {
          throw badRequest(
            "IDEMPOTENCY_CONFLICT",
            "Message ID was already used",
          )
        }

        return {
          messageId: existing.id,
          seq: existing.seq.toString(),
          fileId: input.fileId,
        }
      }

      await lockConversation(tx, conversationId, senderId)
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

          senderKeyVersion: input.keyVersion,

          recipientKeyVersion: input.keyVersion,

          kind: MessageKind.file,
        },
      })

      await tx.fileTransfer.create({
        data: {
          fileId: input.fileId,

          messageId: message.id,

          conversationId,

          senderId,

          nameEnc: prismaBytes(input.nameEnc),

          nameIv: prismaBytes(input.nameIv),

          size: input.size,

          mime: input.mime,

          sha256: prismaBytes(input.sha256),

          thumbEnc: input.thumbEnc ? prismaBytes(input.thumbEnc) : undefined,

          thumbIv: input.thumbIv ? prismaBytes(input.thumbIv) : undefined,

          width: input.width,

          height: input.height,

          status: FileTransferStatus.offered,
        },
      })

      return {
        messageId: message.id,
        seq: seq.toString(),
        fileId: input.fileId,
      }
    })
  }

  async updateStatus(
    conversationId: string,

    fileId: string,

    userId: string,

    status: FileTransferStatus,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockConversation(tx, conversationId, userId)

      const file = await tx.fileTransfer.findFirst({
        where: { fileId, conversationId },
      })

      if (!file) throw notFound("File offer not found")

      const sender = file.senderId === userId

      const isOneOf = (statuses: readonly FileTransferStatus[]) =>
        statuses.includes(status)

      const allowed =
        file.status === FileTransferStatus.offered
          ? (sender &&
              isOneOf([
                FileTransferStatus.cancelled,
                FileTransferStatus.expired,
              ])) ||
            (!sender &&
              isOneOf([
                FileTransferStatus.accepted,
                FileTransferStatus.declined,
                FileTransferStatus.expired,
              ]))
          : file.status === FileTransferStatus.accepted
            ? (sender &&
                isOneOf([
                  FileTransferStatus.transferring,
                  FileTransferStatus.cancelled,
                  FileTransferStatus.failed,
                ])) ||
              (!sender &&
                isOneOf([
                  FileTransferStatus.cancelled,
                  FileTransferStatus.failed,
                ]))
            : file.status === FileTransferStatus.transferring
              ? sender
                ? isOneOf([
                    FileTransferStatus.failed,
                    FileTransferStatus.cancelled,
                  ])
                : isOneOf([
                    FileTransferStatus.received,
                    FileTransferStatus.failed,
                    FileTransferStatus.cancelled,
                  ])
              : false

      if (!allowed) throw notFound("File offer not found")

      const updated = await tx.fileTransfer.update({
        where: { fileId },

        data: { status, updatedAt: new Date() },
      })

      return { fileId: updated.fileId, status: updated.status }
    })
  }

  members(conversationId: string) {
    return this.prisma.conversation.findUnique({
      where: { id: conversationId },

      select: { userA: true, userB: true },
    })
  }
}

Inject(PrismaService)(FilesRepository, undefined, 0)
