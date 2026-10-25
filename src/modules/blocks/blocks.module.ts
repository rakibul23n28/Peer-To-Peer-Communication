import { Module } from "@nestjs/common"

import { BlocksController } from "./blocks.controller.js"

import { BlocksRepository } from "./blocks.repository.js"

import { BlocksService } from "./blocks.service.js"

@Module({
  controllers: [BlocksController],

  providers: [BlocksRepository, BlocksService],
})
export class BlocksModule {}
