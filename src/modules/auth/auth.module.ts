import { Module } from "@nestjs/common"

import { AuthController } from "./auth.controller.js"

import { AuthGuard } from "./auth.guard.js"

import { AuthRepository } from "./auth.repository.js"

import { AuthService } from "./auth.service.js"

@Module({
  controllers: [AuthController],

  providers: [AuthRepository, AuthService, AuthGuard],

  exports: [AuthService, AuthGuard, AuthRepository],
})
export class AuthModule {}
