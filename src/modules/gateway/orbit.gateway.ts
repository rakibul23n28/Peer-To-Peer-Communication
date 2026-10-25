import { randomUUID } from "node:crypto"

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

@WebSocketGateway({ path: "/v1/ws", maxPayload: 128 * 1024 })
export class OrbitGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: WsServer

  private readonly users = new WeakMap<WebSocket, string>()

  private readonly authTimers =
    new WeakMap<WebSocket, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly auth: AuthService,

    private readonly conversations: ConversationsService,

    private readonly messages: MessagesService,

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
    const input = z
      .object({ accessToken: z.string().min(20).max(8192) })
      .strict()
      .parse(body)

    const userId = await this.auth.verifyAccessToken(input.accessToken)

    this.users.set(client, userId)

    const timer = this.authTimers.get(client)

    if (timer) clearTimeout(timer)

    return { type: "auth.ok", id: randomUUID(), ts: Date.now(), payload: {} }
  }

  @SubscribeMessage("message.send")
  async sendMessage(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() body: unknown,
  ) {
    const userId = await this.authenticatedUser(client)

    const input = messageSchema.parse(body)

    const message = await this.messages.create(input.conversationId, userId, {
      ...input,

      ciphertext: decodeBase64(input.ciphertext, 1, 65_536, "Ciphertext"),

      iv: decodeBase64(input.iv, 1, 32, "IV"),
    })

    await this.broadcastToConversation(input.conversationId, userId, {
      type: "message.created",

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

    const serialized = JSON.stringify(event)

    for (const client of this.server.clients) {
      if (client.readyState !== WebSocket.OPEN) continue

      const userId = this.users.get(client)

      if (userId && members.includes(userId)) client.send(serialized)
    }
  }
}
