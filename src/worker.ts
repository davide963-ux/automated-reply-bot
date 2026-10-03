import { createServer } from 'http';
import { config } from './config/env';
import { ensureAccount } from './db/accounts';
import { closePool, dbHealthy } from './db/client';
import { runMigrations } from './db/migrate';
import { createDashboardHandler } from './dashboard/handler';
import { createDeps } from './engine/deps';
import { runTick } from './engine/tick';
import { logger } from './lib/logger';
import { sleep } from './lib/http';
import { logEvent } from './services/events';

const log = logger.child({ module: 'worker' });

/**
 * Long-running mode (Railway / Render / Fly / VPS / Docker):
 *   - runs a scheduler tick every TICK_INTERVAL_SECONDS
 *   - serves the dashboard on PORT when DASHBOARD_TOKEN is set
 * Safe defaults still apply: DRY_RUN=true, AUTONOMOUS_MODE=false, bot PAUSED.
 */
async function main(): Promise<void> {
  if (config.runtime.autoMigrate) await runMigrations();
  if (!(await dbHealthy())) throw new Error('database unreachable');

  const accountId = await ensureAccount();
  const deps = createDeps(accountId);

  log.info('worker starting', {
    dryRun: deps.flags.dryRun,
    autonomous: deps.flags.autonomous,
    tickEverySeconds: config.runtime.tickIntervalSeconds,
    dashboard: Boolean(config.runtime.dashboardToken),
  });
  await logEvent({ action: 'SYSTEM', decision: 'WORKER_STARTED', result: 'ok', details: { dryRun: deps.flags.dryRun, autonomous: deps.flags.autonomous } });

  const server = config.runtime.dashboardToken
    ? createServer((req, res) => void createDashboardHandler(() => deps)(req, res)).listen(config.runtime.port, () =>
        log.info('dashboard listening', { port: config.runtime.port }),
      )
    : undefined;
  if (!server) log.warn('DASHBOARD_TOKEN not set: dashboard disabled');

  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal: sig });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (!stopping) {
    try {
      const r = await runTick(deps);
      if (r.skipped) log.debug('tick skipped', { reason: r.skipped });
    } catch (err) {
      log.error('tick crashed (continuing)', { err });
    }
    // sleep in 1s slices so SIGTERM is honoured quickly
    for (let i = 0; i < config.runtime.tickIntervalSeconds && !stopping; i++) await sleep(1000);
  }

  server?.close();
  await closePool().catch(() => undefined);
}

main().catch(async (err) => {
  log.error('fatal', { err });
  await closePool().catch(() => undefined);
  process.exit(1);
});
