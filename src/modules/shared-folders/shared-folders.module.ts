import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module.js"
import { SharedFoldersController } from "./shared-folders.controller.js"
import { SharedFoldersEvents } from "./shared-folders-events.js"
import { SharedFoldersRepository } from "./shared-folders.repository.js"
import { SharedFoldersService } from "./shared-folders.service.js"

@Module({
  imports: [AuthModule],
  controllers: [SharedFoldersController],
  providers: [SharedFoldersRepository, SharedFoldersService, SharedFoldersEvents],
  exports: [SharedFoldersEvents],
})
export class SharedFoldersModule {}
