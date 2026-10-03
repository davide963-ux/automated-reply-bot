import { query } from '../db/client';
import { logger } from '../lib/logger';

const log = logger.child({ module: 'scheduler' });

export type JobType = 'COLLECT_NEWS' | 'POLL_X' | 'RECONCILE' | 'POST' | 'REPLY' | 'MAINTENANCE';

/** Minutes between runs. POST/REPLY also gate themselves (active hours, gaps, limits). */
export const JOB_INTERVAL_MIN: Record<JobType, number> = {
  COLLECT_NEWS: 15,
  POLL_X: 5,
  RECONCILE: 5,
  POST: 5,
  REPLY: 3,
  MAINTENANCE: 30,
};

const STALE_RUNNING_MIN = 10;

/**
 * Durable job table with exactly one PENDING/RUNNING row per job type
 * (partial unique index), claimed with FOR UPDATE SKIP LOCKED, so overlapping
 * workers (Vercel cron + a long-running worker) cannot run the same job twice.
 */
export async function runDueJobs(
  handlers: Partial<Record<JobType, () => Promise<unknown>>>,
  now: Date,
  accountId?: string,
): Promise<Array<{ job: JobType; ok: boolean; error?: string }>> {
  // A worker that died mid-job leaves RUNNING behind: release it.
  await query(
    `update scheduled_jobs set status = 'FAILED', last_error = 'stale RUNNING job released'
      where status = 'RUNNING' and locked_at < now() - make_interval(mins => $1)`,
    [STALE_RUNNING_MIN],
  );

  const results: Array<{ job: JobType; ok: boolean; error?: string }> = [];
  for (const job of Object.keys(handlers) as JobType[]) {
    const handler = handlers[job]!;
    await query(
      `insert into scheduled_jobs (account_id, job_type, run_at) values ($1, $2, $3) on conflict do nothing`,
      [accountId ?? null, job, now],
    );

    const claimed = await query<{ id: string }>(
      `update scheduled_jobs set status = 'RUNNING', locked_at = now(), attempts = attempts + 1
        where id = (select id from scheduled_jobs where job_type = $1 and status = 'PENDING' and run_at <= $2
                     order by run_at limit 1 for update skip locked)
        returning id`,
      [job, now],
    );
    const id = claimed.rows[0]?.id;
    if (!id) continue;

    let error: string | undefined;
    try {
      await handler();
    } catch (err) {
      error = (err as Error).message;
      log.error('job failed', { job, err });
    }

    await query(`update scheduled_jobs set status = $2, last_error = $3 where id = $1`, [id, error ? 'FAILED' : 'DONE', error ?? null]);
    // The finished row no longer holds the unique slot, so the next run can be queued.
    await query(
      `insert into scheduled_jobs (account_id, job_type, run_at) values ($1, $2, $3) on conflict do nothing`,
      [accountId ?? null, job, new Date(now.getTime() + JOB_INTERVAL_MIN[job] * 60_000)],
    );
    results.push({ job, ok: !error, error });
  }

  // Keep the table small.
  await query(`delete from scheduled_jobs where status in ('DONE','FAILED') and created_at < now() - interval '2 days'`);
  return results;
}
