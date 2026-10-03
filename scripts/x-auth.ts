/**
 * Connects the bot to your X account (OAuth 2.0 Authorization Code + PKCE).
 *
 *   npm run x:auth            local callback server on X_REDIRECT_URI (default http://127.0.0.1:3000/callback)
 *   npm run x:auth -- --manual   paste the redirected URL yourself (for remote machines)
 *
 * Tokens are stored in Postgres (encrypted if TOKEN_ENCRYPTION_KEY is set).
 * Prerequisite: in the X developer portal, add X_REDIRECT_URI as a callback URL
 * and enable OAuth 2.0 with read+write permissions.
 */
import { createServer } from 'http';
import { createInterface } from 'readline/promises';
import { config } from '../src/config/env';
import { ensureAccount } from '../src/db/accounts';
import { closePool, query } from '../src/db/client';
import { buildAuthUrl, createPkce, exchangeCode } from '../src/x/oauth';
import { createXClient } from '../src/x/client';
import { saveTokens } from '../src/x/tokens';

async function waitForCode(redirect: URL, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', redirect.origin);
      if (u.pathname !== redirect.pathname) { res.writeHead(404).end(); return; }
      const code = u.searchParams.get('code');
      const ok = code && u.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' }).end(ok ? 'Authorized. You can close this tab.' : 'Invalid callback (state mismatch or no code).');
      if (ok) { clearTimeout(timer); server.close(); resolve(code); }
    });
    const timer = setTimeout(() => { server.close(); reject(new Error('timed out after 5 minutes')); }, 300_000);
    server.listen(Number(redirect.port) || 80, redirect.hostname);
  });
}

async function main(): Promise<void> {
  const { clientId, redirectUri } = config.x;
  if (!clientId) throw new Error('set X_CLIENT_ID (and X_CLIENT_SECRET for a confidential app) first');

  const pkce = createPkce();
  const url = buildAuthUrl({ clientId, redirectUri, state: pkce.state, challenge: pkce.challenge });
  console.log('\n1) Open this URL while logged in as the bot account:\n\n' + url + '\n');

  let code: string;
  const redirect = new URL(redirectUri);
  const local = ['127.0.0.1', 'localhost'].includes(redirect.hostname);
  if (local && !process.argv.includes('--manual')) {
    console.log(`2) Waiting for the redirect on ${redirectUri} ...`);
    code = await waitForCode(redirect, pkce.state);
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const pasted = await rl.question('2) Paste the full URL you were redirected to: ');
    rl.close();
    const u = new URL(pasted.trim());
    if (u.searchParams.get('state') !== pkce.state) throw new Error('state mismatch: aborting');
    code = u.searchParams.get('code') ?? '';
    if (!code) throw new Error('no code in that URL');
  }

  const tokens = await exchangeCode(code, pkce.verifier);
  const accountId = await ensureAccount();
  await saveTokens(accountId, tokens);

  const me = await createXClient(accountId).me();
  console.log(`\nConnected as @${me.username} (id ${me.id}).`);
  const configured = config.accountHandle.replace(/^@/, '').toLowerCase();
  if (configured !== 'unconfigured' && configured !== me.username.toLowerCase()) {
    console.log(`WARNING: X_ACCOUNT_HANDLE is @${configured}. The bot will refuse to run until they match.`);
  } else {
    await query('update accounts set x_user_id = $2 where id = $1', [accountId, me.id]);
  }
  console.log('Refresh token stored: ' + (tokens.refreshToken ? 'yes' : 'NO (did the app request offline.access?)'));
}

main()
  .catch((err) => { console.error('x:auth failed:', (err as Error).message); process.exitCode = 1; })
  .finally(() => closePool().catch(() => undefined));
