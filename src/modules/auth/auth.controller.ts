import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from "@nestjs/common"

import type { Request, Response } from "express"

import { z } from "zod"

import {
  AuthService,
  clearCookieHeader,
  cookieHeader,
  refreshCookie,
  requireOrbitClient,
} from "./auth.service.js"

const registerSchema = z
  .object({
    username: z
      .string()
      .min(3)
      .max(32)
      .regex(/^[a-z0-9_.]+$/),

    displayName: z.string().min(1).max(80).optional(),

    password: z.string().min(10).max(128),

    publicKey: z.string().min(32).max(4096),
  })
  .strict()

const loginSchema = z
  .object({
    username: z
      .string()
      .min(3)
      .max(32)
      .regex(/^[a-z0-9_.]+$/i),

    password: z.string().min(10).max(128),
  })
  .strict()

@Controller("v1/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")

  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() body: unknown,

    @Req() request: Request,

    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.register(
      registerSchema.parse(body),

      requestMetadata(request),
    )

    response.setHeader("Set-Cookie", cookieHeader(result.refreshToken))

    return { accessToken: result.accessToken, user: result.user }
  }

  @Post("login")
  async login(
    @Body() body: unknown,

    @Req() request: Request,

    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(
      loginSchema.parse(body),
      requestMetadata(request),
    )

    response.setHeader("Set-Cookie", cookieHeader(result.refreshToken))

    return { accessToken: result.accessToken, user: result.user }
  }

  @Post("refresh")

  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: Request,

    @Headers("x-orbit-client") client: string | undefined,

    @Res({ passthrough: true }) response: Response,
  ) {
    requireOrbitClient({ headers: { "x-orbit-client": client } })

    const result = await this.auth.refresh(
      refreshCookie(request),
      requestMetadata(request),
    )

    response.setHeader("Set-Cookie", cookieHeader(result.refreshToken))

    return { accessToken: result.accessToken }
  }

  @Post("logout")

  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() request: Request,

    @Headers("x-orbit-client") client: string | undefined,

    @Res({ passthrough: true }) response: Response,
  ) {
    requireOrbitClient({ headers: { "x-orbit-client": client } })

    await this.auth.logout(refreshCookie(request))

    response.setHeader("Set-Cookie", clearCookieHeader())

    return { ok: true as const }
  }
}

function requestMetadata(request: Request) {
  return {
    ip: request.ip ?? "",

    userAgent: request.get("user-agent") ?? "",
  }
}
