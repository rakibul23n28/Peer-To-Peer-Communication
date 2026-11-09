import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module.js"
import { AccessRequestEvents } from "./access-request-events.js"
import { AccessRequestsController } from "./access-requests.controller.js"
import { AccessRequestsRepository } from "./access-requests.repository.js"
import { AccessRequestsService } from "./access-requests.service.js"

@Module({
  imports: [AuthModule],
  controllers: [AccessRequestsController],
  providers: [AccessRequestEvents, AccessRequestsRepository, AccessRequestsService],
  exports: [AccessRequestEvents, AccessRequestsService],
})
export class AccessRequestsModule {}
