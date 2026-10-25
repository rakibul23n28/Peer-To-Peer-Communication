import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common"

import { Prisma } from "@prisma/client"

import type { Request, Response } from "express"

import { ZodError } from "zod"

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp()

    const request = context.getRequest<Request>()

    const response = context.getResponse<Response>()

    const requestId = request.headers["x-request-id"]?.toString() ?? "req-local"

    let status = HttpStatus.INTERNAL_SERVER_ERROR

    let code = "INTERNAL_ERROR"

    let message = "Internal server error"

    if (exception instanceof HttpException) {
      status = exception.getStatus()

      const payload = exception.getResponse()

      if (typeof payload === "string") message = payload
      else if (typeof payload === "object" && payload !== null) {
        const body = payload as { code?: string; message?: string | string[] }

        code = body.code ?? "REQUEST_FAILED"

        message = Array.isArray(body.message)
          ? body.message.join(", ")
          : (body.message ?? message)

        const retryAfterSeconds = (body as { retryAfterSeconds?: number })
          .retryAfterSeconds

        if (retryAfterSeconds)
          response.setHeader("Retry-After", String(retryAfterSeconds))
      }
    } else if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST

      code = "INVALID_REQUEST"

      message = "Request validation failed"
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === "P2002") {
        status = HttpStatus.CONFLICT

        code = "CONFLICT"

        message = "The requested record already exists"
      } else if (exception.code === "P2025") {
        status = HttpStatus.NOT_FOUND

        code = "NOT_FOUND"

        message = "The requested record was not found"
      }
    } else if (exception instanceof Prisma.PrismaClientInitializationError) {
      status = HttpStatus.SERVICE_UNAVAILABLE

      code = "DATABASE_UNAVAILABLE"

      message = "Database is not available"
    } else if (
      typeof exception === "object" &&
      exception !== null &&
      "code" in exception &&
      typeof exception.code === "string" &&
      (/^(08|53)/.test(exception.code) ||
        ["P1000", "P1001", "P1002", "P1017", "P2024"].includes(
          exception.code,
        ) ||
        ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(
          exception.code,
        ))
    ) {
      status = HttpStatus.SERVICE_UNAVAILABLE

      code = "DATABASE_UNAVAILABLE"

      message = "Database is not available"
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const errorName =
        exception instanceof Error ? exception.constructor.name : "UnknownError"
      const errorCode =
        typeof exception === "object" &&
        exception !== null &&
        "code" in exception &&
        typeof exception.code === "string"
          ? exception.code
          : "none"
      const errorMessage =
        exception instanceof TypeError
          ? exception.message.replace(/[\r\n]+/g, " ").slice(0, 240)
          : undefined
      const errorLocation =
        exception instanceof Error
          ? exception.stack?.split("\n").slice(1, 3).join(" <- ")
          : undefined
      this.logger.error(
        `Request failed with ${errorName} (code: ${errorCode})${errorMessage ? `: ${errorMessage}` : ""}${errorLocation ? ` at ${errorLocation}` : ""}`,
      )
    }

    response.status(status).json({
      error: { code, message, requestId },
    })
  }
}

export function badRequest(code: string, message: string): HttpException {
  return new HttpException({ code, message }, HttpStatus.BAD_REQUEST)
}

export function unauthorized(
  message = "Authentication required",
): HttpException {
  return new HttpException(
    { code: "NOT_AUTHENTICATED", message },
    HttpStatus.UNAUTHORIZED,
  )
}

export function notFound(
  message = "The requested record was not found",
): HttpException {
  return new HttpException({ code: "NOT_FOUND", message }, HttpStatus.NOT_FOUND)
}
