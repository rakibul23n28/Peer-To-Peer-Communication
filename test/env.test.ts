import { describe, expect, it } from 'vitest';
import { envSchema } from '../src/config/env.js';

describe('environment configuration', () => {
  it('accepts PostgreSQL connection strings including postgres://', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'postgres://user:password@db.example.test:5432/orbit?sslmode=require',
    });

    expect(result.success).toBe(true);
  });

  it('rejects non-PostgreSQL database URLs', () => {
    const result = envSchema.safeParse({
      DATABASE_URL: 'https://db.example.test',
    });

    expect(result.success).toBe(false);
  });
});
