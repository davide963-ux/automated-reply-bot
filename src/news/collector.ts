import { query } from '../db/client';
import { loadSettings } from '../config/settings';
import { fetchWithTimeout, readTextLimited, safeUrl } from '../lib/http';
import { logger } from '../lib/logger';
import { config } from '../config/env';
import { recordUsage } from '../services/rateLimit';
import { logEvent } from '../services/events';
import { parseFeed, type FeedItem } from './rss';
import { decideNews, isConfirmation, scoreNews, type Scores } from './scoring';
import { contentHash } from '../lib/text';

const log = logger.child({ module: 'news' });

export type FetchText = (url: string, headers?: Record<string, string>) => Promise<string>;

export const defaultFetchText: FetchText = async (url, headers) => {
  const res = await fetchWithTimeout(
    url,
    { headers: { 'user-agent': 'crypto-x-agent/0.1 (+rss reader)', accept: 'application/rss+xml, application/atom+xml, application/xml, application/json, text/xml;q=0.9, */*;q=0.5', ...headers } },
    15_000,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${safeUrl(url)}`);
  return readTextLimited(res);
};

interface SourceRow {
  id: string;
  name: string;
  kind: 'rss' | 'api' | 'x_account';
  url: string | null;
  reliability: string;
}

/** NewsAPI.org-compatible JSON ("articles": [{title, description, url, publishedAt}]). */
function parseNewsApi(json: string): FeedItem[] {
  const data = JSON.parse(json) as { articles?: Array<{ title?: string; description?: string; url?: string; publishedAt?: string }> };
  const out: FeedItem[] = [];
  for (const a of data.articles ?? []) {
    if (!a.title || !a.url || !/^https?:\/\//.test(a.url)) continue;
    const d = a.publishedAt ? new Date(a.publishedAt) : null;
    out.push({ title: a.title, url: a.url, summary: (a.description ?? '').slice(0, 1200), publishedAt: d && !Number.isNaN(d.getTime()) ? d : null });
  }
  return out;
}

export interface SourceReport {
  name: string;
  /** items found in the feed (0 from a source that answered usually means an empty or blocked feed) */
  items: number;
  newItems: number;
  error?: string;
}

export interface CollectResult {
  sourcesOk: number;
  sourcesFailed: number;
  newItems: number;
  evaluated: number;
  eligible: number;
  sources: SourceReport[];
}

/**
 * 1) fetch every enabled source (a failing source is skipped, never fatal)
 * 2) insert unseen items
 * 3) (re)score + decide every still-open item, using independent-source confirmations
 */
export async function collectNews(
  accountId: string,
  fetchText: FetchText = defaultFetchText,
  now: Date = new Date(),
): Promise<CollectResult> {
  const settings = await loadSettings();
  const { rows: sources } = await query<SourceRow>(
    `select id, name, kind, url, reliability from sources where enabled and url is not null order by name`,
  );

  const result: CollectResult = { sourcesOk: 0, sourcesFailed: 0, newItems: 0, evaluated: 0, eligible: 0, sources: [] };

  for (const src of sources) {
    try {
      let items: FeedItem[];
      if (src.kind === 'rss') {
        items = parseFeed(await fetchText(src.url!));
      } else if (src.kind === 'api' && config.news.apiKey) {
        items = parseNewsApi(await fetchText(src.url!, { 'x-api-key': config.news.apiKey }));
        await recordUsage(accountId, 'news_requests', 1, 0);
      } else {
        log.warn('source kind not supported or missing key, skipped', { source: src.name, kind: src.kind });
        continue;
      }
      result.sourcesOk++;
      // One statement per source, not one round trip per story: over a network database (Neon) from a
      // serverless function, hundreds of sequential inserts are slow and risk the function time limit.
      // ON CONFLICT DO NOTHING also tolerates duplicate URLs inside the batch.
      let added = 0;
      if (items.length > 0) {
        const ins = await query(
          `insert into news_items (source_id, url, title, summary, published_at, content_hash, source_reliability)
           select $1::uuid, x.url, x.title, x.summary, x.published_at, x.content_hash, $2::numeric
             from unnest($3::text[], $4::text[], $5::text[], $6::timestamptz[], $7::text[]) as x(url, title, summary, published_at, content_hash)
           on conflict (url) do nothing`,
          [
            src.id, src.reliability,
            items.map((i) => i.url), items.map((i) => i.title), items.map((i) => i.summary),
            items.map((i) => i.publishedAt), items.map((i) => contentHash(i.title)),
          ],
        );
        added = ins.rowCount ?? 0;
      }
      result.newItems += added;
      result.sources.push({ name: src.name, items: items.length, newItems: added });
    } catch (err) {
      result.sourcesFailed++;
      // The message names the HTTP status or timeout; it never contains secrets (URLs are logged without query strings).
      result.sources.push({ name: src.name, items: 0, newItems: 0, error: String((err as Error).message).slice(0, 160) });
      log.warn('news source failed, skipping', { source: src.name, err });
    }
  }

  const ev = await evaluateOpenNews(settings, now);
  result.evaluated = ev.evaluated;
  result.eligible = ev.eligible;

  await logEvent({
    action: 'NEWS_FOUND',
    decision: 'COLLECTED',
    result: 'ok',
    details: { ...result },
  });
  return result;
}

interface OpenRow {
  id: string;
  url: string;
  title: string;
  summary: string | null;
  published_at: Date | null;
  fetched_at: Date;
  source_reliability: string | null;
  decision: 'PENDING' | 'POST' | 'WAIT_FOR_CONFIRMATION' | 'IGNORE';
}

/** Re-score everything still open (PENDING / WAIT / unused POST) inside the freshness window. */
export async function evaluateOpenNews(
  settings: Awaited<ReturnType<typeof loadSettings>>,
  now: Date,
): Promise<{ evaluated: number; eligible: number }> {
  const windowH = Math.max(settings.newsMaxAgeHours, 24);

  await query(
    `update news_items n set decision = 'IGNORE', decision_reason = 'expired'
      where n.decision in ('PENDING','WAIT_FOR_CONFIRMATION','POST')
        and not exists (select 1 from posts p where p.news_item_id = n.id)
        and n.fetched_at <= now() - make_interval(hours => $1)`,
    [windowH],
  );

  const { rows: used } = await query<{ t: string }>(
    `select n.title as t from news_items n join posts p on p.news_item_id = n.id
      where p.status not in ('REJECTED','FAILED') and p.created_at > now() - interval '7 days'
     union all
     select content from posts where status not in ('REJECTED','FAILED') and created_at > now() - interval '7 days'`,
  );
  const usedTexts = used.map((r) => r.t);

  const { rows: open } = await query<OpenRow>(
    `select n.id, n.url, n.title, n.summary, n.published_at, n.fetched_at, n.source_reliability::text, n.decision
       from news_items n
      where (n.decision in ('PENDING','WAIT_FOR_CONFIRMATION','POST')
             -- Ignored only because of its SCORE: re-score it, so changing min_confidence (or the duplicate
             -- history) takes effect on stories already collected. Final reasons (expired, model SKIP) stay final.
             or (n.decision = 'IGNORE' and (n.decision_reason like 'confidence %'
                                            or n.decision_reason like 'low crypto relevance%'
                                            or n.decision_reason like 'duplicates%'
                                            or n.decision_reason = 'too old')))
        and not exists (select 1 from posts p where p.news_item_id = n.id)
        and n.fetched_at > now() - make_interval(hours => $1)`,
    [windowH],
  );
  // Pool used for confirmations: every item seen recently (any decision).
  const { rows: pool } = await query<{ id: string; title: string; url: string }>(
    `select id, title, url from news_items where fetched_at > now() - make_interval(hours => $1)`,
    [windowH],
  );

  let eligible = 0;
  const upd = { id: [] as string[], topic: [] as string[], imp: [] as number[], rel: [] as number[], fresh: [] as number[], srel: [] as number[],
    acct: [] as number[], dup: [] as number[], conf: [] as number[], decision: [] as string[], reason: [] as string[], confirmations: [] as string[] };
  for (const n of open) {
    const scores: Scores = scoreNews(
      {
        title: n.title,
        summary: n.summary ?? '',
        url: n.url,
        publishedAt: n.published_at,
        fetchedAt: n.fetched_at,
        sourceReliability: Number(n.source_reliability ?? 0.5),
      },
      { now, maxAgeHours: settings.newsMaxAgeHours, trackedKeywords: settings.trackedKeywords, usedTexts },
    );
    const confirmations = pool.filter((o) => o.id !== n.id && isConfirmation(n, o)).map((o) => o.url);
    const { decision, reason } = decideNews(scores, { minConfidence: settings.minConfidence, confirmations: confirmations.length });
    if (decision === 'POST') eligible++;
    upd.id.push(n.id); upd.topic.push(scores.topic); upd.imp.push(scores.importance); upd.rel.push(scores.cryptoRelevance);
    upd.fresh.push(scores.freshness); upd.srel.push(scores.sourceReliability); upd.acct.push(scores.accountRelevance);
    upd.dup.push(scores.duplicateProbability); upd.conf.push(scores.confidence); upd.decision.push(decision); upd.reason.push(reason);
    upd.confirmations.push(JSON.stringify(confirmations.slice(0, 5)));
  }
  // One UPDATE for the whole batch instead of one round trip per story.
  if (upd.id.length > 0) {
    await query(
      `update news_items n set topic = v.topic, importance_score = v.imp, crypto_relevance = v.rel, freshness = v.fresh,
              source_reliability = v.srel, account_relevance = v.acct, duplicate_probability = v.dup, confidence = v.conf,
              decision = v.decision, decision_reason = v.reason, confirmations = v.confirmations::jsonb
         from unnest($1::uuid[], $2::text[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[],
                     $9::numeric[], $10::text[], $11::text[], $12::text[])
              as v(id, topic, imp, rel, fresh, srel, acct, dup, conf, decision, reason, confirmations)
        where n.id = v.id`,
      [upd.id, upd.topic, upd.imp, upd.rel, upd.fresh, upd.srel, upd.acct, upd.dup, upd.conf, upd.decision, upd.reason, upd.confirmations],
    );
  }
  return { evaluated: open.length, eligible };
}
