import { Controller, Get, Inject, Req, UseGuards } from "@nestjs/common"
import { AuthGuard, type AuthRequest } from "../auth/auth.guard.js"
import { PresenceService } from "./presence.service.js"

export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  snapshot(request: AuthRequest) {
    return this.presence.getSnapshot(request.userId)
  }
}

const prototype = PresenceController.prototype
Controller("v1/presence")(PresenceController)
Inject(PresenceService)(PresenceController, undefined, 0)
Get()(prototype, "snapshot", Object.getOwnPropertyDescriptor(prototype, "snapshot")!)
UseGuards(AuthGuard)(prototype, "snapshot", Object.getOwnPropertyDescriptor(prototype, "snapshot")!)
Req()(prototype, "snapshot", 0)
