import { query } from '../db/client';
import { loadSettings, writeSetting } from '../config/settings';
import { contentHash } from '../lib/text';
import { loadRecentTexts, runSafetyGate } from '../safety/gate';
import { logEvent } from '../services/events';
import type { PublishKind } from '../services/rateLimit';
import type { Deps } from './deps';
import { publishRow, type PublishResult } from './publisher';

const TABLE: Record<PublishKind, 'posts' | 'replies'> = { post: 'posts', reply: 'replies' };

export async function pauseBot(by: string, reason = 'manual'): Promise<void> {
  await writeSetting('bot_status', 'PAUSED');
  await logEvent({ action: 'BOT_PAUSED', decision: 'PAUSED', reason, result: by });
}

export async function resumeBot(by: string): Promise<void> {
  await writeSetting('bot_status', 'RUNNING');
  await logEvent({ action: 'BOT_RESUMED', decision: 'RUNNING', result: by });
}

/** Material the text must be grounded in, rebuilt from the database (used when a human edits a draft). */
async function loadMaterial(kind: PublishKind, id: string): Promise<{ material: string; context: string[] }> {
  if (kind === 'post') {
    const r = (
      await query<{ title: string | null; summary: string | null; name: string | null }>(
        `select n.title, n.summary, s.name from posts p left join news_items n on n.id = p.news_item_id
           left join sources s on s.id = n.source_id where p.id = $1`,
        [id],
      )
    ).rows[0];
    return { material: `${r?.title ?? ''}\n${r?.summary ?? ''}\nSource: ${r?.name ?? ''}`, context: [] };
  }
  const r = (await query<{ parent_text: string | null }>('select parent_text from replies where id = $1', [id])).rows[0];
  return { material: r?.parent_text ?? '', context: [r?.parent_text ?? ''] };
}

export type ApproveResult = { ok: true; publish: PublishResult } | { ok: false; error: string };

/**
 * Human approval. An edited text goes through the FULL safety gate again, so a
 * human cannot accidentally push an unsafe or duplicate text. The daily slot
 * is still reserved by publishRow(), approval never bypasses the limits.
 */
export async function approveItem(
  deps: Deps,
  kind: PublishKind,
  id: string,
  by: string,
  editedText?: string,
): Promise<ApproveResult> {
  const table = TABLE[kind];
  const row = (await query<{ status: string; content: string }>(`select status, content from ${table} where id = $1`, [id])).rows[0];
  if (!row) return { ok: false, error: 'not found' };
  if (row.status !== 'PENDING_APPROVAL') return { ok: false, error: `item is ${row.status}, not PENDING_APPROVAL` };

  if (editedText !== undefined && editedText.trim() !== row.content) {
    const text = editedText.trim();
    const { material, context } = await loadMaterial(kind, id);
    // Exclude the item itself from the duplicate set (it still holds the old text).
    const recent = (await loadRecentTexts(deps.accountId)).filter((t) => t !== row.content);
    const report = await runSafetyGate(deps.llm, { kind, text, material, recentTexts: recent, riskContext: context });
    if (!report.ok) return { ok: false, error: `edited text failed the safety gate (${report.stage}): ${report.reason}` };
    await query(`update ${table} set content = $2, content_hash = $3, safety_report = $4, risk_level = $5 where id = $1`, [
      id, text, contentHash(text), JSON.stringify(report), report.riskLevel,
    ]);
  }

  const moved = await query(
    `update ${table} set status = 'APPROVED', approved_by = $2, approved_at = now(), updated_at = now() where id = $1 and status = 'PENDING_APPROVAL'`,
    [id, by],
  );
  if (!moved.rowCount) return { ok: false, error: 'item changed while approving' };
  await logEvent({ action: kind === 'post' ? 'POST_GENERATED' : 'REPLY_GENERATED', inputRef: id, decision: 'APPROVED', result: by, details: { edited: editedText !== undefined } });

  return { ok: true, publish: await publishRow(deps, kind, id) };
}

export async function rejectItem(kind: PublishKind, id: string, by: string, reason = 'rejected by operator'): Promise<boolean> {
  const r = await query(
    `update ${TABLE[kind]} set status = 'REJECTED', rejection_reason = $2, updated_at = now()
      where id = $1 and status in ('PENDING_APPROVAL','APPROVED','DRAFT')`,
    [id, reason.slice(0, 300)],
  );
  if (r.rowCount) await logEvent({ action: 'CONTENT_REJECTED', inputRef: id, decision: 'REJECTED_BY_HUMAN', reason, result: by });
  return Boolean(r.rowCount);
}

/** Queue items older than approval_ttl_hours are news that went stale: drop them. */
export async function expireStaleApprovals(): Promise<number> {
  const s = await loadSettings();
  let n = 0;
  for (const table of ['posts', 'replies'] as const) {
    const r = await query(
      `update ${table} set status = 'REJECTED', rejection_reason = 'expired in approval queue', updated_at = now()
        where status = 'PENDING_APPROVAL' and created_at < now() - make_interval(hours => $1)`,
      [s.approvalTtlHours],
    );
    n += r.rowCount ?? 0;
  }
  if (n) await logEvent({ action: 'SYSTEM', decision: 'APPROVALS_EXPIRED', result: String(n) });
  return n;
}

/** Human-approved items that were blocked (limit reached, bot paused) are retried when a slot is free. */
export async function publishApprovedQueue(deps: Deps): Promise<number> {
  let published = 0;
  for (const kind of ['post', 'reply'] as const) {
    const { rows } = await query<{ id: string }>(`select id from ${TABLE[kind]} where account_id = $1 and status = 'APPROVED' order by approved_at limit 3`, [deps.accountId]);
    for (const r of rows) {
      const res = await publishRow(deps, kind, r.id);
      if (res.status === 'PUBLISHED') published++;
      if (res.status === 'BLOCKED') break; // same reason will block the rest
    }
  }
  return published;
}
