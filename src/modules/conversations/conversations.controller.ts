import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common"

import { z } from "zod"

import { AuthGuard, type AuthRequest } from "../auth/auth.guard.js"

import { ConversationsService } from "./conversations.service.js"

const createConversationSchema = z
  .object({ peerId: z.string().uuid() })
  .strict()

@Controller("v1/conversations")
@UseGuards(AuthGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(@Req() request: AuthRequest) {
    return this.conversations.list(request.userId)
  }

  @Post()
  create(@Req() request: AuthRequest, @Body() body: unknown) {
    return this.conversations.create(
      request.userId,

      createConversationSchema.parse(body).peerId,
    )
  }
}
