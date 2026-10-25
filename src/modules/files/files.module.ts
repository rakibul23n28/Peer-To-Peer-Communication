import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module.js"

import { FilesController } from "./files.controller.js"

import { FilesRepository } from "./files.repository.js"

import { FilesService } from "./files.service.js"

@Module({
  imports: [AuthModule],

  controllers: [FilesController],

  providers: [FilesRepository, FilesService],

  exports: [FilesService],
})
export class FilesModule {}
