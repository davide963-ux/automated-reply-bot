import { lazyHandler } from '../src/lib/boot';

/**
 * Vercel Cron target (see vercel.json). Vercel sends `Authorization: Bearer $CRON_SECRET`
 * automatically when the CRON_SECRET env var is set. One call = one scheduler cycle;
 * the DB lock makes overlapping invocations a harmless no-op.
 */
export default lazyHandler(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { createHash, timingSafeEqual } = require('crypto') as typeof import('crypto');
  const { config } = require('../src/config/env') as typeof import('../src/config/env');
  const { ensureAccount } = require('../src/db/accounts') as typeof import('../src/db/accounts');
  const { createDeps } = require('../src/engine/deps') as typeof import('../src/engine/deps');
  const { runTick } = require('../src/engine/tick') as typeof import('../src/engine/tick');
  const { logger } = require('../src/lib/logger') as typeof import('../src/lib/logger');
  const log = logger.child({ module: 'vercel-tick' });
  const digest = (s: string) => createHash('sha256').update(s).digest();

  return async (req, res) => {
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
  };
});
