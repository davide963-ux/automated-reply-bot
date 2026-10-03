import { query } from '../db/client';
import { logger } from '../lib/logger';
import { logEvent } from '../services/events';
import { peekPublishSlot, releasePublishSlot, reservePublishSlot, type PublishKind } from '../services/rateLimit';
import type { SafetyReport } from '../safety/gate';
import { writeSetting } from '../config/settings';
import type { Deps } from './deps';

const log = logger.child({ module: 'publisher' });

export type Table = 'posts' | 'replies';
const TABLE: Record<PublishKind, Table> = { post: 'posts', reply: 'replies' };

export type PublishResult =
  | { status: 'PUBLISHED'; xId: string }
  | { status: 'DRY_RUN' }
  | { status: 'PENDING_APPROVAL' }
  | { status: 'BLOCKED'; reason: string }
  | { status: 'FAILED'; reason: string }
  | { status: 'REJECTED'; reason: string }
  | { status: 'UNCERTAIN'; reason: string }
  | { status: 'SKIPPED'; reason: string };

interface Row {
  id: string;
  content: string;
  status: string;
  parent_x_post_id?: string | null;
  conversation_id?: string | null;
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

async function setStatus(kind: PublishKind, id: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const cols = Object.keys(extra);
  const sets = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
  await query(`update ${TABLE[kind]} set status = $2, updated_at = now()${sets ? ', ' + sets : ''} where id = $1`, [
    id,
    status,
    ...cols.map((c) => extra[c]),
  ]);
}

function actionOf(kind: PublishKind) {
  return kind === 'post' ? ('POST_PUBLISHED' as const) : ('REPLY_PUBLISHED' as const);
}

/**
 * After a draft PASSED the safety gate, decide what happens to it:
 *   DRY_RUN                    -> status DRY_RUN, log "WOULD POST"
 *   not autonomous / MEDIUM    -> PENDING_APPROVAL (human decides)
 *   autonomous + LOW risk      -> publish now
 */
export async function routeAfterSafety(deps: Deps, kind: PublishKind, id: string, report: SafetyReport): Promise<PublishResult> {
  await query(`update ${TABLE[kind]} set safety_report = $2, risk_level = $3 where id = $1`, [
    id,
    JSON.stringify(report),
    report.riskLevel,
  ]);

  if (deps.flags.dryRun) {
    const gate = await peekPublishSlot(deps.accountId, kind);
    await setStatus(kind, id, 'DRY_RUN');
    await logEvent({
      action: actionOf(kind),
      inputRef: id,
      decision: 'WOULD_PUBLISH',
      reason: report.reason,
      result: `DRY_RUN (slot gate: ${gate})`,
      details: { kind },
    });
    return { status: 'DRY_RUN' };
  }

  if (!deps.flags.autonomous || report.forceApproval) {
    try {
      await setStatus(kind, id, 'PENDING_APPROVAL');
    } catch (err) {
      if (isUniqueViolation(err)) return reject(kind, id, 'a live item already exists for this conversation/parent/text');
      throw err;
    }
    await logEvent({
      action: kind === 'post' ? 'POST_GENERATED' : 'REPLY_GENERATED',
      inputRef: id,
      decision: 'QUEUED_FOR_APPROVAL',
      reason: report.forceApproval ? report.reason : 'AUTONOMOUS_MODE is off',
      result: 'PENDING_APPROVAL',
    });
    return { status: 'PENDING_APPROVAL' };
  }

  return publishRow(deps, kind, id);
}

async function reject(kind: PublishKind, id: string, reason: string): Promise<PublishResult> {
  await setStatus(kind, id, 'REJECTED', { rejection_reason: reason });
  await logEvent({ action: 'CONTENT_REJECTED', inputRef: id, decision: 'REJECTED', reason, result: kind });
  return { status: 'REJECTED', reason };
}

/**
 * Publish one DRAFT/APPROVED row. The order is what makes it safe:
 *   1. claim the row (atomic status flip -> a second worker cannot also publish it)
 *   2. reserve the daily slot in Postgres (fails closed: paused / limit / DB error)
 *   3. call X
 *   4. classify the outcome: created -> PUBLISHED | rejected -> release slot | unknown -> keep slot, UNCERTAIN
 */
export async function publishRow(deps: Deps, kind: PublishKind, id: string): Promise<PublishResult> {
  const table = TABLE[kind];
  if (deps.flags.dryRun) return { status: 'SKIPPED', reason: 'DRY_RUN: publishing is disabled' };

  const prior = (await query<{ status: string }>(`select status from ${table} where id = $1`, [id])).rows[0]?.status;
  if (prior !== 'DRAFT' && prior !== 'APPROVED') return { status: 'SKIPPED', reason: `status is ${prior ?? 'missing'}` };

  // 1. claim
  let row: Row | undefined;
  try {
    row = (
      await query<Row>(
        `update ${table} set status = 'PUBLISHING', updated_at = now()
          where id = $1 and status in ('DRAFT','APPROVED') returning *`,
        [id],
      )
    ).rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) return reject(kind, id, 'identical text is already live or in flight');
    throw err;
  }
  if (!row) return { status: 'SKIPPED', reason: 'claimed by another worker' };

  // 2. reserve the daily slot
  const reservation = await reservePublishSlot(deps.accountId, kind);
  if (!reservation.ok) {
    const reason = reservation.reason;
    await logEvent({ action: 'PUBLISH_BLOCKED', inputRef: id, decision: 'BLOCKED', reason, result: kind });
    // A human-approved item waits and is retried later; an autonomous draft is dropped.
    if (prior === 'APPROVED') await setStatus(kind, id, 'APPROVED');
    else await setStatus(kind, id, 'REJECTED', { rejection_reason: `blocked: ${reason}` });
    return { status: 'BLOCKED', reason };
  }
  await query(`update ${table} set reserved_usage_date = $2 where id = $1`, [id, reservation.usageDate]);

  // 3. publish
  let outcome;
  try {
    outcome = await deps.x.createPost(row.content, kind === 'reply' ? (row.parent_x_post_id ?? undefined) : undefined);
  } catch (err) {
    // Unexpected exception while talking to X: we cannot know whether it was created.
    outcome = { kind: 'unknown' as const, reason: `exception: ${(err as Error).message}` };
  }

  // 4. classify
  if (outcome.kind === 'created') {
    await setStatus(kind, id, 'PUBLISHED', { [kind === 'post' ? 'x_post_id' : 'x_reply_id']: outcome.id, published_at: deps.now() });
    if (kind === 'reply' && row.conversation_id) {
      await query('update conversations set last_interaction_at = now() where id = $1', [row.conversation_id]);
    }
    await logEvent({ action: actionOf(kind), inputRef: id, decision: 'PUBLISHED', result: 'ok', details: { xId: outcome.id } });
    return { status: 'PUBLISHED', xId: outcome.id };
  }

  if (outcome.kind === 'rejected') {
    // X answered with a 4xx: nothing was created, so the slot goes back.
    await releasePublishSlot(deps.accountId, reservation);
    if (outcome.duplicate) {
      await setStatus(kind, id, 'REJECTED', { rejection_reason: 'X rejected it as duplicate content', publish_error: outcome.reason });
    } else {
      await setStatus(kind, id, 'FAILED', { publish_error: outcome.reason });
    }
    await logEvent({ action: 'ERROR', inputRef: id, decision: 'X_REJECTED', reason: outcome.reason, result: kind });
    if (outcome.authFailure) await autoPause('X authorization failed (401)');
    return { status: 'FAILED', reason: outcome.reason };
  }

  // unknown: KEEP the slot, never blind-retry; reconcile.ts resolves it.
  await setStatus(kind, id, 'UNCERTAIN', { publish_error: outcome.reason });
  await logEvent({ action: 'ERROR', inputRef: id, decision: 'PUBLISH_UNCERTAIN', reason: outcome.reason, result: `${kind}: slot kept, will reconcile` });
  return { status: 'UNCERTAIN', reason: outcome.reason };
}

/** Safety stop: when something looks structurally wrong, stop publishing and tell a human. */
export async function autoPause(reason: string): Promise<void> {
  await writeSetting('bot_status', 'PAUSED');
  await logEvent({ action: 'BOT_PAUSED', decision: 'AUTO_PAUSE', reason, result: 'paused' });
  log.error('bot auto-paused', { reason });
}
