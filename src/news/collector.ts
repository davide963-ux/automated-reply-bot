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

export interface CollectResult {
  sourcesOk: number;
  sourcesFailed: number;
  newItems: number;
  evaluated: number;
  eligible: number;
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

  const result: CollectResult = { sourcesOk: 0, sourcesFailed: 0, newItems: 0, evaluated: 0, eligible: 0 };

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
      for (const it of items) {
        const ins = await query(
          `insert into news_items (source_id, url, title, summary, published_at, content_hash, source_reliability)
           values ($1,$2,$3,$4,$5,$6,$7) on conflict (url) do nothing`,
          [src.id, it.url, it.title, it.summary, it.publishedAt, contentHash(it.title), src.reliability],
        );
        result.newItems += ins.rowCount ?? 0;
      }
    } catch (err) {
      result.sourcesFailed++;
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
  decision: 'PENDING' | 'POST' | 'WAIT_FOR_CONFIRMATION';
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
      where n.decision in ('PENDING','WAIT_FOR_CONFIRMATION','POST')
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

    await query(
      `update news_items set topic=$2, importance_score=$3, crypto_relevance=$4, freshness=$5,
              source_reliability=$6, account_relevance=$7, duplicate_probability=$8, confidence=$9,
              decision=$10, decision_reason=$11, confirmations=$12
        where id=$1`,
      [
        n.id, scores.topic, scores.importance, scores.cryptoRelevance, scores.freshness,
        scores.sourceReliability, scores.accountRelevance, scores.duplicateProbability, scores.confidence,
        decision, reason, JSON.stringify(confirmations.slice(0, 5)),
      ],
    );
  }
  return { evaluated: open.length, eligible };
}
