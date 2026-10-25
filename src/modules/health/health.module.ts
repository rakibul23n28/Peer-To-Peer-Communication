import { Module } from "@nestjs/common"

import { HealthController } from "./health.controller.js"

import { HealthRepository } from "./health.repository.js"

@Module({
  controllers: [HealthController],

  providers: [HealthRepository],
})
export class HealthModule {}
