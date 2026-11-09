import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module.js"
import { PresenceModule } from "../presence/presence.module.js"

import { BlocksController } from "./blocks.controller.js"

import { BlocksRepository } from "./blocks.repository.js"

import { BlocksService } from "./blocks.service.js"

@Module({
  imports: [AuthModule, PresenceModule],

  controllers: [BlocksController],

  providers: [BlocksRepository, BlocksService],
})
export class BlocksModule {}
