import { Injectable } from "@nestjs/common"

import { MessageKind, ReceiptStatus, WhisperMode } from "@prisma/client"

import { MessagesRepository, type NewMessage } from "./messages.repository.js"

@Injectable()
export class MessagesService {
  constructor(private readonly repository: MessagesRepository) {}

  list(conversationId: string, userId: string, cursor?: string) {
    return this.repository.list(conversationId, userId, cursor)
  }

  create(conversationId: string, userId: string, input: NewMessage) {
    return this.repository.create(conversationId, userId, input)
  }

  addReceipt(
    conversationId: string,
    messageId: string,
    userId: string,
    status: ReceiptStatus,
  ) {
    return this.repository.addReceipt(conversationId, messageId, userId, status)
  }

  setReaction(
    conversationId: string,

    messageId: string,

    userId: string,

    reactionEnc: Buffer,

    iv: Buffer,
  ) {
    return this.repository.setReaction(
      conversationId,
      messageId,
      userId,
      reactionEnc,
      iv,
    )
  }

  removeReaction(conversationId: string, messageId: string, userId: string) {
    return this.repository.removeReaction(conversationId, messageId, userId)
  }

  tombstone(conversationId: string, messageId: string, userId: string) {
    return this.repository.tombstone(conversationId, messageId, userId)
  }

  newMessage(input: {
    clientMsgId: string

    ciphertext: Buffer

    iv: Buffer

    keyVersion: number

    kind: MessageKind

    replyToId?: string

    whisperMode?: WhisperMode

    whisperTtlS?: number
  }): NewMessage {
    return input
  }
}
