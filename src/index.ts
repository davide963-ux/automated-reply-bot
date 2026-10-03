import { config } from './config/env';
import { closePool, dbHealthy } from './db/client';
import { ensureAccount } from './db/accounts';
import { loadSettings } from './config/settings';
import { createDeps } from './engine/deps';
import { runTick } from './engine/tick';
import { collectNews } from './news/collector';
import { logger } from './lib/logger';
import { logEvent } from './services/events';
import { getUsageToday, peekPublishSlot } from './services/rateLimit';

const log = logger.child({ module: 'main' });

/**
 * CLI entry point.
 *   npm run status   validate config, check DB, print safety state (default)
 *   npm run tick     run ONE scheduler cycle (what a cron call does)
 *   npm run collect  fetch + score news only, print the outcome
 * The long-running mode is `npm start` (src/worker.ts).
 */
async function status(accountId: string): Promise<void> {
  const settings = await loadSettings();
  const usage = await getUsageToday(accountId);
  const postGate = await peekPublishSlot(accountId, 'post');
  const replyGate = await peekPublishSlot(accountId, 'reply');

  await logEvent({
    action: 'SYSTEM',
    decision: 'STATUS',
    result: 'ok',
    details: { usage, postGate, replyGate, dryRun: config.flags.dryRun },
  });

  log.info('status', {
    botStatus: settings.botStatus,
    dryRun: config.flags.dryRun,
    autonomousMode: config.flags.autonomousMode,
    postsToday: `${usage.postsToday}/${config.limits.maxPostsPerDay}`,
    repliesToday: `${usage.repliesToday}/${config.limits.maxRepliesPerDay}`,
    postGate,
    replyGate,
    llmConfigured: Boolean(config.llm.provider && config.llm.apiKey && config.llm.model),
  });
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'status';
  log.info('starting crypto-x-agent', {
    cmd,
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

  switch (cmd) {
    case 'status':
      return status(accountId);
    case 'tick': {
      const report = await runTick(createDeps(accountId));
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    case 'collect': {
      const deps = createDeps(accountId);
      console.log(JSON.stringify(await collectNews(accountId, deps.fetchText), null, 2));
      return;
    }
    default:
      log.error('unknown command', { cmd, expected: 'status | tick | collect' });
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    log.error('fatal', { err });
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => undefined));
