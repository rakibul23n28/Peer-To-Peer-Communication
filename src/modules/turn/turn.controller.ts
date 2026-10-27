import {
  Controller,
  Get,
  Inject,
  Req,
  UseGuards,
} from "@nestjs/common"

import { AuthGuard, type AuthRequest } from "../auth/auth.guard.js"

import { TurnService } from "./turn.service.js"

export class TurnController {
  constructor(private readonly turn: TurnService) {}

  credentials(request: AuthRequest) {
    return this.turn.getCredentials(request.userId)
  }
}

const prototype = TurnController.prototype
Controller("v1/turn")(TurnController)
UseGuards(AuthGuard)(TurnController)
Inject(TurnService)(TurnController, undefined, 0)
Get("credentials")(prototype, "credentials", Object.getOwnPropertyDescriptor(prototype, "credentials")!)
Req()(prototype, "credentials", 0)
