// Postgres pool — same DATABASE_URL as importer + family-graph + dashboards
// (Supabase pooler). All four apps share one DB; this app reads families/
// parents/students/schools, writes its own auth tables.

import { Pool } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';

let _pool: Pool | undefined;

export function getPool(): Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL env var is required');
    }
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      // Serverless tuning. Each Vercel lambda runs its own pg pool — with
      // pg's default `max: 10`, even a modest concurrent load multiplies
      // out and exhausts Supabase's pooler. Cap each lambda to a small
      // number and idle out aggressively so connections come back fast.
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return _pool;
}

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params as never);
}

export async function withTransaction<T>(
  fn: (q: typeof query) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txQuery = ((text: string, params?: unknown[]) =>
      client.query(text, params as never)) as typeof query;
    const result = await fn(txQuery);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
