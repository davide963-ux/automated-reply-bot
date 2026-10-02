import { config } from './config/env';
import { closePool, dbHealthy } from './db/client';
import { ensureAccount } from './db/accounts';
import { logger } from './lib/logger';
import { logEvent } from './services/events';
import { getUsageToday, peekPublishSlot } from './services/rateLimit';

const log = logger.child({ module: 'main' });

/**
 * Phase 1 entry point: validates config, checks the database, and prints the
 * current safety state. No X, LLM or news calls happen yet.
 */
async function main(): Promise<void> {
  log.info('starting crypto-x-agent', {
    env: config.env,
    dryRun: config.flags.dryRun,
    autonomousMode: config.flags.autonomousMode,
    timezone: config.timezone,
    limits: config.limits,
  });

  if (!(await dbHealthy())) {
    log.error('database unreachable: publishing stays disabled');
    process.exitCode = 1;
    return;
  }

  const accountId = await ensureAccount();
  const usage = await getUsageToday(accountId);
  const postGate = await peekPublishSlot(accountId, 'post');
  const replyGate = await peekPublishSlot(accountId, 'reply');

  await logEvent({
    action: 'SYSTEM',
    decision: 'STARTUP',
    result: 'ok',
    details: { usage, postGate, replyGate, dryRun: config.flags.dryRun },
  });

  log.info('status', {
    postsToday: `${usage.postsToday}/${config.limits.maxPostsPerDay}`,
    repliesToday: `${usage.repliesToday}/${config.limits.maxRepliesPerDay}`,
    postGate,
    replyGate,
  });
}

main()
  .catch((err) => {
    log.error('fatal', { err });
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => undefined));
