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
    NODE_ENV: z.string().default("development"),
    API_PORT: z.coerce.number().default(3000),
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
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol
        return protocol === "postgres:" || protocol === "postgresql:"
      }, "DATABASE_URL must be a PostgreSQL connection string")
      .optional(),
    DIRECT_URL: z.string().url().optional(),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    TURN_URLS: z.string().default(""),
    TURN_SHARED_SECRET: z.string().default("").refine(
      (value) => value.length === 0 || value.length >= 32,
      "TURN_SHARED_SECRET must be at least 32 characters",
    ),
    TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  })
  .superRefine((value, context) => {
    const turnUrls = value.TURN_URLS.split(",").map((url) => url.trim()).filter(Boolean)
    if (Boolean(turnUrls.length) !== Boolean(value.TURN_SHARED_SECRET)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURN_SHARED_SECRET"],
        message: "TURN_URLS and TURN_SHARED_SECRET must be configured together",
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
    if (!value.DATABASE_URL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is required in production",
      })
    } else if (
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
  })

export type Env = z.infer<typeof envSchema>

export const env = envSchema.parse(process.env)
