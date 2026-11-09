import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common"
import { z } from "zod"

import { AuthGuard, type AuthRequest } from "../auth/auth.guard.js"
import { decodeBase64 } from "../messages/messages.repository.js"
import { AccessRequestsService } from "./access-requests.service.js"

const requestSchema = z.object({
  requestId: z.string().uuid().optional(),
  shareId: z.string().uuid().optional(),
  kind: z.enum(["availability", "download_permission", "reshare"]),
  noteCiphertext: z.string().max(1368).optional(),
  noteIv: z.string().length(16).optional(),
}).strict().refine(
  (value) => Boolean(value.noteCiphertext) === Boolean(value.noteIv),
  { message: "Encrypted note and IV must be provided together." },
)

export class AccessRequestsController {
  constructor(private readonly requests: AccessRequestsService) {}

  create(request: AuthRequest, conversationId: string, body: unknown) {
    const id = z.string().uuid().parse(conversationId)
    const input = requestSchema.parse(body)
    return this.requests.create({
      requestId: input.requestId,
      conversationId: id,
      requesterId: request.userId,
      kind: input.kind,
      shareId: input.shareId,
      noteCiphertext: input.noteCiphertext
        ? decodeBase64(input.noteCiphertext, 16, 1024, "Encrypted note")
        : undefined,
      noteIv: input.noteIv ? decodeBase64(input.noteIv, 12, 12, "Note IV") : undefined,
    })
  }

  list(request: AuthRequest, role?: string, status?: string) {
    const parsedRole = z.enum(["incoming", "outgoing"]).parse(role)
    const parsedStatus = status === undefined
      ? undefined
      : z.enum(["pending", "fulfilled", "declined", "canceled", "expired"]).parse(status)
    return this.requests.list(request.userId, parsedRole, parsedStatus)
  }

  cancel(request: AuthRequest, id: string) {
    return this.requests.cancel(z.string().uuid().parse(id), request.userId)
  }

  decline(request: AuthRequest, id: string) {
    return this.requests.decline(z.string().uuid().parse(id), request.userId)
  }
}

const prototype = AccessRequestsController.prototype
Controller()(AccessRequestsController)
Inject(AccessRequestsService)(AccessRequestsController, undefined, 0)
UseGuards(AuthGuard)(AccessRequestsController)

Post("v1/conversations/:conversationId/access-requests")(
  prototype,
  "create",
  Object.getOwnPropertyDescriptor(prototype, "create")!,
)
Req()(prototype, "create", 0)
Param("conversationId")(prototype, "create", 1)
Body()(prototype, "create", 2)

Get("v1/access-requests")(
  prototype,
  "list",
  Object.getOwnPropertyDescriptor(prototype, "list")!,
)
Req()(prototype, "list", 0)
Query("role")(prototype, "list", 1)
Query("status")(prototype, "list", 2)

Post("v1/access-requests/:id/cancel")(
  prototype,
  "cancel",
  Object.getOwnPropertyDescriptor(prototype, "cancel")!,
)
Req()(prototype, "cancel", 0)
Param("id")(prototype, "cancel", 1)

Post("v1/access-requests/:id/decline")(
  prototype,
  "decline",
  Object.getOwnPropertyDescriptor(prototype, "decline")!,
)
Req()(prototype, "decline", 0)
Param("id")(prototype, "decline", 1)
