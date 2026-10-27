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

    senderKeyVersion: z.number().int().positive().optional(),

    recipientKeyVersion: z.number().int().positive().optional(),

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

export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
  ) {}

  list(
    request: AuthRequest,

    conversationId: string,

    cursor?: string,
  ) {
    z.string().uuid().parse(conversationId)

    if (cursor !== undefined) {
      if (!/^\d+$/.test(cursor))
        throw badRequest("INVALID_CURSOR", "Message cursor is invalid")
    }

    return this.messages.list(conversationId, request.userId, cursor)
  }

  async create(
    request: AuthRequest,

    conversationId: string,

    body: unknown,
  ) {
    z.string().uuid().parse(conversationId)

    const input = createMessageSchema.parse(body)

    return this.messages.create(conversationId, request.userId, {
      ...input,

      ciphertext: decodeBase64(input.ciphertext, 1, 65_536, "Ciphertext"),

      iv: decodeBase64(input.iv, 1, 32, "IV"),

      senderKeyVersion: input.senderKeyVersion ?? input.keyVersion,

      recipientKeyVersion: input.recipientKeyVersion ?? input.keyVersion,
    })
  }

  addReceipt(
    request: AuthRequest,

    conversationId: string,

    messageId: string,

    body: unknown,
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

  edit(
    request: AuthRequest,
    conversationId: string,
    messageId: string,
    body: unknown,
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

  setReaction(
    request: AuthRequest,

    conversationId: string,

    messageId: string,

    body: unknown,
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

  removeReaction(
    request: AuthRequest,

    conversationId: string,

    messageId: string,
  ) {
    z.string().uuid().parse(conversationId)

    z.string().uuid().parse(messageId)

    return this.messages.removeReaction(
      conversationId,
      messageId,
      request.userId,
    )
  }

  tombstone(
    request: AuthRequest,

    conversationId: string,

    messageId: string,
  ) {
    z.string().uuid().parse(conversationId)

    z.string().uuid().parse(messageId)

    return this.messages.tombstone(conversationId, messageId, request.userId)
  }
}

const controllerPrototype = MessagesController.prototype

const applyMethodDecorator = (decorator: MethodDecorator, method: string) => {
  const descriptor = Object.getOwnPropertyDescriptor(controllerPrototype, method)

  if (descriptor) decorator(controllerPrototype, method, descriptor)
}

const applyParameterDecorator = (
  decorator: ParameterDecorator,
  method: string,
  index: number,
) => decorator(controllerPrototype, method, index)

Inject(MessagesService)(MessagesController, undefined, 0)
UseGuards(AuthGuard)(MessagesController)
Controller("v1/conversations/:conversationId/messages")(MessagesController)

applyMethodDecorator(Get(), "list")
applyParameterDecorator(Req(), "list", 0)
applyParameterDecorator(Param("conversationId"), "list", 1)
applyParameterDecorator(Query("cursor"), "list", 2)

applyMethodDecorator(Post(), "create")
applyParameterDecorator(Req(), "create", 0)
applyParameterDecorator(Param("conversationId"), "create", 1)
applyParameterDecorator(Body(), "create", 2)

applyMethodDecorator(Post(":messageId/receipts"), "addReceipt")
applyParameterDecorator(Req(), "addReceipt", 0)
applyParameterDecorator(Param("conversationId"), "addReceipt", 1)
applyParameterDecorator(Param("messageId"), "addReceipt", 2)
applyParameterDecorator(Body(), "addReceipt", 3)

applyMethodDecorator(Put(":messageId"), "edit")
applyParameterDecorator(Req(), "edit", 0)
applyParameterDecorator(Param("conversationId"), "edit", 1)
applyParameterDecorator(Param("messageId"), "edit", 2)
applyParameterDecorator(Body(), "edit", 3)

applyMethodDecorator(Put(":messageId/reaction"), "setReaction")
applyParameterDecorator(Req(), "setReaction", 0)
applyParameterDecorator(Param("conversationId"), "setReaction", 1)
applyParameterDecorator(Param("messageId"), "setReaction", 2)
applyParameterDecorator(Body(), "setReaction", 3)

applyMethodDecorator(Delete(":messageId/reaction"), "removeReaction")
applyParameterDecorator(Req(), "removeReaction", 0)
applyParameterDecorator(Param("conversationId"), "removeReaction", 1)
applyParameterDecorator(Param("messageId"), "removeReaction", 2)

applyMethodDecorator(Delete(":messageId"), "tombstone")
applyParameterDecorator(Req(), "tombstone", 0)
applyParameterDecorator(Param("conversationId"), "tombstone", 1)
applyParameterDecorator(Param("messageId"), "tombstone", 2)
