import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common"

import { MessageKind, ReceiptStatus, WhisperMode } from "@prisma/client"

import { z } from "zod"

import { AuthGuard, type AuthRequest } from "../auth/auth.guard.js"

import { badRequest } from "../shared/http-error.filter.js"

import { decodeBase64 } from "./messages.repository.js"

import { MessagesService } from "./messages.service.js"

const createMessageSchema = z
  .object({
    clientMsgId: z.string().uuid(),

    ciphertext: z.string().min(1).max(90_000),

    iv: z.string().min(1).max(128),

    keyVersion: z.number().int().positive(),

    kind: z.nativeEnum(MessageKind),

    replyToId: z.string().uuid().optional(),

    whisperMode: z.nativeEnum(WhisperMode).optional(),

    whisperTtlS: z.number().int().min(1).max(604800).optional(),
  })
  .strict()
  .refine(
    (input) =>
      (input.whisperMode === undefined) === (input.whisperTtlS === undefined),
    {
      message: "Whisper mode and TTL must be specified together",
    },
  )

const receiptSchema = z.object({ status: z.nativeEnum(ReceiptStatus) }).strict()

const editMessageSchema = z
  .object({
    ciphertext: z.string().min(1).max(90_000),
    iv: z.string().min(1).max(128),
    keyVersion: z.number().int().positive(),
  })
  .strict()

const reactionSchema = z
  .object({
    reactionEnc: z.string().min(1).max(6000),

    iv: z.string().min(1).max(128),
  })
  .strict()

@Controller("v1/conversations/:conversationId/messages")
@UseGuards(AuthGuard)
export class MessagesController {
  constructor(
    @Inject(MessagesService) private readonly messages: MessagesService,
  ) {}

  @Get()
  list(
    @Req() request: AuthRequest,

    @Param("conversationId") conversationId: string,

    @Query("cursor") cursor?: string,
  ) {
    z.string().uuid().parse(conversationId)

    if (cursor !== undefined) {
      if (!/^\d+$/.test(cursor))
        throw badRequest("INVALID_CURSOR", "Message cursor is invalid")
    }

    return this.messages.list(conversationId, request.userId, cursor)
  }

  @Post()
  async create(
    @Req() request: AuthRequest,

    @Param("conversationId") conversationId: string,

    @Body() body: unknown,
  ) {
    z.string().uuid().parse(conversationId)

    const input = createMessageSchema.parse(body)

    return this.messages.create(conversationId, request.userId, {
      ...input,

      ciphertext: decodeBase64(input.ciphertext, 1, 65_536, "Ciphertext"),

      iv: decodeBase64(input.iv, 1, 32, "IV"),
    })
  }

  @Post(":messageId/receipts")
  addReceipt(
    @Req() request: AuthRequest,

    @Param("conversationId") conversationId: string,

    @Param("messageId") messageId: string,

    @Body() body: unknown,
  ) {
    z.string().uuid().parse(conversationId)

    z.string().uuid().parse(messageId)

    return this.messages.addReceipt(
      conversationId,

      messageId,

      request.userId,

      receiptSchema.parse(body).status,
    )
  }

  @Put(":messageId")
  edit(
    @Req() request: AuthRequest,
    @Param("conversationId") conversationId: string,
    @Param("messageId") messageId: string,
    @Body() body: unknown,
  ) {
    z.string().uuid().parse(conversationId)
    z.string().uuid().parse(messageId)
    const input = editMessageSchema.parse(body)

    return this.messages.edit(conversationId, messageId, request.userId, {
      ciphertext: decodeBase64(input.ciphertext, 1, 65_536, "Ciphertext"),
      iv: decodeBase64(input.iv, 1, 32, "IV"),
      keyVersion: input.keyVersion,
    })
  }

  @Put(":messageId/reaction")
  setReaction(
    @Req() request: AuthRequest,

    @Param("conversationId") conversationId: string,

    @Param("messageId") messageId: string,

    @Body() body: unknown,
  ) {
    z.string().uuid().parse(conversationId)

    z.string().uuid().parse(messageId)

    const input = reactionSchema.parse(body)

    return this.messages.setReaction(
      conversationId,

      messageId,

      request.userId,

      decodeBase64(input.reactionEnc, 1, 4096, "Encrypted reaction"),

      decodeBase64(input.iv, 1, 32, "IV"),
    )
  }

  @Delete(":messageId/reaction")
  removeReaction(
    @Req() request: AuthRequest,

    @Param("conversationId") conversationId: string,

    @Param("messageId") messageId: string,
  ) {
    z.string().uuid().parse(conversationId)

    z.string().uuid().parse(messageId)

    return this.messages.removeReaction(
      conversationId,
      messageId,
      request.userId,
    )
  }

  @Delete(":messageId")
  tombstone(
    @Req() request: AuthRequest,

    @Param("conversationId") conversationId: string,

    @Param("messageId") messageId: string,
  ) {
    z.string().uuid().parse(conversationId)

    z.string().uuid().parse(messageId)

    return this.messages.tombstone(conversationId, messageId, request.userId)
  }
}
