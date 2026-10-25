import { randomUUID } from "node:crypto"

import { Inject, Logger } from "@nestjs/common"

import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets"

import {
  FileTransferStatus,
  MessageKind,
  ReceiptStatus,
  WhisperMode,
} from "@prisma/client"

import { z } from "zod"
import { HttpException } from "@nestjs/common"

import { WebSocket, WebSocketServer as WsServer } from "ws"

import { AuthService } from "../auth/auth.service.js"

import { ConversationsService } from "../conversations/conversations.service.js"

import { FilesService } from "../files/files.service.js"

import { decodeBase64 } from "../messages/messages.repository.js"

import { MessagesService } from "../messages/messages.service.js"

const messageSchema = z
  .object({
    conversationId: z.string().uuid(),

    clientMsgId: z.string().uuid(),

    ciphertext: z.string(),

    iv: z.string(),

    keyVersion: z.number().int().positive(),

    senderKeyVersion: z.number().int().positive(),

    recipientKeyVersion: z.number().int().positive(),

    kind: z.nativeEnum(MessageKind),

    replyToId: z.string().uuid().optional(),

    whisperMode: z.nativeEnum(WhisperMode).optional(),

    whisperTtlS: z.number().int().positive().max(604800).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.whisperMode === undefined) === (value.whisperTtlS === undefined),
  )

const peerFileRequestSchema = z.object({
  conversationId: z.string().uuid(),
  requestId: z.string().uuid(),
}).strict()

@WebSocketGateway({ path: "/v1/ws", maxPayload: 128 * 1024 })
export class OrbitGateway implements OnGatewayConnection, OnGatewayDisconnect {
  handleProtocols(protocols: string[] | undefined): string | false {
    if (!protocols || protocols.length === 0) return "orbit.v1"
    if (protocols.includes("orbit.v1")) return "orbit.v1"
    if (protocols.some((protocol) => protocol.startsWith("orbit.token."))) return "orbit.v1"
    return false
  }

  private readonly logger = new Logger(OrbitGateway.name)

  @WebSocketServer()
  private server!: WsServer

  private readonly users = new WeakMap<WebSocket, string>()

  private readonly authTimers =
    new WeakMap<WebSocket, ReturnType<typeof setTimeout>>()

  private readonly peerFileRequests = new Map<string, {
    conversationId: string
    requesterId: string
    recipientId: string
    expiresAt: number
  }>()

  constructor(
    @Inject(AuthService)
    private readonly auth: AuthService,

    @Inject(ConversationsService)
    private readonly conversations: ConversationsService,

    @Inject(MessagesService)
    private readonly messages: MessagesService,

    @Inject(FilesService)
    private readonly files: FilesService,
  ) {}

  handleConnection(client: WebSocket): void {
    this.authTimers.set(
      client,
      setTimeout(() => client.close(4401, "Authentication required"), 5_000),
    )
  }

  handleDisconnect(client: WebSocket): void {
    const timer = this.authTimers.get(client)

    if (timer) clearTimeout(timer)
  }

  @SubscribeMessage("auth")
  async authenticate(
    @ConnectedSocket() client: WebSocket,

    @MessageBody() body: unknown,
  ) {
    try {
      const input = z
        .object({ accessToken: z.string().min(20).max(8192) })
        .strict()
        .parse(body)

      const userId = await this.auth.verifyAccessToken(input.accessToken)

      this.users.set(client, userId)

      const timer = this.authTimers.get(client)

      if (timer) clearTimeout(timer)

      return { type: "auth.ok", id: randomUUID(), ts: Date.now(), payload: {} }
    } catch (error) {
      client.close(4401, "token expired")
      throw error
    }
  }

  @SubscribeMessage("message.send")
  async sendMessage(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() body: unknown,
  ) {
    let clientMsgId = "unknown"
    try {
      const userId = await this.authenticatedUser(client)
      const input = messageSchema.parse(body)
      clientMsgId = input.clientMsgId
      const message = await this.messages.create(input.conversationId, userId, {
        ...input,
        ciphertext: decodeBase64(input.ciphertext, 1, 65_536, "Ciphertext"),
        iv: decodeBase64(input.iv, 1, 32, "IV"),
      })

      await this.broadcastToConversation(input.conversationId, userId, {
        type: "message.new",
        id: randomUUID(),
        ts: Date.now(),
        payload: message,
      })

      return {
        type: "message.ack",
        id: input.clientMsgId,
        ts: Date.now(),
        payload: { messageId: message.id, seq: message.seq },
      }
    } catch (error) {
      this.logger.warn(`Message send failed (${error instanceof Error ? error.name : "unknown"})`)
      return {
        type: "message.error",
        id: clientMsgId,
        payload: {
          code: this.safeErrorCode(error),
          message: this.safeErrorMessage(error),
        },
      }
    }
  }

  @SubscribeMessage("message.edit")
  async editMessage(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() body: unknown,
  ) {
    const requestSchema = z.object({
      conversationId: z.string().uuid(),
      messageId: z.string().uuid(),
      ciphertext: z.string(),
      iv: z.string(),
      keyVersion: z.number().int().positive(),
    }).strict()
    let messageId = "unknown"
    try {
      const userId = await this.authenticatedUser(client)
      const input = requestSchema.parse(body)
      messageId = input.messageId
      await this.messages.edit(input.conversationId, input.messageId, userId, {
        ciphertext: decodeBase64(input.ciphertext, 1, 65_536, "Ciphertext"),
        iv: decodeBase64(input.iv, 1, 32, "IV"),
        keyVersion: input.keyVersion,
      })
      await this.broadcastToConversation(input.conversationId, userId, {
        type: "message.edited",
        id: randomUUID(),
        ts: Date.now(),
        payload: { messageId: input.messageId },
      })
      return { type: "message.edit.ack", id: messageId, payload: { ok: true } }
    } catch (error) {
      this.logger.warn(`Message edit failed (${error instanceof Error ? error.name : "unknown"})`)
      return { type: "message.error", id: messageId, payload: { message: this.safeErrorMessage(error) } }
    }
  }

  @SubscribeMessage("receipt.add")
  async addReceipt(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() body: unknown,
  ) {
    const userId = await this.authenticatedUser(client)

    const input = z
      .object({
        conversationId: z.string().uuid(),

        messageId: z.string().uuid(),

        status: z.nativeEnum(ReceiptStatus),
      })
      .strict()
      .parse(body)

    const result = await this.messages.addReceipt(
      input.conversationId,
      input.messageId,
      userId,
      input.status,
    )

    await this.broadcastToConversation(input.conversationId, userId, {
      type: "receipt.updated",

      id: randomUUID(),

      ts: Date.now(),

      payload: { messageId: input.messageId, userId, status: input.status },
    })

    return result
  }

  @SubscribeMessage("file.offer")
  async offerFile(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() body: unknown,
  ) {
    const userId = await this.authenticatedUser(client)

    const input = z
      .object({
        conversationId: z.string().uuid(),

        fileId: z.string().uuid(),

        clientMsgId: z.string().uuid(),

        ciphertext: z.string(),

        iv: z.string(),

        keyVersion: z.number().int().positive(),

        nameEnc: z.string(),

        nameIv: z.string(),

        size: z.string().regex(/^\d{1,18}$/),

        mime: z.string().min(1).max(255),

        sha256: z.string(),

        thumbEnc: z.string().optional(),

        thumbIv: z.string().optional(),

        width: z.number().int().positive().optional(),

        height: z.number().int().positive().optional(),
      })
      .strict()
      .parse(body)

    const file = await this.files.offer(input.conversationId, userId, {
      fileId: input.fileId,

      clientMsgId: input.clientMsgId,

      ciphertext: decodeBase64(input.ciphertext, 1, 65_536, "Ciphertext"),

      iv: decodeBase64(input.iv, 1, 32, "IV"),

      keyVersion: input.keyVersion,

      nameEnc: decodeBase64(input.nameEnc, 1, 65_536, "Encrypted file name"),

      nameIv: decodeBase64(input.nameIv, 1, 32, "File name IV"),

      size: BigInt(input.size),

      mime: input.mime,

      sha256: decodeBase64(input.sha256, 32, 32, "SHA-256 digest"),

      thumbEnc: input.thumbEnc
        ? decodeBase64(input.thumbEnc, 1, 4096, "Encrypted thumbnail")
        : undefined,

      thumbIv: input.thumbIv
        ? decodeBase64(input.thumbIv, 1, 32, "Thumbnail IV")
        : undefined,

      width: input.width,

      height: input.height,
    })

    await this.broadcastToConversation(input.conversationId, userId, {
      type: "file.offered",

      id: randomUUID(),

      ts: Date.now(),

      payload: file,
    })

    return file
  }

  @SubscribeMessage("file.status")
  async updateFile(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() body: unknown,
  ) {
    const userId = await this.authenticatedUser(client)

    const input = z
      .object({
        conversationId: z.string().uuid(),

        fileId: z.string().uuid(),

        status: z.nativeEnum(FileTransferStatus),
      })
      .strict()
      .parse(body)

    const result = await this.files.updateStatus(
      input.conversationId,
      input.fileId,
      userId,
      input.status,
    )

    await this.broadcastToConversation(input.conversationId, userId, {
      type: "file.status",

      id: randomUUID(),

      ts: Date.now(),

      payload: result,
    })

    return result
  }

  @SubscribeMessage("file.peer.request")
  async requestPeerFileShare(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() body: unknown,
  ) {
    const userId = await this.authenticatedUser(client)
    const input = peerFileRequestSchema.parse(body)
    const [requesterId, recipientId] = await this.conversations.memberIds(input.conversationId, userId)
    const recipient = requesterId === userId ? recipientId : requesterId
    this.peerFileRequests.set(input.requestId, {
      conversationId: input.conversationId,
      requesterId: userId,
      recipientId: recipient,
      expiresAt: Date.now() + 120_000,
    })
    this.sendToUser(recipient, {
      type: "file.peer.request",
      id: randomUUID(),
      ts: Date.now(),
      payload: { requestId: input.requestId, conversationId: input.conversationId, requesterId: userId },
    })
    return { type: "file.peer.request.ack", id: input.requestId, payload: { delivered: true } }
  }

  @SubscribeMessage("file.peer.response")
  async respondToPeerFileShare(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() body: unknown,
  ) {
    const userId = await this.authenticatedUser(client)
    const input = z.object({
      conversationId: z.string().uuid(),
      requestId: z.string().uuid(),
      accepted: z.boolean(),
    }).strict().parse(body)
    const request = this.peerFileRequests.get(input.requestId)
    if (
      !request ||
      request.expiresAt < Date.now() ||
      request.conversationId !== input.conversationId ||
      request.recipientId !== userId
    ) {
      this.peerFileRequests.delete(input.requestId)
      return { type: "file.peer.response.error", id: input.requestId, payload: { message: "This file-sharing request has expired or is no longer available." } }
    }
    this.peerFileRequests.delete(input.requestId)
    this.sendToUser(request.requesterId, {
      type: "file.peer.response",
      id: randomUUID(),
      ts: Date.now(),
      payload: { requestId: input.requestId, conversationId: input.conversationId, accepted: input.accepted },
    })
    return { type: "file.peer.response.ack", id: input.requestId, payload: { ok: true } }
  }

  private async authenticatedUser(client: WebSocket): Promise<string> {
    const userId = this.users.get(client)

    if (!userId) {
      client.close(4401, "Authentication required")

      throw new Error("Authentication required")
    }

    return userId
  }

  private async broadcastToConversation(
    conversationId: string,

    senderId: string,

    event: Record<string, unknown>,
  ): Promise<void> {
    const members = await this.conversations.memberIds(conversationId, senderId)

    const type = String(event.type ?? "orbit.event")
    const serialized = JSON.stringify({ event: type, data: event })

    for (const client of this.server.clients) {
      if (client.readyState !== WebSocket.OPEN) continue

      const userId = this.users.get(client)

      if (userId && members.includes(userId)) client.send(serialized)
    }
  }

  private sendToUser(userId: string, event: Record<string, unknown>): void {
    const serialized = JSON.stringify({ event: event.type, data: event })
    for (const client of this.server.clients) {
      if (client.readyState === WebSocket.OPEN && this.users.get(client) === userId) {
        client.send(serialized)
      }
    }
  }

  private safeErrorMessage(error: unknown): string {
    if (error instanceof HttpException) {
      const response = error.getResponse()
      if (typeof response === "object" && response !== null && "message" in response) {
        return String(response.message)
      }
      return typeof response === "string" ? response : "The request could not be completed."
    }
    if (error instanceof z.ZodError) return "The request was invalid. Check the message and retry."
    return "Orbit could not save this message. Check the connection and retry."
  }

  private safeErrorCode(error: unknown): string {
    if (error instanceof z.ZodError) return "INVALID_MESSAGE"
    if (error instanceof HttpException) {
      const response = error.getResponse()
      if (typeof response === "object" && response !== null && "code" in response) {
        return String(response.code)
      }
      return "MESSAGE_REJECTED"
    }
    return "MESSAGE_SEND_FAILED"
  }
}
