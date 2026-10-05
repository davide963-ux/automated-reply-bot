import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { config } from '../config/env';
import { query } from '../db/client';
import { getState } from '../db/state';
import { migrationStatus, runMigrations } from '../db/migrate';
import { SETTING_SCHEMAS, loadSettings, writeSetting } from '../config/settings';
import { approveItem, createManualPost, pauseBot, rejectItem, resumeBot } from '../engine/control';
import { collectNews } from '../news/collector';
import type { Deps } from '../engine/deps';
import { runTick } from '../engine/tick';
import { describeDbError } from '../lib/dberror';
import { logger } from '../lib/logger';
import { getUsageToday } from '../services/rateLimit';
import { dashboardHtml } from './html';

const log = logger.child({ module: 'dashboard' });
const MAX_BODY = 64 * 1024;

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Constant-time token check. Accepts "Authorization: Bearer <token>" or HTTP Basic (any user, password = token). */
export function isAuthorized(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header) return false;
  let supplied = '';
  if (header.startsWith('Bearer ')) supplied = header.slice(7);
  else if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    supplied = decoded.slice(decoded.indexOf(':') + 1);
  }
  return timingSafeEqual(digest(supplied), digest(token));
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const isString = typeof body === 'string';
  res.writeHead(status, {
    'content-type': isString ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(isString ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const pre = (req as IncomingMessage & { body?: unknown }).body; // already parsed by Vercel
  if (pre && typeof pre === 'object') return pre as Record<string, unknown>;
  if (typeof pre === 'string' && pre) return JSON.parse(pre) as Record<string, unknown>;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.slice(0, max) : '');
const intParam = (v: string | null, def: number, max: number) => Math.min(Math.max(parseInt(v ?? '', 10) || def, 1), max);
const KIND = (v: unknown): 'post' | 'reply' | null => (v === 'post' || v === 'reply' ? v : null);

/** Non-secret facts the Setup tab shows (usable before the database exists). */
function xSetup() {
  return { clientIdSet: Boolean(config.x.clientId), redirectUri: config.x.redirectUri, expectedHandle: config.accountHandle };
}

async function status(deps: Deps) {
  const s = await loadSettings();
  const usage = await getUsageToday(deps.accountId);
  const one = async (sql: string, p: unknown[] = []) => Number((await query<{ n: string }>(sql, p)).rows[0]?.n ?? 0);
  const [pendingPosts, pendingReplies, uncertain, newsOpen] = await Promise.all([
    one(`select count(*)::text n from posts where status = 'PENDING_APPROVAL'`),
    one(`select count(*)::text n from replies where status = 'PENDING_APPROVAL'`),
    one(`select (select count(*) from posts where status = 'UNCERTAIN') + (select count(*) from replies where status = 'UNCERTAIN') as n`),
    one(`select count(*)::text n from news_items where decision = 'POST' and not exists (select 1 from posts p where p.news_item_id = news_items.id)`),
  ]);
  const tok = (await query<{ needs_reauth: boolean; expires_at: Date }>('select needs_reauth, expires_at from x_tokens where account_id = $1', [deps.accountId])).rows[0];
  const jobs = (await query('select job_type, run_at, status, last_error from scheduled_jobs where status in (\'PENDING\',\'RUNNING\') order by run_at')).rows;
  return {
    now: new Date().toISOString(),
    botStatus: s.botStatus,
    flags: deps.flags,
    handle: config.accountHandle,
    timezone: config.timezone,
    usage,
    limits: { posts: s.maxPostsPerDay, replies: s.maxRepliesPerDay, total: s.maxTotalPerDay },
    budget: config.budget,
    queue: { pendingPosts, pendingReplies, uncertain, eligibleNews: newsOpen },
    schemaReady: true,
    dbSource: config.db.urlSource,
    x: { connected: Boolean(tok), needsReauth: tok?.needs_reauth ?? false, ...xSetup() },
    llm: { configured: Boolean(config.llm.provider && config.llm.apiKey && config.llm.model) },
    jobs,
    engines: {
      post: (await getState<{ result: string; at: string }>('last_post_result')) ?? null,
      reply: (await getState<{ result: string; at: string }>('last_reply_result')) ?? null,
      poll: (await getState<{ result: string; at: string }>('last_poll_result')) ?? null,
    },
    tweetsSeen: Object.fromEntries(
      (await query<{ status: string; n: string }>(`select status, count(*)::text n from x_tweets_seen group by status`)).rows.map((r) => [r.status, Number(r.n)]),
    ),
  };
}

/**
 * Framework-free request handler (works under node:http and Vercel functions).
 * Routing is by ?r=<route> so it behaves the same at "/" and at "/api/dashboard".
 */
export function createDashboardHandler(getDeps: () => Deps | Promise<Deps>) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!config.runtime.dashboardToken) {
        return send(res, 503, { error: 'dashboard disabled: set DASHBOARD_TOKEN (min 16 chars)' });
      }
      const auth = req.headers.authorization;
      if (!isAuthorized(auth, config.runtime.dashboardToken)) {
        await new Promise((r) => setTimeout(r, 400)); // slow down guessing
        return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Basic realm="crypto-x-agent", charset="UTF-8"' });
      }

      const url = new URL(req.url ?? '/', 'http://local');
      const route = url.searchParams.get('r');
      const method = req.method ?? 'GET';

      if (!route) {
        if (method !== 'GET') return send(res, 405, { error: 'method not allowed' });
        const nonce = randomBytes(16).toString('base64');
        return send(res, 200, dashboardHtml(nonce), {
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
      }

      if (method === 'POST') {
        // CSRF: a custom header cannot be sent cross-site without a CORS preflight, which we never allow.
        if (req.headers['x-dashboard'] !== '1') return send(res, 403, { error: 'missing x-dashboard header' });
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'cross-origin request refused' });
      } else if (method !== 'GET') {
        return send(res, 405, { error: 'method not allowed' });
      }

      // The database must be migrated before anything else works. Status and migrate are the only exceptions,
      // so a brand-new deployment can be set up from the browser alone.
      const mig = await migrationStatus();
      if (route === 'status' && !mig.ready) {
        return send(res, 200, {
          schemaReady: false,
          dbSource: config.db.urlSource,
          applied: mig.applied,
          pending: mig.pending,
          x: { connected: false, needsReauth: false, ...xSetup() },
          llm: { configured: Boolean(config.llm.provider && config.llm.apiKey && config.llm.model) },
          flags: { dryRun: config.flags.dryRun, autonomous: config.flags.autonomousMode },
          handle: config.accountHandle,
        });
      }
      if (route === 'migrate' && method === 'POST') {
        const applied = await runMigrations();
        return send(res, 200, { ok: true, applied });
      }
      if (!mig.ready) return send(res, 409, { error: 'database not migrated yet: open the Setup tab and run the migration' });

      const deps = await getDeps();
      const by = 'dashboard';

      // ---------------- GET ----------------
      if (method === 'GET') {
        const limit = intParam(url.searchParams.get('limit'), 50, 200);
        switch (route) {
          case 'status':
            return send(res, 200, await status(deps));
          case 'queue': {
            const posts = await query(`select id, content, content_type, risk_level, safety_report, sources, created_at, 'post' as kind from posts where status = 'PENDING_APPROVAL' order by created_at`);
            const replies = await query(`select id, content, parent_text, parent_x_post_id, risk_level, safety_report, reason_for_reply, created_at, 'reply' as kind from replies where status = 'PENDING_APPROVAL' order by created_at`);
            return send(res, 200, { items: [...posts.rows, ...replies.rows] });
          }
          case 'events': {
            const action = url.searchParams.get('action');
            const r = await query(
              `select id, ts, action, input_ref, decision, reason, confidence, result, details from bot_events
                where ($1::text is null or action = $1) order by id desc limit $2`,
              [action, limit],
            );
            return send(res, 200, { events: r.rows });
          }
          case 'news': {
            const decision = url.searchParams.get('decision');
            // Postable stories first (best score first), then waiting ones, then the ignored: the useful rows are never buried.
            const r = await query(
              `select n.id, n.title, n.url, s.name as source, n.topic, n.decision, n.decision_reason, n.confidence, n.importance_score, n.freshness, n.published_at
                 from news_items n left join sources s on s.id = n.source_id
                where ($1::text is null or n.decision = $1)
                order by case n.decision when 'POST' then 0 when 'WAIT_FOR_CONFIRMATION' then 1 when 'PENDING' then 2 else 3 end,
                         n.confidence desc nulls last, n.published_at desc nulls last
                limit $2`,
              [decision, limit],
            );
            // Why are stories ignored? (reasons grouped into a few plain labels)
            const sum = await query(
              `select decision,
                      case when decision_reason like 'confidence %' then 'score too low'
                           when decision_reason like 'low crypto relevance%' then 'not about crypto'
                           when decision_reason like 'duplicates%' then 'duplicate of something posted'
                           when decision_reason = 'too old' then 'too old'
                           when decision_reason like 'llm skip%' then 'model skipped it'
                           when decision_reason like 'source reliability%' then 'waiting for a 2nd source'
                           else coalesce(decision_reason, '') end as reason,
                      count(*)::int as n
                 from news_items group by 1, 2 order by n desc`,
            );
            return send(res, 200, { items: r.rows, summary: sum.rows });
          }
          case 'posts': {
            const r = await query(`select id, content, content_type, status, risk_level, rejection_reason, publish_error, x_post_id, created_at, published_at from posts order by created_at desc limit $1`, [limit]);
            return send(res, 200, { items: r.rows });
          }
          case 'replies': {
            const r = await query(`select id, content, parent_text, status, is_unsolicited, risk_level, rejection_reason, publish_error, x_reply_id, created_at from replies order by created_at desc limit $1`, [limit]);
            return send(res, 200, { items: r.rows });
          }
          case 'settings':
            return send(res, 200, { settings: await loadSettings(), keys: Object.keys(SETTING_SCHEMAS) });
          default:
            return send(res, 404, { error: 'unknown route' });
        }
      }

      // ---------------- POST ----------------
      const body = await readJson(req);
      switch (route) {
        case 'pause':
          await pauseBot(by, str(body.reason) || 'manual pause from dashboard');
          return send(res, 200, { ok: true });
        case 'resume':
          await resumeBot(by);
          return send(res, 200, { ok: true });
        case 'approve': {
          const kind = KIND(body.kind);
          if (!kind) return send(res, 400, { error: 'kind must be post or reply' });
          const edited = typeof body.text === 'string' ? body.text : undefined;
          const r = await approveItem(deps, kind, str(body.id, 64), by, edited);
          return send(res, r.ok ? 200 : 409, r);
        }
        case 'reject': {
          const kind = KIND(body.kind);
          if (!kind) return send(res, 400, { error: 'kind must be post or reply' });
          const ok = await rejectItem(kind, str(body.id, 64), by, str(body.reason, 300) || undefined);
          return send(res, ok ? 200 : 409, { ok });
        }
        case 'settings':
          await writeSetting(str(body.key, 64), body.value);
          return send(res, 200, { ok: true });
        case 'tick':
          return send(res, 200, await runTick(deps));
        case 'collect':
          return send(res, 200, await collectNews(deps.accountId, deps.fetchText));
        case 'testpost': {
          const r = await createManualPost(deps, str(body.text, 400));
          return send(res, r.ok ? 200 : 400, r);
        }
        default:
          return send(res, 404, { error: 'unknown route' });
      }
    } catch (err) {
      log.error('dashboard request failed', { err });
      const dbHint = describeDbError(err);
      if (dbHint) return send(res, 503, { error: dbHint });
      const msg = (err as Error).message;
      // Validation errors from writeSetting are safe to show; anything else is generic.
      const safe = /^(unknown setting|invalid value)/.test(msg) ? msg : 'internal error';
      return send(res, safe === msg ? 400 : 500, { error: safe });
    }
  };
}
