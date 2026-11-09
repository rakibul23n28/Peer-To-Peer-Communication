import assert from "node:assert/strict"
import test from "node:test"

import type { ArgumentsHost } from "@nestjs/common"
import { Prisma } from "@prisma/client"
import type { Request, Response } from "express"

import { HttpErrorFilter } from "../src/modules/shared/http-error.filter.ts"

test("maps Prisma P1001 connection failures to a retryable database-unavailable response", () => {
  const result: { status?: number; body?: { error: { code: string; message: string; requestId: string } } } = {}
  const response = {
    status(status: number) {
      result.status = status
      return this
    },
    json(body: typeof result.body) {
      result.body = body
      return this
    },
    setHeader() {
      return this
    },
  } as unknown as Response
  const request = { headers: { "x-request-id": "database-test" } } as Request
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as ArgumentsHost
  const error = new Prisma.PrismaClientKnownRequestError("unreachable", {
    code: "P1001",
    clientVersion: "6.19.3",
  })

  new HttpErrorFilter().catch(error, host)

  assert.equal(result.status, 503)
  assert.deepEqual(result.body, {
    error: {
      code: "DATABASE_UNAVAILABLE",
      message: "Database is temporarily unreachable. Please try again shortly.",
      requestId: "database-test",
    },
  })
})
