import { z } from "zod"

declare const process: {
  cwd(): string
  env: Record<string, string | undefined>
  loadEnvFile(path?: string): void
}

try {
  process.loadEnvFile(`${process.cwd()}/.env`)
} catch (error) {
  if ((error as { code?: string }).code !== "ENOENT") throw error
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    PORT: z.coerce.number().int().min(1).max(65535).optional(),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    AUTH_COOKIE_PATH: z.string().default("/api/auth"),
    LOG_LEVEL: z.string().default("info"),
    JWT_SECRET: z
      .string()
      .min(32)
      .default("development-only-jwt-secret-not-for-production"),
    COOKIE_SECRET: z
      .string()
      .min(32)
      .default("development-only-cookie-secret-not-production"),
    DATABASE_URL: z
      .string()
      .min(1, "DATABASE_URL is required")
      .url()
      .refine((value) => {
        if (!URL.canParse(value)) return false
        const protocol = new URL(value).protocol
        return protocol === "postgres:" || protocol === "postgresql:"
      }, "DATABASE_URL must be a PostgreSQL connection string"),
    DIRECT_URL: z.string().url().optional(),
    CORS_ORIGIN: z.string().default(""),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    TURN_URLS: z.string().default(""),
    TURN_USERNAME: z.string().default(""),
    TURN_CREDENTIAL: z.string().default(""),
    TURN_SHARED_SECRET: z.string().default("").refine(
      (value) => value.length === 0 || value.length >= 32,
      "TURN_SHARED_SECRET must be at least 32 characters",
    ),
    TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  })
  .superRefine((value, context) => {
    const corsOrigins = value.CORS_ORIGIN
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter(Boolean)

    for (const origin of corsOrigins) {
      try {
        const parsedOrigin = new URL(origin)
        if (
          parsedOrigin.origin !== origin ||
          !["http:", "https:"].includes(parsedOrigin.protocol)
        ) {
          throw new Error("Origin must contain only scheme and host")
        }
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CORS_ORIGIN"],
          message:
            "CORS_ORIGIN must be comma-separated HTTP(S) origins without paths or wildcards",
        })
        break
      }
    }

    if (value.DIRECT_URL && URL.canParse(value.DIRECT_URL)) {
      const directProtocol = new URL(value.DIRECT_URL).protocol
      if (directProtocol !== "postgres:" && directProtocol !== "postgresql:") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DIRECT_URL"],
          message: "DIRECT_URL must be a PostgreSQL connection string",
        })
      }
    }

    const turnUrls = value.TURN_URLS.split(",").map((url) => url.trim()).filter(Boolean)
    const hasStaticTurnCredentials = Boolean(value.TURN_USERNAME) && Boolean(value.TURN_CREDENTIAL)
    if (Boolean(value.TURN_USERNAME) !== Boolean(value.TURN_CREDENTIAL)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURN_USERNAME"],
        message: "TURN_USERNAME and TURN_CREDENTIAL must be configured together",
      })
    }
    if (
      Boolean(turnUrls.length) !==
      Boolean(value.TURN_SHARED_SECRET || hasStaticTurnCredentials)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURN_URLS"],
        message: "Configure TURN_URLS with either TURN_SHARED_SECRET or both TURN_USERNAME and TURN_CREDENTIAL",
      })
    }
    if (value.TURN_SHARED_SECRET && hasStaticTurnCredentials) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURN_SHARED_SECRET"],
        message: "Use either TURN_SHARED_SECRET or static TURN_USERNAME/TURN_CREDENTIAL, not both",
      })
    }
    if (turnUrls.some((url) => !/^turns?:/i.test(url))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURN_URLS"],
        message: "TURN_URLS must contain comma-separated turn: or turns: URLs",
      })
    }
    if (value.NODE_ENV !== "production") return
    if (
      value.JWT_SECRET.startsWith("development-") ||
      value.JWT_SECRET.startsWith("replace-")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JWT_SECRET"],
        message: "JWT_SECRET must be rotated for production",
      })
    }
    if (
      value.COOKIE_SECRET.startsWith("development-") ||
      value.COOKIE_SECRET.startsWith("replace-")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["COOKIE_SECRET"],
        message: "COOKIE_SECRET must be rotated for production",
      })
    }
    if (!value.CORS_ORIGIN.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CORS_ORIGIN"],
        message: "CORS_ORIGIN is required in production",
      })
    }
    if (
      value.JWT_SECRET === value.COOKIE_SECRET
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["COOKIE_SECRET"],
        message: "COOKIE_SECRET must differ from JWT_SECRET",
      })
    }
    if (
      !URL.canParse(value.DATABASE_URL) ||
      !["require", "verify-ca", "verify-full"].includes(
        new URL(value.DATABASE_URL).searchParams.get("sslmode") ?? "",
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "DATABASE_URL must require TLS in production",
      })
    }
    if (
      value.DIRECT_URL &&
      (!URL.canParse(value.DIRECT_URL) ||
        !["require", "verify-ca", "verify-full"].includes(
          new URL(value.DIRECT_URL).searchParams.get("sslmode") ?? "",
        ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DIRECT_URL"],
        message: "DIRECT_URL must require TLS in production",
      })
    }
  })

export type Env = z.infer<typeof envSchema>

const parsedEnv = envSchema.safeParse(process.env)

if (!parsedEnv.success) {
  const details = parsedEnv.error.issues
    .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
    .join("\n")
  console.error(`Invalid server environment configuration:\n${details}`)
  throw new Error("Server environment validation failed.")
}

export const env = parsedEnv.data
