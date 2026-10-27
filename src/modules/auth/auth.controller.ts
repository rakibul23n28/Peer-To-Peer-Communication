import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
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

  async register(
    body: unknown,
    request: Request,
    response: Response,
  ) {
    const result = await this.auth.register(
      registerSchema.parse(body),

      requestMetadata(request),
    )

    response.setHeader("Set-Cookie", cookieHeader(result.refreshToken))

    return { accessToken: result.accessToken, user: result.user }
  }

  async login(
    body: unknown,
    request: Request,
    response: Response,
  ) {
    const result = await this.auth.login(
      loginSchema.parse(body),
      requestMetadata(request),
    )

    response.setHeader("Set-Cookie", cookieHeader(result.refreshToken))

    return { accessToken: result.accessToken, user: result.user }
  }

  async refresh(
    request: Request,
    client: string | undefined,
    response: Response,
  ) {
    requireOrbitClient({ headers: { "x-orbit-client": client } })

    const result = await this.auth.refresh(
      refreshCookie(request),
      requestMetadata(request),
    )

    response.setHeader("Set-Cookie", cookieHeader(result.refreshToken))

    return { accessToken: result.accessToken }
  }

  async logout(
    request: Request,
    client: string | undefined,
    response: Response,
  ) {
    requireOrbitClient({ headers: { "x-orbit-client": client } })

    await this.auth.logout(refreshCookie(request))

    response.setHeader("Set-Cookie", clearCookieHeader())

    return { ok: true as const }
  }
}

const authController = AuthController.prototype

Inject(AuthService)(AuthController, undefined, 0)
Controller("v1/auth")(AuthController)

const registerDescriptor = Object.getOwnPropertyDescriptor(authController, "register")!
Body()(authController, "register", 0)
Req()(authController, "register", 1)
Res({ passthrough: true })(authController, "register", 2)
HttpCode(HttpStatus.CREATED)(authController, "register", registerDescriptor)
Post("register")(authController, "register", registerDescriptor)

const loginDescriptor = Object.getOwnPropertyDescriptor(authController, "login")!
Body()(authController, "login", 0)
Req()(authController, "login", 1)
Res({ passthrough: true })(authController, "login", 2)
Post("login")(authController, "login", loginDescriptor)

const refreshDescriptor = Object.getOwnPropertyDescriptor(authController, "refresh")!
Req()(authController, "refresh", 0)
Headers("x-orbit-client")(authController, "refresh", 1)
Res({ passthrough: true })(authController, "refresh", 2)
HttpCode(HttpStatus.OK)(authController, "refresh", refreshDescriptor)
Post("refresh")(authController, "refresh", refreshDescriptor)

const logoutDescriptor = Object.getOwnPropertyDescriptor(authController, "logout")!
Req()(authController, "logout", 0)
Headers("x-orbit-client")(authController, "logout", 1)
Res({ passthrough: true })(authController, "logout", 2)
HttpCode(HttpStatus.OK)(authController, "logout", logoutDescriptor)
Post("logout")(authController, "logout", logoutDescriptor)

function requestMetadata(request: Request) {
  return {
    ip: request.ip ?? "",

    userAgent: request.get("user-agent") ?? "",
  }
}
