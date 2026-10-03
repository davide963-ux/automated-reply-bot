import { query } from './client';

/** Engine bookkeeping (cursors, backoff timestamps). Separate from user-editable settings. */
export async function getState<T>(key: string): Promise<T | undefined> {
  const { rows } = await query<{ value: T }>('select value from bot_state where key = $1', [key]);
  return rows[0]?.value;
}

export async function setState(key: string, value: unknown): Promise<void> {
  await query(
    `insert into bot_state (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
