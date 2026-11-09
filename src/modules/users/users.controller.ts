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
const privacySettingsSchema = z.object({
  presenceVisible: z.boolean(),
  showViewingActivity: z.boolean(),
  acceptAccessRequests: z.enum(["contacts", "off"]),
}).strict()

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

  publicKeys(id: string) {
    z.string().uuid().parse(id)
    return this.users.publicKeys(id)
  }

  privacySettings(request: AuthRequest) {
    return this.users.privacySettings(request.userId)
  }

  updatePrivacySettings(request: AuthRequest, body: unknown) {
    return this.users.updatePrivacySettings(
      request.userId,
      privacySettingsSchema.parse(body),
    )
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

export class MePrivacySettingsController {
  constructor(private readonly users: UsersService) {}

  get(request: AuthRequest) {
    return this.users.privacySettings(request.userId)
  }

  update(request: AuthRequest, body: unknown) {
    return this.users.updatePrivacySettings(
      request.userId,
      privacySettingsSchema.parse(body),
    )
  }
}

const usersController = UsersController.prototype
const mePrivacySettingsController = MePrivacySettingsController.prototype

Controller("v1/users")(UsersController)
Inject(UsersService)(UsersController, undefined, 0)
Controller("v1/me")(MePrivacySettingsController)
Inject(UsersService)(MePrivacySettingsController, undefined, 0)

Get("search")(usersController, "search", Object.getOwnPropertyDescriptor(usersController, "search")!)
UseGuards(AuthGuard)(usersController, "search", Object.getOwnPropertyDescriptor(usersController, "search")!)
Query("q")(usersController, "search", 0)
Req()(usersController, "search", 1)

Get(":id/public-key")(usersController, "publicKey", Object.getOwnPropertyDescriptor(usersController, "publicKey")!)
UseGuards(AuthGuard)(usersController, "publicKey", Object.getOwnPropertyDescriptor(usersController, "publicKey")!)
Param("id")(usersController, "publicKey", 0)
Query("version")(usersController, "publicKey", 1)

Get(":id/public-keys")(usersController, "publicKeys", Object.getOwnPropertyDescriptor(usersController, "publicKeys")!)
UseGuards(AuthGuard)(usersController, "publicKeys", Object.getOwnPropertyDescriptor(usersController, "publicKeys")!)
Param("id")(usersController, "publicKeys", 0)

Get("me/privacy-settings")(usersController, "privacySettings", Object.getOwnPropertyDescriptor(usersController, "privacySettings")!)
UseGuards(AuthGuard)(usersController, "privacySettings", Object.getOwnPropertyDescriptor(usersController, "privacySettings")!)
Req()(usersController, "privacySettings", 0)

Put("me/privacy-settings")(usersController, "updatePrivacySettings", Object.getOwnPropertyDescriptor(usersController, "updatePrivacySettings")!)
UseGuards(AuthGuard)(usersController, "updatePrivacySettings", Object.getOwnPropertyDescriptor(usersController, "updatePrivacySettings")!)
Req()(usersController, "updatePrivacySettings", 0)
Body()(usersController, "updatePrivacySettings", 1)

Get("privacy-settings")(mePrivacySettingsController, "get", Object.getOwnPropertyDescriptor(mePrivacySettingsController, "get")!)
UseGuards(AuthGuard)(mePrivacySettingsController, "get", Object.getOwnPropertyDescriptor(mePrivacySettingsController, "get")!)
Req()(mePrivacySettingsController, "get", 0)

Put("privacy-settings")(mePrivacySettingsController, "update", Object.getOwnPropertyDescriptor(mePrivacySettingsController, "update")!)
UseGuards(AuthGuard)(mePrivacySettingsController, "update", Object.getOwnPropertyDescriptor(mePrivacySettingsController, "update")!)
Req()(mePrivacySettingsController, "update", 0)
Body()(mePrivacySettingsController, "update", 1)

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
