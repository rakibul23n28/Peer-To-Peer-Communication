import { Controller, Get, HttpStatus, Inject, Req, Res } from "@nestjs/common"

import type { Request, Response } from "express"

import { HealthRepository } from "./health.repository.js"

@Controller("v1")
export class HealthController {
  constructor(
    @Inject(HealthRepository) private readonly health: HealthRepository,
  ) {}

  @Get("healthz")
  healthz() {
    return { status: "ok" }
  }

  @Get("readyz")
  async readyz(@Req() request: Request, @Res() response: Response) {
    try {
      await this.health.checkDatabase()

      return response.status(HttpStatus.OK).json({ status: "ready" })
    } catch {
      return response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: {
          code: "DATABASE_UNAVAILABLE",

          message: "Database is not ready",

          requestId: request.headers["x-request-id"]?.toString() ?? "req-local",
        },
      })
    }
  }
}
