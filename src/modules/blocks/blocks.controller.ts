import {
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common"

import { z } from "zod"

import { AuthGuard, type AuthRequest } from "../auth/auth.guard.js"

import { BlocksService } from "./blocks.service.js"

export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  async list(request: AuthRequest) {
    return { blocks: await this.blocks.list(request.userId) }
  }

  async add(request: AuthRequest, userId: string) {
    await this.blocks.add(request.userId, z.string().uuid().parse(userId))

    return { ok: true as const }
  }

  async remove(request: AuthRequest, userId: string) {
    await this.blocks.remove(request.userId, z.string().uuid().parse(userId))

    return { ok: true as const }
  }
}

const prototype = BlocksController.prototype
Controller("v1/users/me/blocks")(BlocksController)
UseGuards(AuthGuard)(BlocksController)
Inject(BlocksService)(BlocksController, undefined, 0)
Get()(prototype, "list", Object.getOwnPropertyDescriptor(prototype, "list")!)
Req()(prototype, "list", 0)
Put(":userId")(prototype, "add", Object.getOwnPropertyDescriptor(prototype, "add")!)
Req()(prototype, "add", 0)
Param("userId")(prototype, "add", 1)
Delete(":userId")(prototype, "remove", Object.getOwnPropertyDescriptor(prototype, "remove")!)
Req()(prototype, "remove", 0)
Param("userId")(prototype, "remove", 1)
