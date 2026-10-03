import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Optional at-rest encryption for OAuth tokens stored in Postgres.
 * Set TOKEN_ENCRYPTION_KEY to 32 bytes as 64 hex chars or base64.
 * Format: "enc:v1:<iv b64>:<tag b64>:<ciphertext b64>" (AES-256-GCM).
 * Without a key, tokens are stored as plain text (the DB is then the trust boundary).
 */
const PREFIX = 'enc:v1:';

export function parseKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars or base64)');
  }
  return key;
}

export function encryptSecret(plain: string, rawKey: string | undefined): string {
  const key = parseKey(rawKey);
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(stored: string, rawKey: string | undefined): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const key = parseKey(rawKey);
  if (!key) throw new Error('stored token is encrypted but TOKEN_ENCRYPTION_KEY is not set');
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(':');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
