import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from '../config/env.js';

const pool = env.DATABASE_URL
  ? new Pool({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 10,
    })
  : null;

export const db: NodePgDatabase | null = pool ? drizzle(pool) : null;

export class DatabaseUnavailableError extends Error {
  constructor() {
    super('Database is not configured or is unavailable');
    this.name = 'DatabaseUnavailableError';
  }
}

export function getPool(): Pool {
  if (!pool) {
    throw new DatabaseUnavailableError();
  }
  return pool;
}

export async function checkDatabase(): Promise<void> {
  await getPool().query('SELECT 1');
}

export async function inTransaction<T>(
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function queryRows<T extends QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, [...values]);
  return result.rows;
}
