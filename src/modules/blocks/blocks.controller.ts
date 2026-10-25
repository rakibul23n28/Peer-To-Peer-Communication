import {
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common"

import { z } from "zod"

import { AuthGuard, type AuthRequest } from "../auth/auth.guard.js"

import { BlocksService } from "./blocks.service.js"

@Controller("v1/users/me/blocks")
@UseGuards(AuthGuard)
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  @Get()
  async list(@Req() request: AuthRequest) {
    return { blocks: await this.blocks.list(request.userId) }
  }

  @Put(":userId")
  async add(@Req() request: AuthRequest, @Param("userId") userId: string) {
    await this.blocks.add(request.userId, z.string().uuid().parse(userId))

    return { ok: true as const }
  }

  @Delete(":userId")
  async remove(@Req() request: AuthRequest, @Param("userId") userId: string) {
    await this.blocks.remove(request.userId, z.string().uuid().parse(userId))

    return { ok: true as const }
  }
}
