import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common"
import { z } from "zod"

import { AuthGuard, type AuthRequest } from "../auth/auth.guard.js"
import { decodeBase64 } from "../messages/messages.repository.js"
import { SHARED_FOLDER_LIMITS } from "../../shared/sharedFolders.js"
import { SharedFoldersService } from "./shared-folders.service.js"

const createSchema = z.object({
  id: z.string().uuid(),
  ciphertext: z.string().min(24).max(Math.ceil(SHARED_FOLDER_LIMITS.maxPayloadBytes / 3) * 4),
  iv: z.string().length(16),
  formatVersion: z.literal(1),
  compressed: z.boolean(),
}).strict()

export class SharedFoldersController {
  constructor(private readonly folders: SharedFoldersService) {}

  async create(request: AuthRequest, conversationId: string, body: unknown) {
    z.string().uuid().parse(conversationId)
    const input = createSchema.parse(body)
    const ciphertext = decodeBase64(
      input.ciphertext,
      16,
      SHARED_FOLDER_LIMITS.maxPayloadBytes,
      "Encrypted folder manifest",
    )
    const iv = decodeBase64(input.iv, 12, 12, "IV")
    return this.folders.create(conversationId, request.userId, {
      id: input.id,
      ciphertext,
      iv,
      formatVersion: input.formatVersion,
      compressed: input.compressed,
      payloadBytes: ciphertext.length,
    })
  }

  list(request: AuthRequest, conversationId: string) {
    z.string().uuid().parse(conversationId)
    return this.folders.list(conversationId, request.userId)
  }

  get(request: AuthRequest, id: string) {
    z.string().uuid().parse(id)
    return this.folders.get(id, request.userId)
  }

  revoke(request: AuthRequest, id: string) {
    z.string().uuid().parse(id)
    return this.folders.revoke(id, request.userId)
  }
}

const controller = SharedFoldersController.prototype
Inject(SharedFoldersService)(SharedFoldersController, undefined, 0)
Req()(controller, "create", 0)
Param("conversationId")(controller, "create", 1)
Body()(controller, "create", 2)
Post("v1/conversations/:conversationId/shared-folders")(
  controller,
  "create",
  Object.getOwnPropertyDescriptor(controller, "create")!,
)
Req()(controller, "list", 0)
Param("conversationId")(controller, "list", 1)
Get("v1/conversations/:conversationId/shared-folders")(
  controller,
  "list",
  Object.getOwnPropertyDescriptor(controller, "list")!,
)
Req()(controller, "get", 0)
Param("id")(controller, "get", 1)
Get("v1/shared-folders/:id")(
  controller,
  "get",
  Object.getOwnPropertyDescriptor(controller, "get")!,
)
Req()(controller, "revoke", 0)
Param("id")(controller, "revoke", 1)
Delete("v1/shared-folders/:id")(
  controller,
  "revoke",
  Object.getOwnPropertyDescriptor(controller, "revoke")!,
)
UseGuards(AuthGuard)(SharedFoldersController)
Controller()(SharedFoldersController)
