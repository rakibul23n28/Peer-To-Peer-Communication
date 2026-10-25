import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  API_PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default('info'),
  JWT_SECRET: z.string().min(32).default('development-only-jwt-secret-not-for-production'),
  COOKIE_SECRET: z.string().min(32).default('development-only-cookie-secret-not-production'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/orbit'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
