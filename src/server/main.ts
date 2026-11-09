import "reflect-metadata"

import { resolve } from "node:path"

import { NestFactory } from "@nestjs/core"

import type { NestExpressApplication } from "@nestjs/platform-express"

import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express"
import { json } from "express"

import { WsAdapter } from "@nestjs/platform-ws"

import { env } from "../config/env.js"

import { HttpErrorFilter } from "../modules/shared/http-error.filter.js"

import { AppModule } from "./app.module.js"

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  bodyParser: false,
  logger:
    env.NODE_ENV === "production"
      ? ["error", "warn"]
      : ["error", "warn", "log"],
})

app.useLogger(
  env.NODE_ENV === "production" ? ["error", "warn"] : ["error", "warn", "log"],
)

app.set("trust proxy", 1)
app.use(
  "/v1/conversations/:conversationId/shared-folders",
  json({ limit: "6mb" }),
)
app.use(json({ limit: "1mb" }))

const corsOrigins = (env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean)

app.enableCors({
  origin: (origin, callback) => {
    callback(null, !origin || corsOrigins.includes(origin))
  },
  credentials: true,
})

const authRateLimits = new Map<
  string,
  { requests: number; resetAt: number }
>()
const authRateLimit: RequestHandler = (request, response, next) => {
  const route = request.path.split("/")[1] ?? "auth"
  const limit = route === "register" ? 10 : route === "login" ? 30 : 60
  const now = Date.now()
  const key = `${request.ip ?? request.socket.remoteAddress ?? "unknown"}:${route}`
  const current = authRateLimits.get(key)
  const bucket =
    !current || current.resetAt <= now
      ? { requests: 1, resetAt: now + 15 * 60_000 }
      : { ...current, requests: current.requests + 1 }
  authRateLimits.set(key, bucket)

  if (authRateLimits.size > 10_000) {
    for (const [entryKey, entry] of authRateLimits) {
      if (entry.resetAt <= now) authRateLimits.delete(entryKey)
    }
  }

  if (bucket.requests > limit) {
    response.setHeader(
      "Retry-After",
      String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))),
    )
    response.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many authentication requests. Try again later.",
      },
    })
    return
  }

  next()
}

app.use("/v1/auth", authRateLimit)

app.use((request: Request, response: Response, next: NextFunction) => {
  if (request.url.startsWith("/v1/"))
    response.setHeader("Cache-Control", "no-store")

  next()
})

const webRoot = resolve(process.cwd(), "dist")
app.use("/__preview/sw.js", (_request: Request, response: Response, next: NextFunction) => {
  response.setHeader("Cache-Control", "no-cache")
  response.setHeader("Service-Worker-Allowed", "/__preview/")
  response.type("application/javascript")
  next()
})
app.useStaticAssets(webRoot, { index: false })
app.use((request: Request, response: Response, next: NextFunction) => {
  if (
    request.method !== "GET" ||
    request.path === "/health" ||
    request.path === "/v1" ||
    request.path.startsWith("/v1/") ||
    request.path.startsWith("/__preview/") ||
    !request.accepts("html")
  ) {
    next()
    return
  }

  response.sendFile(resolve(webRoot, "index.html"))
})

app.useWebSocketAdapter(new WsAdapter(app))

app.useGlobalFilters(new HttpErrorFilter())

app.enableShutdownHooks()

await app.listen(env.PORT ?? 3000, "0.0.0.0")
