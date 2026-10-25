import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common"

import type { Response } from "express"

import { z } from "zod"

import { clearCookieHeader } from "../auth/auth.service.js"

import { AuthGuard, type AuthRequest } from "../auth/auth.guard.js"

import { UsersService } from "./users.service.js"

const publicKeySchema = z
  .object({ publicKey: z.string().min(32).max(4096) })
  .strict()

@Controller("v1/users")
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get("search")

  @UseGuards(AuthGuard)
  async search(
    @Query("q") query: string | undefined,
    @Req() request: AuthRequest,
  ) {
    const input = z.string().min(3).max(64).parse(query)

    const users = await this.users.search(input)

    return { users: users.filter((user) => user.id !== request.userId) }
  }

  @Get(":id/public-key")

  @UseGuards(AuthGuard)
  publicKey(@Param("id") id: string) {
    z.string().uuid().parse(id)

    return this.users.publicKey(id)
  }

  @Get("me")

  @UseGuards(AuthGuard)
  me(@Req() request: AuthRequest) {
    return this.users.me(request.userId)
  }

  @Put("me/public-key")

  @UseGuards(AuthGuard)
  replacePublicKey(@Req() request: AuthRequest, @Body() body: unknown) {
    return this.users.replacePublicKey(
      request.userId,
      publicKeySchema.parse(body).publicKey,
    )
  }

  @Delete("me")

  @UseGuards(AuthGuard)
  async deleteAccount(
    @Req() request: AuthRequest,

    @Res({ passthrough: true }) response: Response,
  ) {
    await this.users.deleteAccount(request.userId)

    response.setHeader("Set-Cookie", clearCookieHeader())

    return { ok: true as const }
  }
}
