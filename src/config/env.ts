import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default('info'),
  JWT_SECRET: z.string().default('development-secret-change-me'),
  COOKIE_SECRET: z.string().default('development-cookie-secret-change-me'),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/orbit'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
});

export type Env = z.infer<typeof envSchema>;
