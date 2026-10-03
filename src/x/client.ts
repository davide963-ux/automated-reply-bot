import { z } from 'zod';
import { config } from '../config/env';
import { fetchWithTimeout, HttpTimeoutError } from '../lib/http';
import { logger } from '../lib/logger';
import { getState, setState } from '../db/state';
import { isBudgetExceeded, recordUsage } from '../services/rateLimit';
import { TokenError } from './oauth';
import { getAccessToken } from './tokens';
import { XAuthError, XBudgetError, XRateLimitError, type PublishOutcome, type XApi, type XTweet } from './types';

const log = logger.child({ module: 'x' });
const BACKOFF_KEY = 'x_backoff_until';

const TWEET_FIELDS = 'conversation_id,author_id,created_at,in_reply_to_user_id,referenced_tweets';

const tweetSchema = z.object({
  id: z.string(),
  text: z.string(),
  author_id: z.string().optional(),
  conversation_id: z.string().optional(),
  created_at: z.string().optional(),
  in_reply_to_user_id: z.string().optional(),
  referenced_tweets: z.array(z.object({ type: z.string(), id: z.string() })).optional(),
});
const listSchema = z.object({
  data: z.array(tweetSchema).optional(),
  includes: z.object({ users: z.array(z.object({ id: z.string(), username: z.string() })).optional() }).optional(),
});

function toTweets(json: unknown): XTweet[] {
  const parsed = listSchema.parse(json);
  const names = new Map((parsed.includes?.users ?? []).map((u) => [u.id, u.username]));
  return (parsed.data ?? []).map((t) => ({
    id: t.id,
    conversationId: t.conversation_id ?? t.id,
    authorId: t.author_id ?? '',
    authorUsername: t.author_id ? names.get(t.author_id) : undefined,
    text: t.text,
    createdAt: t.created_at ? new Date(t.created_at) : null,
    inReplyToUserId: t.in_reply_to_user_id,
    referenced: t.referenced_tweets ?? [],
  }));
}

/**
 * X API v2 client (OAuth 2.0 user context).
 *  - reads honour the daily X budget and the persisted rate-limit backoff
 *  - every request is counted in daily_usage
 *  - createPost classifies the outcome strictly (see PublishOutcome)
 */
export function createXClient(accountId: string): XApi {
  const base = config.x.apiBase;

  async function backoffGuard(): Promise<void> {
    const until = await getState<string>(BACKOFF_KEY);
    if (until && new Date(until).getTime() > Date.now()) throw new XRateLimitError(new Date(until));
  }

  async function send(
    method: 'GET' | 'POST',
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown; timeoutMs?: number; retried?: boolean } = {},
  ): Promise<Response> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const token = await getAccessToken(accountId, { force: opts.retried === true });
    const res = await fetchWithTimeout(
      url.toString(),
      {
        method,
        headers: { authorization: `Bearer ${token}`, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      },
      opts.timeoutMs ?? 20_000,
    );
    await recordUsage(accountId, 'x_api_requests', 1, method === 'POST' ? config.x.costPerWrite : config.x.costPerRead);

    if (res.status === 429) {
      const reset = Number(res.headers.get('x-rate-limit-reset'));
      const resetAt = reset > 0 ? new Date(reset * 1000) : new Date(Date.now() + 15 * 60_000);
      await setState(BACKOFF_KEY, resetAt.toISOString());
      log.warn('X rate limit hit, backing off', { resetAt: resetAt.toISOString(), path });
      throw new XRateLimitError(resetAt);
    }
    if (res.status === 401 && !opts.retried) {
      // 401 = request not processed: safe to refresh the token and retry once.
      await res.body?.cancel().catch(() => undefined);
      return send(method, path, { ...opts, retried: true });
    }
    return res;
  }

  async function read(path: string, query: Record<string, string | undefined>): Promise<unknown> {
    if (await isBudgetExceeded(accountId, 'x')) throw new XBudgetError();
    await backoffGuard();
    const res = await send('GET', path, { query });
    if (res.status === 401 || res.status === 403) throw new XAuthError(`X read refused (HTTP ${res.status}) on ${path}`);
    if (!res.ok) throw new Error(`X read failed: HTTP ${res.status} on ${path}`);
    return res.json();
  }

  const listQuery = (extra: Record<string, string | undefined>) => ({
    'tweet.fields': TWEET_FIELDS,
    expansions: 'author_id',
    'user.fields': 'username',
    ...extra,
  });

  return {
    async me() {
      const json = z.object({ data: z.object({ id: z.string(), username: z.string() }) }).parse(await read('/2/users/me', {}));
      return json.data;
    },

    async getMentions(userId, sinceId) {
      return toTweets(await read(`/2/users/${encodeURIComponent(userId)}/mentions`, listQuery({ max_results: '30', since_id: sinceId })));
    },

    async searchRecent(q, sinceId) {
      return toTweets(await read('/2/tweets/search/recent', listQuery({ query: q, max_results: '20', since_id: sinceId })));
    },

    async getUserTweets(userId, sinceId) {
      return toTweets(
        await read(`/2/users/${encodeURIComponent(userId)}/tweets`, listQuery({ max_results: '10', exclude: 'retweets,replies', since_id: sinceId })),
      );
    },

    async getOwnRecentTweets(userId) {
      return toTweets(
        await read(`/2/users/${encodeURIComponent(userId)}/tweets`, listQuery({ max_results: '30', exclude: 'retweets' })),
      );
    },

    async resolveUsername(username) {
      try {
        const json = z
          .object({ data: z.object({ id: z.string(), username: z.string() }).optional() })
          .parse(await read(`/2/users/by/username/${encodeURIComponent(username)}`, {}));
        return json.data ?? null;
      } catch (err) {
        if (err instanceof XRateLimitError || err instanceof XBudgetError || err instanceof XAuthError) throw err;
        return null;
      }
    },

    async createPost(text, replyToId): Promise<PublishOutcome> {
      // Writes are never blocked by the read budget; the daily post/reply caps are the limit.
      try {
        await backoffGuard();
      } catch (err) {
        if (err instanceof XRateLimitError) {
          // Nothing was sent, so this is a definitive "not created".
          return { kind: 'rejected', status: 429, reason: err.message, duplicate: false, authFailure: false };
        }
        throw err;
      }

      let res: Response;
      try {
        res = await send('POST', '/2/tweets', {
          body: { text, ...(replyToId ? { reply: { in_reply_to_tweet_id: replyToId } } : {}) },
          timeoutMs: 30_000,
        });
      } catch (err) {
        if (err instanceof XRateLimitError) {
          return { kind: 'rejected', status: 429, reason: err.message, duplicate: false, authFailure: false };
        }
        if (err instanceof XAuthError) {
          // Failed while obtaining a token, before anything was sent.
          return { kind: 'rejected', status: 401, reason: err.message, duplicate: false, authFailure: true };
        }
        if (err instanceof TokenError) {
          // Token refresh failed transiently, before anything was sent to /2/tweets.
          return { kind: 'rejected', status: 0, reason: `token refresh failed: ${err.message}`, duplicate: false, authFailure: false };
        }
        // Timeout / network drop AFTER the request may have reached X: outcome unknown.
        const why = err instanceof HttpTimeoutError ? 'timeout' : `network error: ${(err as Error).message}`;
        return { kind: 'unknown', reason: why };
      }

      const raw = await res.text().catch(() => '');
      if (res.status === 201 || res.status === 200) {
        try {
          const id = z.object({ data: z.object({ id: z.string() }) }).parse(JSON.parse(raw)).data.id;
          return { kind: 'created', id };
        } catch {
          return { kind: 'unknown', reason: `HTTP ${res.status} without a post id` };
        }
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 408) {
        const duplicate = res.status === 403 && /duplicate/i.test(raw);
        return {
          kind: 'rejected',
          status: res.status,
          reason: `HTTP ${res.status}: ${raw.slice(0, 300)}`,
          duplicate,
          authFailure: res.status === 401,
        };
      }
      return { kind: 'unknown', reason: `HTTP ${res.status}` }; // 5xx / 408 / anything else
    },
  };
}
