import type { IncomingMessage, ServerResponse } from 'http';
import { config } from '../config/env';
import { ensureAccount } from '../db/accounts';
import { query } from '../db/client';
import { logger } from '../lib/logger';
import { logEvent } from '../services/events';
import { createXClient } from '../x/client';
import { buildAuthUrl, createPkce, exchangeCode, TokenError } from '../x/oauth';
import { saveTokens } from '../x/tokens';
import { isAuthorized } from './handler';

const log = logger.child({ module: 'x-connect' });
const STATE_PREFIX = 'x_oauth:';
const STATE_TTL_MIN = 10;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function page(res: ServerResponse, status: number, title: string, body: string, backHref: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:10vh auto;padding:0 16px">
<h2>${esc(title)}</h2><p>${body}</p><p><a href="${esc(backHref)}">Back to the dashboard</a></p></body>`);
}

/** Dashboard path derived from where this request came from, so it works on Vercel and in the worker. */
const dashboardHref = (req: IncomingMessage) => (req.url ?? '').startsWith('/api/') ? '/api/dashboard' : '/';

/**
 * Step 1: an authenticated operator starts the connection.
 * We create PKCE + a random single-use `state`, remember them in the database,
 * and redirect to X. Requires the dashboard token (Basic or Bearer).
 */
export async function handleXConnect(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!config.runtime.dashboardToken) return page(res, 503, 'Dashboard disabled', 'Set DASHBOARD_TOKEN first.', dashboardHref(req));
  if (!isAuthorized(req.headers.authorization, config.runtime.dashboardToken)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="crypto-x-agent", charset="UTF-8"', 'content-type': 'text/plain' });
    res.end('unauthorized');
    return;
  }
  if (!config.x.clientId) {
    return page(res, 400, 'X is not configured', 'Set <code>X_CLIENT_ID</code> (and <code>X_CLIENT_SECRET</code>) in the environment variables, redeploy, then try again.', dashboardHref(req));
  }

  const pkce = createPkce();
  await query(`delete from bot_state where key like $1 and updated_at < now() - make_interval(mins => $2)`, [`${STATE_PREFIX}%`, STATE_TTL_MIN]);
  await query(`insert into bot_state (key, value) values ($1, $2)`, [`${STATE_PREFIX}${pkce.state}`, JSON.stringify({ verifier: pkce.verifier })]);

  const url = buildAuthUrl({ clientId: config.x.clientId, redirectUri: config.x.redirectUri, state: pkce.state, challenge: pkce.challenge });
  res.writeHead(302, { location: url, 'cache-control': 'no-store' });
  res.end();
}

/**
 * Step 2: X redirects the browser back here with ?code&state.
 * No dashboard password is needed: the unguessable single-use `state` (only ever
 * handed to an authenticated operator, valid 10 minutes) is the proof, which is
 * the standard OAuth CSRF defence.
 */
export async function handleXCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const back = dashboardHref(req);
  const u = new URL(req.url ?? '/', 'http://local');

  const denied = u.searchParams.get('error');
  if (denied) return page(res, 400, 'X authorization was cancelled', `X said: ${esc(denied.slice(0, 80))}.`, back);

  const code = u.searchParams.get('code') ?? '';
  const state = u.searchParams.get('state') ?? '';
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(state) || !code || code.length > 2048) {
    return page(res, 400, 'Invalid callback', 'Missing or malformed code/state. Start again from the dashboard.', back);
  }

  // Single use + expiry in one atomic statement.
  const taken = await query<{ value: { verifier: string } }>(
    `delete from bot_state where key = $1 and updated_at > now() - make_interval(mins => $2) returning value`,
    [`${STATE_PREFIX}${state}`, STATE_TTL_MIN],
  );
  const verifier = taken.rows[0]?.value.verifier;
  if (!verifier) return page(res, 400, 'Link expired or already used', 'Start again from the dashboard.', back);

  try {
    const tokens = await exchangeCode(code, verifier);
    const accountId = await ensureAccount();
    await saveTokens(accountId, tokens);

    const me = await createXClient(accountId).me();
    const configured = config.accountHandle.replace(/^@/, '').toLowerCase();
    if (configured !== 'unconfigured' && configured !== me.username.toLowerCase()) {
      // Wrong account: do not keep credentials for it.
      await query('delete from x_tokens where account_id = $1', [accountId]);
      await logEvent({ action: 'ERROR', decision: 'WRONG_X_ACCOUNT', reason: `authorized @${me.username}, expected @${configured}`, result: 'tokens discarded' });
      return page(res, 409, 'Wrong X account',
        `You authorized <b>@${esc(me.username)}</b> but <code>X_ACCOUNT_HANDLE</code> is <b>@${esc(configured)}</b>. Nothing was saved. Log in to X as the right account (or fix the variable) and try again.`, back);
    }
    await query('update accounts set x_user_id = $2 where id = $1', [accountId, me.id]);
    await logEvent({ action: 'SYSTEM', decision: 'X_CONNECTED', result: `@${me.username}` });
    log.info('X account connected', { username: me.username, refreshToken: Boolean(tokens.refreshToken) });
    return page(res, 200, `Connected as @${me.username}`,
      tokens.refreshToken ? 'The bot can now read and post. It is still PAUSED and in DRY_RUN until you change that.' : 'Connected, but X did not return a refresh token: the connection will stop working after about 2 hours. Make sure the app requests <code>offline.access</code>.', back);
  } catch (err) {
    log.warn('x callback failed', { err });
    const detail = err instanceof TokenError ? esc(err.message) : 'unexpected error (see the Activity log)';
    return page(res, 502, 'Could not complete the connection', `${detail}. Check that <code>X_REDIRECT_URI</code> matches the callback URL registered in the X developer portal exactly.`, back);
  }
}
