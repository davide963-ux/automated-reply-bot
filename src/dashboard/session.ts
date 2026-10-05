import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * Login session for the dashboard: a signed, expiring cookie. There is no server-side session table, so it also
 * works before the database is migrated. The signing key is derived from DASHBOARD_TOKEN: changing the token
 * logs everybody out.
 */
export const SESSION_COOKIE = 'toad_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

const signingKey = (token: string) => createHmac('sha256', 'toad-guru-session-v1').update(token).digest();
const sign = (payload: string, token: string) => createHmac('sha256', signingKey(token)).update(payload).digest('base64url');

export function createSession(token: string, nowMs = Date.now()): string {
  const payload = String(Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS);
  return `${payload}.${sign(payload, token)}`;
}

export function verifySession(value: string | undefined, token: string | undefined, nowMs = Date.now()): boolean {
  if (!value || !token) return false;
  const dot = value.indexOf('.');
  if (dot < 1) return false;
  const payload = value.slice(0, dot);
  if (!/^\d{9,12}$/.test(payload)) return false;
  const given = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(sign(payload, token));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return false;
  return Number(payload) > Math.floor(nowMs / 1000);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Set-Cookie value. maxAge 0 clears it. `secure` is on whenever the request came over https. */
export function sessionCookie(value: string, secure: boolean, maxAge = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export const hashIp = (ip: string) => createHash('sha256').update(`toad-login|${ip}`).digest('hex').slice(0, 32);
