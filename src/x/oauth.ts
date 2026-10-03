import { createHash, randomBytes } from 'crypto';
import { config } from '../config/env';
import { fetchWithTimeout } from '../lib/http';

/**
 * OAuth 2.0 Authorization Code + PKCE for X.
 * Token endpoint: POST {apiBase}/2/oauth2/token (form-encoded).
 * "offline.access" is what makes X issue a refresh token.
 */
export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];
const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createPkce(): { verifier: string; challenge: string; state: string } {
  const verifier = b64url(randomBytes(48)); // 64 chars, within the 43-128 allowed
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, state: b64url(randomBytes(16)) };
}

export function buildAuthUrl(a: { clientId: string; redirectUri: string; state: string; challenge: string; scopes?: string[] }): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', a.clientId);
  u.searchParams.set('redirect_uri', a.redirectUri);
  u.searchParams.set('scope', (a.scopes ?? X_SCOPES).join(' '));
  u.searchParams.set('state', a.state);
  u.searchParams.set('code_challenge', a.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope?: string;
}

/** `invalidGrant`: the refresh token is dead (revoked/expired/already used): a human must re-authorize. */
export class TokenError extends Error {
  constructor(message: string, public readonly invalidGrant: boolean) {
    super(message);
    this.name = 'TokenError';
  }
}

async function tokenRequest(params: Record<string, string>, now: Date): Promise<TokenSet> {
  const { clientId, clientSecret, apiBase } = config.x;
  if (!clientId) throw new TokenError('X_CLIENT_ID is not set', false);

  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams({ ...params, client_id: clientId });
  // Confidential clients authenticate with HTTP Basic; public clients send only client_id.
  if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(`${apiBase}/2/oauth2/token`, { method: 'POST', headers, body }, 20_000);
  } catch (err) {
    throw new TokenError(`token endpoint unreachable: ${(err as Error).message}`, false);
  }

  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    const code = String(json.error ?? '');
    // 4xx with an OAuth error = definitive. 5xx = transient.
    const invalid = res.status >= 400 && res.status < 500 && (code === 'invalid_grant' || code === 'invalid_request' || code === 'invalid_client' || res.status === 401);
    throw new TokenError(`token endpoint HTTP ${res.status}${code ? ` (${code})` : ''}`, invalid);
  }

  const access = json.access_token;
  if (typeof access !== 'string' || !access) throw new TokenError('token endpoint returned no access_token', false);
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 7200;
  return {
    accessToken: access,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expiresAt: new Date(now.getTime() + expiresIn * 1000),
    scope: typeof json.scope === 'string' ? json.scope : undefined,
  };
}

export function exchangeCode(code: string, verifier: string, now = new Date()): Promise<TokenSet> {
  return tokenRequest(
    { grant_type: 'authorization_code', code, redirect_uri: config.x.redirectUri, code_verifier: verifier },
    now,
  );
}

export function refreshAccessToken(refreshToken: string, now = new Date()): Promise<TokenSet> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, now);
}
