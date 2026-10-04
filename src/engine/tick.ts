import { randomUUID } from 'crypto';
import { query, dbHealthy } from '../db/client';
import { setState } from '../db/state';
import { loadSettings } from '../config/settings';
import { logger } from '../lib/logger';
import { collectNews } from '../news/collector';
import { logEvent } from '../services/events';
import { expireStaleApprovals, publishApprovedQueue } from './control';
import type { Deps } from './deps';
import { pollX } from './ingest';
import { runPostEngine } from './postEngine';
import { reconcileUncertain } from './reconcile';
import { runReplyEngine } from './replyEngine';
import { runDueJobs, type JobType } from './scheduler';

const log = logger.child({ module: 'tick' });
const LOCK_NAME = 'tick';
const LOCK_TTL_SECONDS = 300;

/**
 * Wall-clock budget per tick. Vercel kills a function at 60 s (Hobby), which leaves a job RUNNING until it is
 * declared stale. So: no new job is started after START_JOBS_MS, and the POST/REPLY engines stop starting new
 * LLM work after ENGINE_MS (one evaluation can still take ~20 s). Unfinished work simply waits for the next tick.
 */
export const TICK_START_JOBS_MS = 35_000;
export const TICK_ENGINE_MS = 25_000;

export interface TickReport {
  skipped?: 'locked' | 'db_down';
  jobs: Array<{ job: JobType; ok: boolean; error?: string }>;
}

async function acquireLock(holder: string): Promise<boolean> {
  const { rows } = await query(
    `insert into locks (name, locked_until, holder) values ($1, now() + make_interval(secs => $2), $3)
     on conflict (name) do update set locked_until = excluded.locked_until, holder = excluded.holder
       where locks.locked_until < now()
     returning holder`,
    [LOCK_NAME, LOCK_TTL_SECONDS, holder],
  );
  return rows.length === 1;
}

async function releaseLock(holder: string): Promise<void> {
  await query(`update locks set locked_until = now() where name = $1 and holder = $2`, [LOCK_NAME, holder]);
}

/** Last outcome of the POST / REPLY engine, so the dashboard can say why nothing was drafted. */
async function recordEngineResult(kind: 'post' | 'reply', result: string, at: Date): Promise<void> {
  await setState(`last_${kind}_result`, { result, at: at.toISOString() }).catch((err) => log.warn('could not record engine result', { err }));
}

/**
 * One scheduler cycle. Safe to call from a loop (worker), from Vercel cron, or
 * by hand: the lock makes overlapping calls a no-op, and every job gates itself.
 *
 *   COLLECT_NEWS  fetch + score news                      (also while PAUSED if collect_while_paused)
 *   POLL_X        mentions / tracked accounts / search     (same)
 *   RECONCILE     resolve UNCERTAIN publishes               (always)
 *   POST          generate -> safety gate -> route          (only RUNNING)
 *   REPLY         decide -> draft -> safety gate -> route   (only RUNNING)
 *   MAINTENANCE   expire stale approvals, retry approved
 */
export async function runTick(deps: Deps): Promise<TickReport> {
  if (!(await dbHealthy())) {
    log.error('database unreachable: tick skipped, nothing will be published');
    return { skipped: 'db_down', jobs: [] };
  }
  const holder = randomUUID();
  if (!(await acquireLock(holder))) return { skipped: 'locked', jobs: [] };

  try {
    const settings = await loadSettings();
    const running = settings.botStatus === 'RUNNING';
    const collect = running || settings.collectWhilePaused;
    const now = deps.now();
    const startedAt = Date.now();
    const engineDeadline = startedAt + TICK_ENGINE_MS;

    const jobs = await runDueJobs(
      {
        ...(collect ? { COLLECT_NEWS: async () => void (await collectNews(deps.accountId, deps.fetchText, now)) } : {}),
        ...(collect ? { POLL_X: async () => void (await pollX(deps, settings)) } : {}),
        RECONCILE: async () => void (await reconcileUncertain(deps)),
        ...(running
          ? {
              POST: async () => {
                const r = await runPostEngine(deps, settings, engineDeadline);
                if (r.outcome === 'idle') log.debug('post engine idle', { reason: r.reason });
                await recordEngineResult('post', r.outcome === 'idle' ? r.reason : `drafted (${r.result.status})`, now);
              },
              REPLY: async () => {
                const r = await runReplyEngine(deps, settings, engineDeadline);
                if (r.outcome === 'idle') log.debug('reply engine idle', { reason: r.reason });
                await recordEngineResult('reply', r.outcome === 'idle' ? r.reason : `drafted (${r.result.status})`, now);
              },
            }
          : {}),
        MAINTENANCE: async () => {
          await expireStaleApprovals();
          if (running) await publishApprovedQueue(deps);
        },
      },
      now,
      deps.accountId,
      { shouldStop: () => Date.now() - startedAt > TICK_START_JOBS_MS },
    );

    const failed = jobs.filter((j) => !j.ok);
    if (failed.length) {
      await logEvent({ action: 'ERROR', decision: 'TICK_JOB_FAILED', reason: failed.map((f) => `${f.job}: ${f.error}`).join(' | '), result: 'continuing' });
    }
    return { jobs };
  } finally {
    await releaseLock(holder).catch((err) => log.error('failed to release tick lock', { err }));
  }
}
