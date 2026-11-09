import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module.js"
import { PresenceModule } from "../presence/presence.module.js"

import { MePrivacySettingsController, UsersController } from "./users.controller.js"

import { UsersRepository } from "./users.repository.js"

import { UsersService } from "./users.service.js"

@Module({
  imports: [AuthModule, PresenceModule],

  controllers: [UsersController, MePrivacySettingsController],

  providers: [UsersRepository, UsersService],

  exports: [UsersService],
})
export class UsersModule {}
