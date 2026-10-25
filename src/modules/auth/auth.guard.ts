import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common"

import type { Request } from "express"

import { unauthorized } from "../shared/http-error.filter.js"

import { AuthService } from "./auth.service.js"

export interface AuthRequest extends Request {
  userId: string
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>()

    const authorization = request.headers.authorization

    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]

    if (!token) throw unauthorized()

    request.userId = await this.auth.verifyAccessToken(token)

    return true
  }
}
