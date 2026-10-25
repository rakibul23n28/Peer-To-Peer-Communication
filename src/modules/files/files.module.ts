import { Module } from "@nestjs/common"

import { FilesController } from "./files.controller.js"

import { FilesRepository } from "./files.repository.js"

import { FilesService } from "./files.service.js"

@Module({
  controllers: [FilesController],

  providers: [FilesRepository, FilesService],
})
export class FilesModule {}
