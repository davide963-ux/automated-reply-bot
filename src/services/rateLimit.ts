import { query } from '../db/client';
import { config } from '../config/env';
import { logger } from '../lib/logger';

const log = logger.child({ module: 'rate-limit' });

export type PublishKind = 'post' | 'reply';
export type SlotStatus = 'OK' | 'PAUSED' | 'POST_LIMIT' | 'REPLY_LIMIT' | 'TOTAL_LIMIT';

export type Reservation =
  | { ok: true; kind: PublishKind; usageDate: string }
  | { ok: false; reason: SlotStatus | 'DB_ERROR' };

/**
 * Atomically reserve a daily publish slot in the database.
 *
 * FAIL CLOSED: if the database cannot be reached the result is
 * { ok: false, reason: 'DB_ERROR' }. Callers must NOT publish in that case,
 * because duplicate/rate-limit protection cannot be guaranteed.
 *
 * Call this immediately before the X publish call, after the safety checks.
 * If X definitively rejects the request, call releasePublishSlot(). If the
 * outcome is unknown (timeout, network drop) keep the slot reserved and mark
 * the post UNCERTAIN so it can be reconciled instead of being re-sent blindly.
 */
export async function reservePublishSlot(accountId: string, kind: PublishKind): Promise<Reservation> {
  try {
    const { rows } = await query<{ result: { status: SlotStatus; usage_date: string } }>(
      'select reserve_publish_slot($1, $2, $3) as result',
      [accountId, kind, config.timezone],
    );
    const result = rows[0]?.result;
    if (!result) return { ok: false, reason: 'DB_ERROR' };
    if (result.status !== 'OK') {
      log.warn('publish slot refused', { kind, status: result.status });
      return { ok: false, reason: result.status };
    }
    return { ok: true, kind, usageDate: result.usage_date };
  } catch (err) {
    log.error('reservePublishSlot failed, refusing to publish', { kind, err });
    return { ok: false, reason: 'DB_ERROR' };
  }
}

/** Read-only check (used by DRY_RUN and the dashboard). Also fails closed. */
export async function peekPublishSlot(accountId: string, kind: PublishKind): Promise<SlotStatus | 'DB_ERROR'> {
  try {
    const { rows } = await query<{ status: SlotStatus }>(
      'select publish_slot_status($1, $2, $3) as status',
      [accountId, kind, config.timezone],
    );
    return rows[0]?.status ?? 'DB_ERROR';
  } catch (err) {
    log.error('peekPublishSlot failed', { kind, err });
    return 'DB_ERROR';
  }
}

/** Give a slot back. ONLY when X definitively did not create the post/reply. */
export async function releasePublishSlot(accountId: string, reservation: Extract<Reservation, { ok: true }>): Promise<void> {
  try {
    await query('select release_publish_slot($1, $2, $3::date)', [
      accountId,
      reservation.kind,
      reservation.usageDate,
    ]);
  } catch (err) {
    // Worst case the slot stays consumed: conservative, never over-publishes.
    log.error('releasePublishSlot failed (slot stays consumed)', { err });
  }
}

// ---------------------------------------------------------------------------
// Usage and cost tracking
// ---------------------------------------------------------------------------

export type UsageMetric = 'x_api_requests' | 'llm_requests' | 'news_requests';

// Whitelist: column names are never taken from caller input.
const COST_COLUMN: Record<UsageMetric, string> = {
  x_api_requests: 'estimated_x_cost',
  llm_requests: 'estimated_llm_cost',
  news_requests: 'estimated_news_cost',
};

export async function recordUsage(
  accountId: string,
  metric: UsageMetric,
  requests = 1,
  estimatedCostUsd = 0,
): Promise<void> {
  const costCol = COST_COLUMN[metric];
  try {
    await query(
      `insert into daily_usage (account_id, usage_date, ${metric}, ${costCol})
       values ($1, (now() at time zone $2)::date, $3, $4)
       on conflict (account_id, usage_date) do update
         set ${metric} = daily_usage.${metric} + excluded.${metric},
             ${costCol} = daily_usage.${costCol} + excluded.${costCol},
             updated_at = now()`,
      [accountId, config.timezone, requests, estimatedCostUsd],
    );
  } catch (err) {
    log.error('recordUsage failed', { metric, err });
  }
}

export interface UsageToday {
  postsToday: number;
  repliesToday: number;
  xApiRequests: number;
  llmRequests: number;
  newsRequests: number;
  estimatedXCost: number;
  estimatedLlmCost: number;
  estimatedNewsCost: number;
}

export async function getUsageToday(accountId: string): Promise<UsageToday> {
  const { rows } = await query<Record<string, string | number>>(
    `select posts_count, replies_count, x_api_requests, llm_requests, news_requests,
            estimated_x_cost, estimated_llm_cost, estimated_news_cost
       from daily_usage
      where account_id = $1 and usage_date = (now() at time zone $2)::date`,
    [accountId, config.timezone],
  );
  const r = rows[0];
  return {
    postsToday: Number(r?.posts_count ?? 0),
    repliesToday: Number(r?.replies_count ?? 0),
    xApiRequests: Number(r?.x_api_requests ?? 0),
    llmRequests: Number(r?.llm_requests ?? 0),
    newsRequests: Number(r?.news_requests ?? 0),
    estimatedXCost: Number(r?.estimated_x_cost ?? 0),
    estimatedLlmCost: Number(r?.estimated_llm_cost ?? 0),
    estimatedNewsCost: Number(r?.estimated_news_cost ?? 0),
  };
}

/**
 * True when the configured daily spend cap for that provider is reached.
 * Non-essential work (extra searches, extra generations) should stop when true.
 * On DB error returns true (stop spending when we cannot measure spend).
 */
export async function isBudgetExceeded(accountId: string, provider: 'x' | 'llm'): Promise<boolean> {
  try {
    const u = await getUsageToday(accountId);
    return provider === 'x'
      ? u.estimatedXCost >= config.budget.maxXDailySpend
      : u.estimatedLlmCost >= config.budget.maxLlmDailySpend;
  } catch (err) {
    log.error('isBudgetExceeded failed, assuming exceeded', { err });
    return true;
  }
}
