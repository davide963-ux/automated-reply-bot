import { query } from '../db/client';
import { logger } from '../lib/logger';
import { normalize } from '../lib/text';
import { logEvent } from '../services/events';
import { releasePublishSlot, type PublishKind } from '../services/rateLimit';
import { XAuthError, XBudgetError, XRateLimitError } from '../x/types';
import type { Deps } from './deps';
import { ensureXIdentity } from './ingest';

const log = logger.child({ module: 'reconcile' });

/** Wait this long before concluding "X never created it" (timeline lag, retries in flight). */
const GIVE_UP_AFTER_MIN = 15;
/** A row stuck in PUBLISHING longer than this means the worker died mid-call. */
const STUCK_PUBLISHING_MIN = 5;

interface PendingRow {
  id: string;
  kind: PublishKind;
  content: string;
  reserved_usage_date: string | null;
  age_min: string;
}

/**
 * Resolves UNCERTAIN publishes (timeout / 5xx / crash) WITHOUT ever re-sending:
 *   found on our timeline   -> PUBLISHED
 *   not found after 15 min  -> FAILED + the daily slot is given back
 *   not decidable yet       -> left alone
 */
export async function reconcileUncertain(deps: Deps): Promise<{ checked: number; published: number; failed: number }> {
  const out = { checked: 0, published: 0, failed: 0 };
  const { rows } = await query<PendingRow>(
    `select id, 'post' as kind, content, reserved_usage_date::text, (extract(epoch from now() - updated_at)/60)::text as age_min
       from posts where account_id = $1 and (status = 'UNCERTAIN' or (status = 'PUBLISHING' and updated_at < now() - make_interval(mins => $2)))
     union all
     select id, 'reply' as kind, content, reserved_usage_date::text, (extract(epoch from now() - updated_at)/60)::text as age_min
       from replies where account_id = $1 and (status = 'UNCERTAIN' or (status = 'PUBLISHING' and updated_at < now() - make_interval(mins => $2)))`,
    [deps.accountId, STUCK_PUBLISHING_MIN],
  );
  if (rows.length === 0) return out;

  let timeline;
  try {
    const me = await ensureXIdentity(deps);
    if (!me) return out;
    timeline = await deps.x.getOwnRecentTweets(me.id);
  } catch (err) {
    if (!(err instanceof XRateLimitError || err instanceof XBudgetError || err instanceof XAuthError)) log.warn('reconcile lookup failed', { err });
    return out; // cannot verify right now: keep everything as is (fail closed)
  }

  for (const r of rows) {
    out.checked++;
    const want = normalize(r.content);
    const hit = timeline.find((t) => normalize(t.text) === want || (want.length > 40 && normalize(t.text).startsWith(want.slice(0, 40))));
    const table = r.kind === 'post' ? 'posts' : 'replies';

    if (hit) {
      await query(
        `update ${table} set status = 'PUBLISHED', ${r.kind === 'post' ? 'x_post_id' : 'x_reply_id'} = $2, published_at = coalesce($3, now()),
                publish_error = null, updated_at = now() where id = $1`,
        [r.id, hit.id, hit.createdAt],
      );
      out.published++;
      await logEvent({ action: r.kind === 'post' ? 'POST_PUBLISHED' : 'REPLY_PUBLISHED', inputRef: r.id, decision: 'RECONCILED_PUBLISHED', result: 'found on timeline', details: { xId: hit.id } });
    } else if (Number(r.age_min) >= GIVE_UP_AFTER_MIN) {
      await query(`update ${table} set status = 'FAILED', publish_error = 'not found on timeline after reconciliation', updated_at = now() where id = $1`, [r.id]);
      if (r.reserved_usage_date) {
        await releasePublishSlot(deps.accountId, { ok: true, kind: r.kind, usageDate: r.reserved_usage_date });
      }
      out.failed++;
      await logEvent({ action: 'ERROR', inputRef: r.id, decision: 'RECONCILED_FAILED', reason: `not on timeline after ${GIVE_UP_AFTER_MIN} min`, result: 'slot released' });
    }
  }
  return out;
}
