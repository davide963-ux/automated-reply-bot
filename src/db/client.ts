import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config/env';
import { logger } from '../lib/logger';

const log = logger.child({ module: 'db' });

export const pool = new Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Managed Postgres (e.g. Supabase) usually requires TLS. Many managed hosts
  // use certificate chains Node does not trust by default, hence rejectUnauthorized:false.
  ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  // Errors on idle clients must not crash the process.
  log.error('idle pg client error', { err });
});

export function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<R>> {
  return pool.query<R>(text, params);
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch (rollbackErr) {
      log.error('rollback failed', { err: rollbackErr });
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch (err) {
    log.error('database health check failed', { err });
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
