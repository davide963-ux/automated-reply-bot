import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { closePool, pool } from './client';
import { logger } from '../lib/logger';

const log = logger.child({ module: 'migrate' });
const SQL_DIR = join(__dirname, '..', '..', 'sql');

/**
 * Applies sql/*.sql in filename order. Each file runs in its own transaction
 * and is recorded in schema_migrations, so re-running is a no-op.
 */
export async function runMigrations(): Promise<string[]> {
  await pool.query(`
    create table if not exists schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )`);

  const applied = new Set(
    (await pool.query<{ filename: string }>('select filename from schema_migrations')).rows.map(
      (r) => r.filename,
    ),
  );

  const files = readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(SQL_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
      ran.push(file);
      log.info('migration applied', { file });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      log.error('migration failed, rolled back', { file, err });
      throw err;
    } finally {
      client.release();
    }
  }
  if (ran.length === 0) log.info('database already up to date');
  return ran;
}

if (require.main === module) {
  runMigrations()
    .then(() => closePool())
    .catch(async () => {
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
