import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Logger,
  Req,
  Res,
} from "@nestjs/common"

import type { Request, Response } from "express"

import { HealthRepository } from "./health.repository.js"

export class HealthController {
  private readonly logger = new Logger(HealthController.name)

  constructor(
    private readonly health: HealthRepository,
  ) {}

  healthz() {
    return { status: "ok" }
  }

  async readyz(request: Request, response: Response) {
    try {
      await this.health.checkDatabase()

      return response.status(HttpStatus.OK).json({ status: "ready" })
    } catch {
      this.logger.warn("Readiness check failed: database query did not succeed")

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

// Apply Nest's legacy decorators explicitly so this file also type-checks
// when TypeScript's standard decorator mode is enabled.
;(Controller("v1") as unknown as (target: Function) => void)(HealthController)
;(Inject(HealthRepository) as unknown as (
  target: Function,
  propertyKey: string | symbol | undefined,
  parameterIndex: number,
) => void)(HealthController, undefined, 0)

const healthControllerPrototype = HealthController.prototype
const healthzDescriptor = Object.getOwnPropertyDescriptor(
  healthControllerPrototype,
  "healthz",
)!
const readyzDescriptor = Object.getOwnPropertyDescriptor(
  healthControllerPrototype,
  "readyz",
)!

;(Get("healthz") as unknown as (
  target: object,
  propertyKey: string,
  descriptor: PropertyDescriptor,
) => void)(healthControllerPrototype, "healthz", healthzDescriptor)
;(Get("readyz") as unknown as (
  target: object,
  propertyKey: string,
  descriptor: PropertyDescriptor,
) => void)(healthControllerPrototype, "readyz", readyzDescriptor)
;(Req() as unknown as (
  target: object,
  propertyKey: string | symbol | undefined,
  parameterIndex: number,
) => void)(healthControllerPrototype, "readyz", 0)
;(Res() as unknown as (
  target: object,
  propertyKey: string | symbol | undefined,
  parameterIndex: number,
) => void)(healthControllerPrototype, "readyz", 1)
