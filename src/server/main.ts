import "reflect-metadata"

import { NestFactory } from "@nestjs/core"

import type { NestExpressApplication } from "@nestjs/platform-express"

import type { NextFunction, Request, Response } from "express"

import { WsAdapter } from "@nestjs/platform-ws"

import { env } from "../config/env.js"

import { HttpErrorFilter } from "../modules/shared/http-error.filter.js"

import { AppModule } from "./app.module.js"

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  logger: ["error", "warn", "log"],
})

app.useLogger(["error", "warn", "log"])

app.useBodyParser("json", { limit: "1mb" })

app.use((request: Request, response: Response, next: NextFunction) => {
  if (request.url.startsWith("/v1/"))
    response.setHeader("Cache-Control", "no-store")

  next()
})

app.useWebSocketAdapter(new WsAdapter(app))

app.useGlobalFilters(new HttpErrorFilter())

app.enableShutdownHooks()

await app.listen(env.API_PORT, "0.0.0.0")
