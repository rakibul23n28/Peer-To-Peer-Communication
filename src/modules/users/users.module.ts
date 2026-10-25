import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module.js"

import { UsersController } from "./users.controller.js"

import { UsersRepository } from "./users.repository.js"

import { UsersService } from "./users.service.js"

@Module({
  imports: [AuthModule],

  controllers: [UsersController],

  providers: [UsersRepository, UsersService],

  exports: [UsersService],
})
export class UsersModule {}
