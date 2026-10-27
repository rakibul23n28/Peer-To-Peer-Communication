import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common"

import { z } from "zod"

import { AuthGuard, type AuthRequest } from "../auth/auth.guard.js"

import { ConversationsService } from "./conversations.service.js"

const createConversationSchema = z
  .object({ peerId: z.string().uuid() })
  .strict()

export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
  ) {}

  list(request: AuthRequest) {
    return this.conversations.list(request.userId)
  }

  create(request: AuthRequest, body: unknown) {
    return this.conversations.create(
      request.userId,

      createConversationSchema.parse(body).peerId,
    )
  }
}

// Apply Nest's legacy decorators explicitly so this file also compiles when
// TypeScript's legacy decorator syntax is disabled.
const conversationsPrototype = ConversationsController.prototype
const listDescriptor = Object.getOwnPropertyDescriptor(
  conversationsPrototype,
  "list",
)!
const createDescriptor = Object.getOwnPropertyDescriptor(
  conversationsPrototype,
  "create",
)!

Controller("v1/conversations")(ConversationsController)
UseGuards(AuthGuard)(ConversationsController)
Inject(ConversationsService)(ConversationsController, undefined, 0)
Get()(conversationsPrototype, "list", listDescriptor)
Req()(conversationsPrototype, "list", 0)
Post()(conversationsPrototype, "create", createDescriptor)
Req()(conversationsPrototype, "create", 0)
Body()(conversationsPrototype, "create", 1)
