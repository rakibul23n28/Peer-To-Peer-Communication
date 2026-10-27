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

export class UsersController {
  constructor(private readonly users: UsersService) {}

  async search(
    query: string | undefined,
    request: AuthRequest,
  ) {
    const input = z.string().min(3).max(64).parse(query)

    const users = await this.users.search(input)

    return { users: users.filter((user) => user.id !== request.userId) }
  }

  publicKey(id: string, version?: string) {
    z.string().uuid().parse(id)
    const keyVersion = version === undefined
      ? undefined
      : z.coerce.number().int().positive().parse(version)

    return this.users.publicKey(id, keyVersion)
  }

  me(request: AuthRequest) {
    return this.users.me(request.userId)
  }

  replacePublicKey(request: AuthRequest, body: unknown) {
    return this.users.replacePublicKey(
      request.userId,
      publicKeySchema.parse(body).publicKey,
    )
  }

  async deleteAccount(
    request: AuthRequest,
    response: Response,
  ) {
    await this.users.deleteAccount(request.userId)

    response.setHeader("Set-Cookie", clearCookieHeader())

    return { ok: true as const }
  }
}

const usersController = UsersController.prototype

Controller("v1/users")(UsersController)
Inject(UsersService)(UsersController, undefined, 0)

Get("search")(usersController, "search", Object.getOwnPropertyDescriptor(usersController, "search")!)
UseGuards(AuthGuard)(usersController, "search", Object.getOwnPropertyDescriptor(usersController, "search")!)
Query("q")(usersController, "search", 0)
Req()(usersController, "search", 1)

Get(":id/public-key")(usersController, "publicKey", Object.getOwnPropertyDescriptor(usersController, "publicKey")!)
UseGuards(AuthGuard)(usersController, "publicKey", Object.getOwnPropertyDescriptor(usersController, "publicKey")!)
Param("id")(usersController, "publicKey", 0)
Query("version")(usersController, "publicKey", 1)

Get("me")(usersController, "me", Object.getOwnPropertyDescriptor(usersController, "me")!)
UseGuards(AuthGuard)(usersController, "me", Object.getOwnPropertyDescriptor(usersController, "me")!)
Req()(usersController, "me", 0)

Put("me/public-key")(usersController, "replacePublicKey", Object.getOwnPropertyDescriptor(usersController, "replacePublicKey")!)
UseGuards(AuthGuard)(usersController, "replacePublicKey", Object.getOwnPropertyDescriptor(usersController, "replacePublicKey")!)
Req()(usersController, "replacePublicKey", 0)
Body()(usersController, "replacePublicKey", 1)

Delete("me")(usersController, "deleteAccount", Object.getOwnPropertyDescriptor(usersController, "deleteAccount")!)
UseGuards(AuthGuard)(usersController, "deleteAccount", Object.getOwnPropertyDescriptor(usersController, "deleteAccount")!)
Req()(usersController, "deleteAccount", 0)
Res({ passthrough: true })(usersController, "deleteAccount", 1)
