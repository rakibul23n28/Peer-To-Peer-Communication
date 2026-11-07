import { randomUUID } from "node:crypto"

import { Inject, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common"

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

const audioCallInviteSchema = z.object({
  callId: z.string().uuid(),
  conversationId: z.string().uuid(),
}).strict()

const audioCallIdSchema = z.object({
  callId: z.string().uuid(),
}).strict()

const audioCallResponseSchema = audioCallIdSchema.extend({
  accepted: z.boolean(),
}).strict()

const audioCallSignalSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("offer"),
    sdp: z.string().min(1).max(32_000),
  }).strict(),
  z.object({
    type: z.literal("answer"),
    sdp: z.string().min(1).max(32_000),
  }).strict(),
  z.object({
    type: z.literal("ice"),
    candidate: z.object({
      candidate: z.string().max(2048),
      sdpMid: z.string().max(256).nullable().optional(),
      sdpMLineIndex: z.number().int().min(0).max(1024).nullable().optional(),
      usernameFragment: z.string().max(256).nullable().optional(),
    }).strict(),
  }).strict(),
])

const fileSignalSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("accept"),
    fileId: z.string().uuid(),
  }).strict(),
  z.object({
    type: z.literal("offer"),
    fileId: z.string().uuid(),
    sdp: z.string().min(1).max(32_000),
  }).strict(),
  z.object({
    type: z.literal("answer"),
    fileId: z.string().uuid(),
    sdp: z.string().min(1).max(32_000),
  }).strict(),
  z.object({
    type: z.literal("ice"),
    fileId: z.string().uuid(),
    candidate: z.object({
      candidate: z.string().max(2048),
      sdpMid: z.string().max(256).nullable().optional(),
      sdpMLineIndex: z.number().int().min(0).max(1024).nullable().optional(),
      usernameFragment: z.string().max(256).nullable().optional(),
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("cancel"),
    fileId: z.string().uuid(),
  }).strict(),
])

interface AudioCallRecord {
  callId: string
  conversationId: string
  callerId: string
  calleeId: string
  callerSocket: WebSocket
  calleeSocket: WebSocket | null
  status: "ringing" | "active"
  expiresAt: number
}

export class OrbitGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  handleProtocols(protocols: string[] | undefined): string | false {
    if (!protocols || protocols.length === 0) return "orbit.v1"
    if (protocols.includes("orbit.v1")) return "orbit.v1"
    if (protocols.some((protocol) => protocol.startsWith("orbit.token."))) return "orbit.v1"
    return false
  }

  private readonly logger = new Logger(OrbitGateway.name)

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

  private readonly audioCalls = new Map<string, AudioCallRecord>()

  private readonly audioCallByUser = new Map<string, string>()

  private audioCallExpiryTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly auth: AuthService,

    private readonly conversations: ConversationsService,

    private readonly messages: MessagesService,

    private readonly files: FilesService,
  ) {}

  onModuleInit(): void {
    this.audioCallExpiryTimer = setInterval(() => this.expireAudioCalls(), 5_000)
  }

  onModuleDestroy(): void {
    if (this.audioCallExpiryTimer) clearInterval(this.audioCallExpiryTimer)
    this.audioCallExpiryTimer = null
  }

  handleConnection(client: WebSocket): void {
    this.authTimers.set(
      client,
      setTimeout(() => client.close(4401, "Authentication required"), 5_000),
    )
  }

  handleDisconnect(client: WebSocket): void {
    const timer = this.authTimers.get(client)

    if (timer) clearTimeout(timer)

    for (const call of this.audioCalls.values()) {
      if (call.callerSocket !== client && call.calleeSocket !== client) continue
      this.sendToUser(call.callerId === this.users.get(client) ? call.calleeId : call.callerId, {
        type: "call.ended",
        id: randomUUID(),
        payload: { callId: call.callId, reason: "connection-closed" },
      })
      this.removeAudioCall(call)
    }
  }

  async authenticate(
    client: WebSocket,

    body: unknown,
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

  async sendMessage(
    client: WebSocket,
    body: unknown,
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

  async editMessage(
    client: WebSocket,
    body: unknown,
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

  async addReceipt(
    client: WebSocket,
    body: unknown,
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

  async offerFile(
    client: WebSocket,
    body: unknown,
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

  async updateFile(
    client: WebSocket,
    body: unknown,
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

  async requestPeerFileShare(
    client: WebSocket,
    body: unknown,
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

  async respondToPeerFileShare(
    client: WebSocket,
    body: unknown,
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

  async relayFileSignal(client: WebSocket, body: unknown) {
    const userId = await this.authenticatedUser(client)
    const input = z.object({
      conversationId: z.string().uuid(),
      signal: fileSignalSchema,
    }).strict().parse(body)
    const senderId = await this.files.offerSender(input.conversationId, input.signal.fileId)
    if (!senderId) throw new HttpException("File offer not found", 404)

    const [memberA, memberB] = await this.conversations.memberIds(input.conversationId, userId)
    const recipientId = memberA === userId ? memberB : memberA
    const isSender = senderId === userId

    if (
      (input.signal.type === "offer" && !isSender) ||
      (input.signal.type === "accept" && isSender) ||
      (input.signal.type === "answer" && isSender)
    ) {
      throw new HttpException("Invalid file-transfer signal direction", 403)
    }

    this.sendToUser(recipientId, {
      type: "file.peer.signal",
      id: randomUUID(),
      ts: Date.now(),
      payload: { conversationId: input.conversationId, signal: input.signal },
    })
    return { type: "file.peer.signal.ack", id: input.signal.fileId, payload: { delivered: true } }
  }

  async inviteAudioCall(client: WebSocket, body: unknown) {
    const userId = await this.authenticatedUser(client)
    const input = audioCallInviteSchema.parse(body)
    this.expireAudioCalls()
    let members: string[]
    try {
      members = await this.conversations.memberIds(input.conversationId, userId)
    } catch (error) {
      this.logger.warn(`Audio call invite could not be authorized (${error instanceof Error ? error.name : "unknown"})`)
      return this.sendAudioCallError(client, input.callId, "Could not start the call. Check the conversation and try again.")
    }
    if (members.length !== 2) {
      return this.sendAudioCallError(client, input.callId, "This conversation cannot start an audio call.")
    }
    const [memberA, memberB] = members
    const calleeId = memberA === userId ? memberB : memberA
    if (this.audioCalls.has(input.callId)) {
      return this.sendAudioCallError(client, input.callId, "A call with this ID already exists.")
    }
    if (this.audioCallByUser.has(userId) || this.audioCallByUser.has(calleeId)) {
      return this.sendAudioCallError(client, input.callId, "One of you is already in a call.")
    }
    if (!this.hasConnectedUser(calleeId)) {
      return this.sendAudioCallError(client, input.callId, "This person is currently offline.")
    }

    const call: AudioCallRecord = {
      callId: input.callId,
      conversationId: input.conversationId,
      callerId: userId,
      calleeId,
      callerSocket: client,
      calleeSocket: null,
      status: "ringing",
      expiresAt: Date.now() + 45_000,
    }
    this.audioCalls.set(call.callId, call)
    this.audioCallByUser.set(userId, call.callId)
    this.audioCallByUser.set(calleeId, call.callId)
    this.sendToUser(calleeId, {
      type: "call.incoming",
      id: randomUUID(),
      ts: Date.now(),
      payload: {
        callId: call.callId,
        conversationId: call.conversationId,
        callerId: call.callerId,
        expiresAt: call.expiresAt,
      },
    })
    return { type: "call.invite.ack", id: call.callId, payload: { delivered: true } }
  }

  async respondToAudioCall(client: WebSocket, body: unknown) {
    const userId = await this.authenticatedUser(client)
    const input = audioCallResponseSchema.parse(body)
    this.expireAudioCalls()
    const call = this.audioCalls.get(input.callId)
    if (!call || call.status !== "ringing" || call.calleeId !== userId) {
      return this.sendAudioCallError(client, input.callId, "This call invitation has expired.")
    }
    if (input.accepted) {
      call.status = "active"
      call.calleeSocket = client
      call.expiresAt = Date.now() + 4 * 60 * 60 * 1000
      this.sendToSocket(call.callerSocket, {
        type: "call.accepted",
        id: randomUUID(),
        ts: Date.now(),
        payload: { callId: call.callId, conversationId: call.conversationId },
      })
    } else {
      this.sendToSocket(call.callerSocket, {
        type: "call.declined",
        id: randomUUID(),
        ts: Date.now(),
        payload: { callId: call.callId },
      })
      this.removeAudioCall(call)
    }
    return { type: "call.response.ack", id: call.callId, payload: { accepted: input.accepted } }
  }

  async cancelAudioCall(client: WebSocket, body: unknown) {
    const userId = await this.authenticatedUser(client)
    const input = audioCallIdSchema.parse(body)
    this.expireAudioCalls()
    const call = this.audioCalls.get(input.callId)
    if (!call || call.callerId !== userId || call.status !== "ringing") {
      return this.sendAudioCallError(client, input.callId, "This call can no longer be cancelled.")
    }
    this.sendToUser(call.calleeId, {
      type: "call.cancelled",
      id: randomUUID(),
      ts: Date.now(),
      payload: { callId: call.callId },
    })
    this.removeAudioCall(call)
    return { type: "call.cancel.ack", id: call.callId, payload: { ok: true } }
  }

  async hangupAudioCall(client: WebSocket, body: unknown) {
    const userId = await this.authenticatedUser(client)
    const input = audioCallIdSchema.parse(body)
    this.expireAudioCalls()
    const call = this.audioCalls.get(input.callId)
    if (!call || call.status !== "active" || (call.callerId !== userId && call.calleeId !== userId)) {
      return this.sendAudioCallError(client, input.callId, "This call is no longer active.")
    }
    const otherUserId = call.callerId === userId ? call.calleeId : call.callerId
    this.sendToUser(otherUserId, {
      type: "call.ended",
      id: randomUUID(),
      ts: Date.now(),
      payload: { callId: call.callId, reason: "hangup" },
    })
    this.removeAudioCall(call)
    return { type: "call.hangup.ack", id: call.callId, payload: { ok: true } }
  }

  async relayAudioCallSignal(client: WebSocket, body: unknown) {
    const userId = await this.authenticatedUser(client)
    const input = z.object({
      callId: z.string().uuid(),
      signal: audioCallSignalSchema,
    }).strict().parse(body)
    this.expireAudioCalls()
    const call = this.audioCalls.get(input.callId)
    if (!call || call.status !== "active") {
      return this.sendAudioCallError(client, input.callId, "This call is no longer active.")
    }
    const isCaller = call.callerId === userId && call.callerSocket === client
    const isCallee = call.calleeId === userId && call.calleeSocket === client
    if (!isCaller && !isCallee) {
      return this.sendAudioCallError(client, input.callId, "This device is not part of the call.")
    }
    if (
      (input.signal.type === "offer" && !isCaller) ||
      (input.signal.type === "answer" && !isCallee)
    ) {
      return this.sendAudioCallError(client, input.callId, "Invalid call signaling direction.")
    }
    const recipient = isCaller ? call.calleeSocket : call.callerSocket
    if (!recipient || recipient.readyState !== WebSocket.OPEN) {
      this.removeAudioCall(call)
      return this.sendAudioCallError(client, input.callId, "The other person's connection was lost.")
    }
    this.sendToSocket(recipient, {
      type: "call.signal",
      id: randomUUID(),
      ts: Date.now(),
      payload: { callId: call.callId, signal: input.signal },
    })
    return { type: "call.signal.ack", id: call.callId, payload: { delivered: true } }
  }

  private sendAudioCallError(client: WebSocket, callId: string, message: string) {
    this.sendToSocket(client, {
      type: "call.error",
      id: randomUUID(),
      payload: { callId, message },
    })
    return { type: "call.error.ack", id: callId, payload: { message } }
  }

  private expireAudioCalls(): void {
    const now = Date.now()
    for (const call of this.audioCalls.values()) {
      if (call.expiresAt > now) continue
      const event = call.status === "ringing" ? "call.timeout" : "call.ended"
      const payload = call.status === "ringing"
        ? { callId: call.callId }
        : { callId: call.callId, reason: "maximum-duration" }
      this.sendToUser(call.callerId, { type: event, id: randomUUID(), payload })
      this.sendToUser(call.calleeId, { type: event, id: randomUUID(), payload })
      this.removeAudioCall(call)
    }
  }

  private removeAudioCall(call: AudioCallRecord): void {
    this.audioCalls.delete(call.callId)
    if (this.audioCallByUser.get(call.callerId) === call.callId) {
      this.audioCallByUser.delete(call.callerId)
    }
    if (this.audioCallByUser.get(call.calleeId) === call.callId) {
      this.audioCallByUser.delete(call.calleeId)
    }
  }

  private hasConnectedUser(userId: string): boolean {
    for (const client of this.server.clients) {
      if (client.readyState === WebSocket.OPEN && this.users.get(client) === userId) return true
    }
    return false
  }

  private sendToSocket(client: WebSocket, event: Record<string, unknown>): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ event: event.type, data: event }))
    }
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

type LegacyClassDecorator = (target: Function) => void
type LegacyMethodDecorator = (
  target: object,
  propertyKey: string | symbol,
  descriptor: PropertyDescriptor,
) => void
type LegacyParameterDecorator = (
  target: object,
  propertyKey: string | symbol | undefined,
  parameterIndex: number,
) => void
type LegacyPropertyDecorator = (target: object, propertyKey: string | symbol) => void

const gatewayTarget = OrbitGateway as unknown as Function
const gatewayPrototype = OrbitGateway.prototype

;(WebSocketGateway({ path: "/v1/ws", maxPayload: 128 * 1024 }) as unknown as LegacyClassDecorator)(gatewayTarget)
;(WebSocketServer() as unknown as LegacyPropertyDecorator)(gatewayPrototype, "server")

const constructorTarget = OrbitGateway as unknown as object
;(Inject(AuthService) as unknown as LegacyParameterDecorator)(constructorTarget, undefined, 0)
;(Inject(ConversationsService) as unknown as LegacyParameterDecorator)(constructorTarget, undefined, 1)
;(Inject(MessagesService) as unknown as LegacyParameterDecorator)(constructorTarget, undefined, 2)
;(Inject(FilesService) as unknown as LegacyParameterDecorator)(constructorTarget, undefined, 3)

const registerHandler = (event: string, method: keyof OrbitGateway): void => {
  const descriptor = Object.getOwnPropertyDescriptor(gatewayPrototype, method)
  if (!descriptor) return

  ;(SubscribeMessage(event) as unknown as LegacyMethodDecorator)(gatewayPrototype, method, descriptor)
  ;(ConnectedSocket() as unknown as LegacyParameterDecorator)(gatewayPrototype, method, 0)
  ;(MessageBody() as unknown as LegacyParameterDecorator)(gatewayPrototype, method, 1)
}

registerHandler("auth", "authenticate")
registerHandler("message.send", "sendMessage")
registerHandler("message.edit", "editMessage")
registerHandler("receipt.add", "addReceipt")
registerHandler("file.offer", "offerFile")
registerHandler("file.status", "updateFile")
registerHandler("file.peer.request", "requestPeerFileShare")
registerHandler("file.peer.response", "respondToPeerFileShare")
registerHandler("file.peer.signal", "relayFileSignal")
registerHandler("call.invite", "inviteAudioCall")
registerHandler("call.respond", "respondToAudioCall")
registerHandler("call.cancel", "cancelAudioCall")
registerHandler("call.hangup", "hangupAudioCall")
registerHandler("call.signal", "relayAudioCallSignal")
