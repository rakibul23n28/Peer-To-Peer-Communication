import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module.js"

import { TurnController } from "./turn.controller.js"

import { TurnService } from "./turn.service.js"

@Module({
  imports: [AuthModule],
  controllers: [TurnController],
  providers: [TurnService],
})
export class TurnModule {}
