import { config } from '../config/env';
import { query } from '../db/client';
import type { Settings } from '../config/settings';
import { decideReply } from '../llm/content';
import { LlmUnavailableError } from '../llm/client';
import { logger } from '../lib/logger';
import { contentHash, sha256 } from '../lib/text';
import { isWithinActiveHours } from '../lib/time';
import { loadRecentTexts, runSafetyGate } from '../safety/gate';
import { logEvent } from '../services/events';
import { peekPublishSlot } from '../services/rateLimit';
import type { Deps } from './deps';
import { routeAfterSafety, type PublishResult } from './publisher';
import { committedToday } from './postEngine';

const log = logger.child({ module: 'reply-engine' });

const MAX_EVALUATIONS_PER_TICK = 4;
const MAX_REPLY_CHARS = 270;

interface SeenRow {
  x_post_id: string;
  x_conversation_id: string;
  author_id: string;
  author_username: string | null;
  text: string;
  created_at_x: Date | null;
  source: 'mention' | 'reply_to_us' | 'tracked_account' | 'keyword_search';
}

export type ReplyEngineResult =
  | { outcome: 'idle'; reason: string }
  | { outcome: 'replied'; result: PublishResult; replyId: string };

const INTERACTION: Record<SeenRow['source'], string> = {
  mention: 'mention',
  reply_to_us: 'reply_to_us',
  tracked_account: 'tracked_account',
  keyword_search: 'keyword_search',
};

/** Pure pre-filter: does this tweet deserve an LLM call at all? Returns a skip reason, or null. */
export function prefilterTweet(t: Pick<SeenRow, 'text' | 'created_at_x' | 'source'>, now: Date): string | null {
  const bare = t.text.replace(/https?:\/\/\S+/g, '').replace(/(^|\s)@\w+/g, '').replace(/\s+/g, ' ').trim();
  if (bare.length < 8) return 'too short / no real content';
  const solicited = t.source === 'mention' || t.source === 'reply_to_us';
  const maxAgeH = solicited ? 24 : 3;
  if (t.created_at_x && now.getTime() - t.created_at_x.getTime() > maxAgeH * 3_600_000) return `older than ${maxAgeH}h`;
  if (/\b(giveaway|airdrop|dm me|follow back|f4f|100x|gem alert|presale)\b/i.test(t.text)) return 'spam/shill keywords';
  if ((t.text.match(/#\w+/g) ?? []).length > 3) return 'hashtag spam';
  return null;
}

async function markSeen(id: string, status: 'REPLIED' | 'IGNORED' | 'SKIPPED', reason: string): Promise<void> {
  await query('update x_tweets_seen set status = $2, decision_reason = $3 where x_post_id = $1', [id, status, reason.slice(0, 300)]);
}

/** `deadlineMs` (epoch ms): once passed, no NEW tweet is evaluated; the rest stay NEW for the next tick. */
export async function runReplyEngine(deps: Deps, s: Settings, deadlineMs?: number): Promise<ReplyEngineResult> {
  const now = deps.now();
  const idle = (reason: string): ReplyEngineResult => ({ outcome: 'idle', reason });

  if (s.botStatus !== 'RUNNING') return idle('bot is PAUSED');
  if (!s.replyEnabled) return idle('replies disabled');
  if (!isWithinActiveHours(now, s.activeHours, config.timezone)) return idle('outside active hours');

  const slot = await peekPublishSlot(deps.accountId, 'reply');
  if (slot !== 'OK') return idle(`slot gate: ${slot}`);
  const limit = Math.min(s.maxRepliesPerDay, s.maxTotalPerDay);
  if ((await committedToday(deps.accountId, 'replies')) >= limit) return idle('daily reply budget used (incl. queued/dry-run)');

  const last = (
    await query<{ t: Date }>(
      `select max(created_at) as t from replies where account_id = $1
        and status in ('PENDING_APPROVAL','APPROVED','PUBLISHING','PUBLISHED','UNCERTAIN','DRY_RUN')`,
      [deps.accountId],
    )
  ).rows[0]?.t;
  if (last && now.getTime() - last.getTime() < s.minReplyGapMinutes * 60_000) return idle('min gap since last reply');

  // People who wrote to us come first, then tracked accounts, then keyword hits. Oldest first within a class.
  const { rows: queue } = await query<SeenRow>(
    `select x_post_id, x_conversation_id, author_id, author_username, text, created_at_x, source
       from x_tweets_seen
      where account_id = $1 and status = 'NEW'
      order by case source when 'reply_to_us' then 0 when 'mention' then 1 when 'tracked_account' then 2 else 3 end,
               created_at_x asc nulls last
      limit 25`,
    [deps.accountId],
  );
  if (queue.length === 0) return idle('nothing to evaluate');

  const recentTexts = await loadRecentTexts(deps.accountId);
  let evaluations = 0;

  for (const t of queue) {
    const solicited = t.source === 'mention' || t.source === 'reply_to_us';

    const pre = prefilterTweet(t, now);
    if (pre) { await markSeen(t.x_post_id, 'SKIPPED', pre); continue; }

    // ---- guards that need the database ----
    const perUser = Number(
      (await query<{ n: string }>(
        `select count(*)::text as n from replies
          where account_id = $1 and target_user_id = $2 and status in ('PENDING_APPROVAL','APPROVED','PUBLISHING','PUBLISHED','UNCERTAIN','DRY_RUN')
            and (created_at at time zone $3)::date = (now() at time zone $3)::date`,
        [deps.accountId, t.author_id, config.timezone],
      )).rows[0]?.n ?? 0,
    );
    if (perUser >= s.maxRepliesPerUserPerDay) { await markSeen(t.x_post_id, 'SKIPPED', 'per-user daily reply cap'); continue; }

    const conv = (
      await query<{ id: string; n: string; unsolicited: string }>(
        `select c.id,
                (select count(*) from replies r where r.conversation_id = c.id and r.status in ('PENDING_APPROVAL','APPROVED','PUBLISHING','PUBLISHED','UNCERTAIN','DRY_RUN'))::text as n,
                (select count(*) from replies r where r.conversation_id = c.id and r.is_unsolicited and r.status in ('PENDING_APPROVAL','APPROVED','PUBLISHING','PUBLISHED','UNCERTAIN','DRY_RUN'))::text as unsolicited
           from conversations c where c.account_id = $1 and c.x_conversation_id = $2`,
        [deps.accountId, t.x_conversation_id],
      )
    ).rows[0];
    if (conv && Number(conv.n) >= s.maxBotRepliesPerConversation) { await markSeen(t.x_post_id, 'SKIPPED', 'conversation reply cap'); continue; }
    if (conv && !solicited && Number(conv.unsolicited) >= 1) { await markSeen(t.x_post_id, 'SKIPPED', 'already replied unsolicited in this conversation'); continue; }

    const dupParent = (await query('select 1 from replies where account_id = $1 and parent_x_post_id = $2 and status not in (\'REJECTED\',\'FAILED\')', [deps.accountId, t.x_post_id])).rows.length;
    if (dupParent) { await markSeen(t.x_post_id, 'SKIPPED', 'already replied to this tweet'); continue; }

    if (evaluations >= MAX_EVALUATIONS_PER_TICK) break;
    if (deadlineMs !== undefined && Date.now() > deadlineMs) return idle('time budget reached, continuing next tick');
    evaluations++;

    // ---- conversation memory ----
    const convId = (
      await query<{ id: string }>(
        `insert into conversations (account_id, x_conversation_id, root_x_post_id, root_author_id, interaction_type)
         values ($1,$2,$3,$4,$5)
         on conflict (account_id, x_conversation_id) do update set last_interaction_at = now()
         returning id`,
        [deps.accountId, t.x_conversation_id, t.x_conversation_id, t.author_id, INTERACTION[t.source]],
      )
    ).rows[0]!.id;

    const theirs = (
      await query<{ text: string; created_at_x: Date | null }>(
        `select text, created_at_x from x_tweets_seen where account_id = $1 and x_conversation_id = $2 and x_post_id <> $3
          order by created_at_x desc nulls last limit 3`,
        [deps.accountId, t.x_conversation_id, t.x_post_id],
      )
    ).rows;
    const ours = (
      await query<{ content: string }>(
        `select content from replies where conversation_id = $1 and status in ('PUBLISHED','PENDING_APPROVAL','APPROVED','DRY_RUN') order by created_at desc limit 3`,
        [convId],
      )
    ).rows;
    const history = [
      ...theirs.reverse().map((x) => ({ who: 'them' as const, text: x.text })),
      ...ours.reverse().map((x) => ({ who: 'us' as const, text: x.content })),
    ];

    // ---- decision + draft (one LLM call) ----
    let d;
    try {
      d = await decideReply(deps.llm, {
        personality: s.personality,
        tweet: { author: t.author_username ?? 'user', text: t.text },
        solicited,
        history,
        maxChars: MAX_REPLY_CHARS,
        scope: s.replyScope,
      });
    } catch (err) {
      log.warn('reply decision failed, will retry next tick', { err: err instanceof LlmUnavailableError ? err.message : err });
      await logEvent({ action: 'ERROR', inputRef: t.x_post_id, decision: 'REPLY_DECISION_FAILED', reason: (err as Error).message, result: 'retry later' });
      return idle('LLM unavailable');
    }

    await query('update conversations set topic = coalesce($2, topic), sentiment = coalesce($3, sentiment), last_interaction_at = now() where id = $1', [
      convId, d.topic ?? null, d.sentiment ?? null,
    ]);

    if (d.decision === 'IGNORE' || d.confidence < s.minConfidence || !d.text) {
      const why = d.decision === 'IGNORE' ? d.reason : `confidence ${d.confidence} < ${s.minConfidence}`;
      await markSeen(t.x_post_id, 'IGNORED', why);
      await logEvent({ action: 'REPLY_GENERATED', inputRef: t.x_post_id, decision: 'IGNORE', reason: why, confidence: d.confidence, result: 'no reply' });
      continue;
    }

    const text = d.text.replace(/^(@\w+\s+)+/, '').trim(); // X adds the @mention itself for replies
    const material = [...history.map((h) => h.text), t.text].join('\n');
    const report = await runSafetyGate(deps.llm, { kind: 'reply', text, material, recentTexts, riskContext: [t.text] });

    if (!report.ok && report.retryable) {
      await logEvent({ action: 'ERROR', inputRef: t.x_post_id, decision: 'GATE_RETRYABLE', reason: report.reason, result: 'retry later' });
      return idle('safety judge unavailable');
    }

    const inserted = await query<{ id: string }>(
      `insert into replies (account_id, parent_x_post_id, parent_text, conversation_id, target_user_id, content, content_hash,
                            reason_for_reply, decision_confidence, reply_style, is_unsolicited, idempotency_key, status, rejection_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       on conflict (idempotency_key) do nothing returning id`,
      [
        deps.accountId, t.x_post_id, t.text, convId, t.author_id, text, contentHash(text), d.reason, d.confidence, d.style,
        !solicited, sha256(`${deps.accountId}|reply|${t.x_post_id}`),
        report.ok ? 'DRAFT' : 'REJECTED',
        report.ok ? null : `${report.stage}: ${report.reason}`.slice(0, 500),
      ],
    );
    const replyId = inserted.rows[0]?.id;
    if (!replyId) { await markSeen(t.x_post_id, 'SKIPPED', 'reply already exists'); continue; }

    if (!report.ok) {
      await query('update replies set safety_report = $2, risk_level = $3 where id = $1', [replyId, JSON.stringify(report), report.riskLevel]);
      await markSeen(t.x_post_id, 'IGNORED', `safety: ${report.reason}`);
      await logEvent({
        action: 'CONTENT_REJECTED', inputRef: replyId, decision: report.stage, reason: report.reason,
        result: 'reply rejected by safety gate', details: { checks: report.checks },
      });
      continue;
    }

    await markSeen(t.x_post_id, 'REPLIED', d.reason);
    await logEvent({
      action: 'REPLY_GENERATED', inputRef: replyId, decision: 'REPLY', reason: d.reason, confidence: d.confidence,
      result: 'passed safety gate', details: { source: t.source, style: d.style },
    });
    const result = await routeAfterSafety(deps, 'reply', replyId, report);
    return { outcome: 'replied', result, replyId };
  }

  return idle('no tweet qualified for a reply');
}
