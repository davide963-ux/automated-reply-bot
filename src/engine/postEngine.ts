import { query } from '../db/client';
import { getState, setState } from '../db/state';
import type { Settings } from '../config/settings';
import { generatePost, type PostType } from '../llm/content';
import { LlmUnavailableError } from '../llm/client';
import { logger } from '../lib/logger';
import { contentHash, sha256, tweetLength } from '../lib/text';
import { activeMinutesPerDay, isWithinActiveHours } from '../lib/time';
import { config } from '../config/env';
import { loadRecentTexts, runSafetyGate } from '../safety/gate';
import { logEvent } from '../services/events';
import { peekPublishSlot } from '../services/rateLimit';
import type { Deps } from './deps';
import { routeAfterSafety, type PublishResult } from './publisher';

const log = logger.child({ module: 'post-engine' });

const NEXT_POST_KEY = 'next_post_not_before';
const MAX_ATTEMPTS_PER_TICK = 3;
const LINK_RESERVE = 24; // "\n" + a 23-char t.co link

export type PostEngineResult =
  | { outcome: 'idle'; reason: string }
  | { outcome: 'posted'; result: PublishResult; postId: string };

/** Posts created today (account timezone) that count against the daily post cap, including queued/dry-run ones. */
export async function committedToday(accountId: string, table: 'posts' | 'replies'): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `select count(*)::text as n from ${table}
      where account_id = $1
        and status in ('PENDING_APPROVAL','APPROVED','PUBLISHING','PUBLISHED','UNCERTAIN','DRY_RUN')
        and (created_at at time zone $2)::date = (now() at time zone $2)::date`,
    [accountId, config.timezone],
  );
  return Number(rows[0]?.n ?? 0);
}

export function pickPostType(args: {
  confidence: number;
  importance: number;
  breakingThreshold: number;
  professionalRatio: number;
  recentTypes: string[];
  random: number;
}): PostType {
  if (args.confidence >= args.breakingThreshold && args.importance >= 0.7) return 'breaking';
  const mix = args.recentTypes.filter((t) => t === 'professional' || t === 'degen');
  if (mix.length >= 4) {
    const share = mix.filter((t) => t === 'professional').length / mix.length;
    if (share > args.professionalRatio + 0.15) return 'degen';
    if (share < args.professionalRatio - 0.15) return 'professional';
  }
  return args.random < args.professionalRatio ? 'professional' : 'degen';
}

/** Next-post time: spread posts over the active window, with jitter, never closer than min_gap. */
export function computeNextPostGapMinutes(s: Settings, random: number): number {
  const perDay = Math.max(1, Math.min(s.maxPostsPerDay, s.maxTotalPerDay));
  const even = (activeMinutesPerDay(s.activeHours) / perDay) * 0.9;
  const base = Math.max(s.minGapMinutes, even);
  return Math.max(s.minGapMinutes, base * (0.9 + 0.4 * random));
}

function cleanText(t: string): string {
  return t
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function runPostEngine(deps: Deps, s: Settings): Promise<PostEngineResult> {
  const now = deps.now();
  const idle = (reason: string): PostEngineResult => ({ outcome: 'idle', reason });

  if (s.botStatus !== 'RUNNING') return idle('bot is PAUSED');
  if (!isWithinActiveHours(now, s.activeHours, config.timezone)) return idle('outside active hours');

  const notBefore = await getState<string>(NEXT_POST_KEY);
  if (notBefore && new Date(notBefore).getTime() > now.getTime()) return idle(`waiting until ${notBefore}`);

  const slot = await peekPublishSlot(deps.accountId, 'post');
  if (slot !== 'OK') return idle(`slot gate: ${slot}`);
  const limit = Math.min(s.maxPostsPerDay, s.maxTotalPerDay);
  if ((await committedToday(deps.accountId, 'posts')) >= limit) return idle('daily post budget used (incl. queued/dry-run)');

  // Last post of any live kind enforces the minimum gap even if next_post_not_before was reset.
  const last = (
    await query<{ t: Date }>(
      `select max(created_at) as t from posts where account_id = $1
        and status in ('PENDING_APPROVAL','APPROVED','PUBLISHING','PUBLISHED','UNCERTAIN','DRY_RUN')`,
      [deps.accountId],
    )
  ).rows[0]?.t;
  if (last && now.getTime() - last.getTime() < s.minGapMinutes * 60_000) return idle('min gap since last post');

  const { rows: candidates } = await query<{
    id: string; title: string; summary: string | null; url: string; topic: string | null;
    confidence: string; importance_score: string; source_name: string | null;
  }>(
    `select n.id, n.title, n.summary, n.url, n.topic, n.confidence::text, n.importance_score::text, s.name as source_name
       from news_items n left join sources s on s.id = n.source_id
      where n.decision = 'POST' and not exists (select 1 from posts p where p.news_item_id = n.id)
      order by n.confidence desc, n.published_at desc nulls last
      limit 8`,
  );
  if (candidates.length === 0) return idle('no eligible news');

  const recentPosts = (
    await query<{ content: string; content_type: string; topic: string | null; created_at: Date }>(
      `select content, content_type, topic, created_at from posts
        where account_id = $1 and status not in ('REJECTED','FAILED') order by created_at desc limit 12`,
      [deps.accountId],
    )
  ).rows;
  const recentTexts = await loadRecentTexts(deps.accountId);

  let attempts = 0;
  for (const n of candidates) {
    if (attempts >= MAX_ATTEMPTS_PER_TICK) break;
    const confidence = Number(n.confidence);
    const importance = Number(n.importance_score);
    const type = pickPostType({
      confidence, importance, breakingThreshold: s.breakingThreshold, professionalRatio: s.professionalRatio,
      recentTypes: recentPosts.map((p) => p.content_type), random: deps.random(),
    });

    // Topic cool-down: no two posts on the same topic within 3h (breaking news is exempt).
    if (type !== 'breaking' && n.topic && n.topic !== 'general') {
      const clash = recentPosts.find((p) => p.topic === n.topic && now.getTime() - p.created_at.getTime() < 3 * 3_600_000);
      if (clash) continue;
    }

    attempts++;
    const withLink = s.includeSourceLink;
    const maxChars = 270 - (withLink ? LINK_RESERVE : 0);

    let draft;
    try {
      draft = await generatePost(deps.llm, {
        personality: s.personality,
        type,
        news: { title: n.title, summary: n.summary ?? '', source: n.source_name ?? 'unknown' },
        recentPosts: recentPosts.map((p) => p.content),
        maxChars,
      });
    } catch (err) {
      log.warn('generation failed, will retry next tick', { err: err instanceof LlmUnavailableError ? err.message : err });
      await logEvent({ action: 'ERROR', inputRef: n.id, decision: 'GENERATION_FAILED', reason: (err as Error).message, result: 'retry later' });
      return idle('LLM unavailable');
    }

    if (draft.action === 'SKIP' || !draft.text) {
      await query(`update news_items set decision = 'IGNORE', decision_reason = $2 where id = $1`, [n.id, `llm skip: ${draft.reason}`.slice(0, 300)]);
      await logEvent({ action: 'NEWS_REJECTED', inputRef: n.id, decision: 'IGNORE', reason: draft.reason, result: 'model chose SKIP' });
      continue;
    }

    const bare = cleanText(draft.text);
    const material = `${n.title}\n${n.summary ?? ''}\nSource: ${n.source_name ?? ''}`;
    const gateReport = await runSafetyGate(deps.llm, { kind: 'post', text: bare, material, recentTexts });

    // Link is appended AFTER the gate (digits inside URLs must not trip the fact check).
    let content = bare;
    if (withLink && gateReport.ok) {
      const candidate = `${bare}\n${n.url}`;
      if (tweetLength(candidate) <= 280 && candidate.length <= 280) content = candidate;
    }

    if (!gateReport.ok && gateReport.retryable) {
      await logEvent({ action: 'ERROR', inputRef: n.id, decision: 'GATE_RETRYABLE', reason: gateReport.reason, result: 'retry later' });
      return idle('safety judge unavailable');
    }

    const inserted = await query<{ id: string }>(
      `insert into posts (account_id, content, content_type, topic, sources, news_item_id, content_hash, idempotency_key, status, rejection_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (idempotency_key) do nothing returning id`,
      [
        deps.accountId, content, type, n.topic, JSON.stringify([n.url]), n.id, contentHash(content),
        sha256(`${deps.accountId}|post|${n.id}`),
        gateReport.ok ? 'DRAFT' : 'REJECTED',
        gateReport.ok ? null : `${gateReport.stage}: ${gateReport.reason}`.slice(0, 500),
      ],
    );
    const postId = inserted.rows[0]?.id;
    if (!postId) continue; // this news item already produced a post (race)

    if (!gateReport.ok) {
      await query('update posts set safety_report = $2, risk_level = $3 where id = $1', [postId, JSON.stringify(gateReport), gateReport.riskLevel]);
      await logEvent({
        action: 'CONTENT_REJECTED', inputRef: postId, decision: gateReport.stage, reason: gateReport.reason,
        result: 'post rejected by safety gate', details: { checks: gateReport.checks, news: n.url },
      });
      continue;
    }

    await logEvent({
      action: 'POST_GENERATED', inputRef: postId, decision: type, reason: draft.reason, confidence,
      result: 'passed safety gate', details: { news: n.url },
    });

    const result = await routeAfterSafety(deps, 'post', postId, gateReport);
    if (['PUBLISHED', 'DRY_RUN', 'PENDING_APPROVAL', 'UNCERTAIN'].includes(result.status)) {
      const gapMin = computeNextPostGapMinutes(s, deps.random());
      await setState(NEXT_POST_KEY, new Date(now.getTime() + gapMin * 60_000).toISOString());
    }
    return { outcome: 'posted', result, postId };
  }

  return idle('no candidate passed generation and the safety gate');
}

