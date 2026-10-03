import { createHash, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { config } from '../src/config/env';
import { ensureAccount } from '../src/db/accounts';
import { createDeps } from '../src/engine/deps';
import { runTick } from '../src/engine/tick';
import { logger } from '../src/lib/logger';

const log = logger.child({ module: 'vercel-tick' });
const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Vercel Cron target (see vercel.json). Vercel sends `Authorization: Bearer $CRON_SECRET`
 * automatically when the CRON_SECRET env var is set. One call = one scheduler cycle;
 * the DB lock makes overlapping invocations a harmless no-op.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const secret = config.runtime.cronSecret;
  if (!secret) return reply(503, { error: 'set CRON_SECRET (min 16 chars)' });
  const supplied = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!timingSafeEqual(digest(supplied), digest(secret))) return reply(401, { error: 'unauthorized' });

  try {
    const deps = createDeps(await ensureAccount());
    return reply(200, await runTick(deps));
  } catch (err) {
    log.error('tick failed', { err });
    return reply(500, { error: 'tick failed' });
  }
}
