import { query } from './client';
import { config } from '../config/env';

/** Single-account bot: make sure the row for the configured handle exists. */
export async function ensureAccount(
  handle: string = config.accountHandle,
  timezone: string = config.timezone,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `insert into accounts (handle, timezone) values ($1, $2)
     on conflict (handle) do update set timezone = excluded.timezone
     returning id`,
    [handle, timezone],
  );
  const row = rows[0];
  if (!row) throw new Error('ensureAccount: no row returned');
  return row.id;
}
