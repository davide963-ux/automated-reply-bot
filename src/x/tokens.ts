import { config } from '../config/env';
import { query, withTransaction } from '../db/client';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { logger } from '../lib/logger';
import { logEvent } from '../services/events';
import { refreshAccessToken, TokenError, type TokenSet } from './oauth';
import { XAuthError } from './types';

const log = logger.child({ module: 'x-tokens' });
const REFRESH_MARGIN_MS = 120_000;

interface TokenRow {
  access_token: string;
  refresh_token: string | null;
  expires_at: Date;
  needs_reauth: boolean;
}

/** Persist tokens (encrypted when TOKEN_ENCRYPTION_KEY is set). Clears needs_reauth. */
export async function saveTokens(accountId: string, t: TokenSet): Promise<void> {
  const key = config.x.tokenEncryptionKey;
  await query(
    `insert into x_tokens (account_id, access_token, refresh_token, expires_at, scope, needs_reauth)
     values ($1,$2,$3,$4,$5,false)
     on conflict (account_id) do update set
       access_token = excluded.access_token,
       -- keep the old refresh token if X did not send a new one (no rotation)
       refresh_token = coalesce(excluded.refresh_token, x_tokens.refresh_token),
       expires_at = excluded.expires_at, scope = coalesce(excluded.scope, x_tokens.scope),
       needs_reauth = false, updated_at = now()`,
    [
      accountId,
      encryptSecret(t.accessToken, key),
      t.refreshToken ? encryptSecret(t.refreshToken, key) : null,
      t.expiresAt,
      t.scope ?? null,
    ],
  );
}

/** One-time bootstrap from X_ACCESS_TOKEN / X_REFRESH_TOKEN env vars when the table is empty. */
async function seedFromEnv(accountId: string, now: Date): Promise<boolean> {
  const { accessToken, refreshToken } = config.x;
  if (!accessToken && !refreshToken) return false;
  await saveTokens(accountId, {
    accessToken: accessToken ?? 'expired',
    refreshToken,
    // Unknown expiry: with a refresh token, refresh right away; without one, assume 1h and rely on 401 handling.
    expiresAt: refreshToken ? now : new Date(now.getTime() + 3_600_000),
  });
  log.info('seeded X tokens from environment into the database');
  return true;
}

export async function hasTokens(accountId: string): Promise<boolean> {
  const { rows } = await query('select 1 from x_tokens where account_id = $1', [accountId]);
  return rows.length > 0 || Boolean(config.x.accessToken || config.x.refreshToken);
}

/**
 * Returns a valid access token, refreshing it when it expires within 2 minutes.
 * The refresh runs inside a transaction holding a row lock, so two concurrent
 * workers can never both spend the same (possibly single-use) refresh token.
 */
export async function getAccessToken(accountId: string, opts: { force?: boolean; now?: Date } = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const key = config.x.tokenEncryptionKey;

  let { rows } = await query<TokenRow>(
    'select access_token, refresh_token, expires_at, needs_reauth from x_tokens where account_id = $1',
    [accountId],
  );
  if (rows.length === 0) {
    if (!(await seedFromEnv(accountId, now))) throw new XAuthError('X is not connected: run `npm run x:auth`');
    rows = (await query<TokenRow>(
      'select access_token, refresh_token, expires_at, needs_reauth from x_tokens where account_id = $1',
      [accountId],
    )).rows;
  }
  const row = rows[0];
  if (!row) throw new XAuthError('X is not connected: run `npm run x:auth`');
  if (row.needs_reauth) throw new XAuthError('X authorization expired: run `npm run x:auth` again');

  const fresh = row.expires_at.getTime() - now.getTime() > REFRESH_MARGIN_MS;
  if (fresh && !opts.force) return decryptSecret(row.access_token, key);

  if (!row.refresh_token) {
    if (opts.force) throw new XAuthError('access token rejected and no refresh token is stored: run `npm run x:auth`');
    return decryptSecret(row.access_token, key); // no refresh token: use it until X says 401
  }

  const outcome = await withTransaction<string | { reauth: string }>(async (c) => {
    const locked = (await c.query<TokenRow>(
      'select access_token, refresh_token, expires_at, needs_reauth from x_tokens where account_id = $1 for update',
      [accountId],
    )).rows[0];
    if (!locked || !locked.refresh_token) throw new XAuthError('X refresh token missing');
    // Someone else refreshed while we waited for the lock.
    const stillStale = locked.expires_at.getTime() - now.getTime() <= REFRESH_MARGIN_MS;
    if (!stillStale && !opts.force) return decryptSecret(locked.access_token, key);
    if (opts.force && locked.access_token !== row.access_token) return decryptSecret(locked.access_token, key);

    let t: TokenSet;
    try {
      t = await refreshAccessToken(decryptSecret(locked.refresh_token, key), now);
    } catch (err) {
      if (err instanceof TokenError && err.invalidGrant) {
        // Return (don't throw) so the flag COMMITS; a throw would roll it back.
        await c.query('update x_tokens set needs_reauth = true, updated_at = now() where account_id = $1', [accountId]);
        return { reauth: err.message };
      }
      throw err; // transient: try again next tick, do not mark anything
    }

    await c.query(
      `update x_tokens set access_token=$2, refresh_token=coalesce($3, refresh_token), expires_at=$4,
              scope=coalesce($5, scope), needs_reauth=false, updated_at=now() where account_id=$1`,
      [
        accountId,
        encryptSecret(t.accessToken, key),
        t.refreshToken ? encryptSecret(t.refreshToken, key) : null,
        t.expiresAt,
        t.scope ?? null,
      ],
    );
    log.info('X access token refreshed', { expiresAt: t.expiresAt.toISOString(), rotated: Boolean(t.refreshToken) });
    return t.accessToken;
  });

  if (typeof outcome !== 'string') {
    await logEvent({ action: 'ERROR', decision: 'X_REAUTH_NEEDED', reason: outcome.reauth, result: 'refresh token rejected' });
    throw new XAuthError(`X refresh token rejected (${outcome.reauth}): run \`npm run x:auth\``);
  }
  return outcome;
}
