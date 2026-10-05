import { config } from '../config/env';
import { query } from '../db/client';
import { getState, setState } from '../db/state';
import type { Settings } from '../config/settings';
import { logger } from '../lib/logger';
import { logEvent } from '../services/events';
import { XAuthError, XBudgetError, XRateLimitError, type XTweet } from '../x/types';
import type { Deps } from './deps';
import { autoPause } from './publisher';

const log = logger.child({ module: 'ingest' });

type Source = 'mention' | 'reply_to_us' | 'tracked_account' | 'keyword_search';

/**
 * Resolves (and caches) our own X user id. SAFETY: if X_ACCOUNT_HANDLE is
 * configured and the authorized X account is a different one, the bot pauses
 * itself instead of posting from the wrong account.
 */
export async function ensureXIdentity(deps: Deps): Promise<{ id: string; username: string } | null> {
  const row = (await query<{ x_user_id: string | null; handle: string }>('select x_user_id, handle from accounts where id = $1', [deps.accountId])).rows[0];
  if (row?.x_user_id) return { id: row.x_user_id, username: row.handle };

  const me = await deps.x.me();
  const configured = config.accountHandle.replace(/^@/, '').toLowerCase();
  if (configured !== 'unconfigured' && configured !== me.username.toLowerCase()) {
    await logEvent({
      action: 'ERROR', decision: 'WRONG_X_ACCOUNT',
      reason: `authorized as @${me.username} but X_ACCOUNT_HANDLE is @${configured}`, result: 'bot paused',
    });
    await autoPause(`authorized X account @${me.username} does not match X_ACCOUNT_HANDLE`);
    return null;
  }
  await query('update accounts set x_user_id = $2 where id = $1', [deps.accountId, me.id]);
  log.info('X identity verified', { username: me.username });
  return { id: me.id, username: me.username };
}

const maxId = (a: string | undefined, b: string): string => (a && BigInt(a) > BigInt(b) ? a : b);

async function store(deps: Deps, myId: string, tweets: XTweet[], source: Source): Promise<{ inserted: number; newest?: string }> {
  let inserted = 0;
  let newest: string | undefined;
  for (const t of tweets) {
    newest = maxId(newest, t.id);
    if (t.authorId === myId) continue; // never process our own tweets
    const src: Source = source === 'mention' && t.inReplyToUserId === myId ? 'reply_to_us' : source;
    const r = await query(
      `insert into x_tweets_seen (x_post_id, account_id, x_conversation_id, author_id, author_username, text, created_at_x, in_reply_to_user_id, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (x_post_id) do nothing`,
      [t.id, deps.accountId, t.conversationId, t.authorId, t.authorUsername ?? null, t.text, t.createdAt, t.inReplyToUserId ?? null, src],
    );
    inserted += r.rowCount ?? 0;
  }
  return { inserted, newest };
}

export interface PollResult {
  mentions: number;
  tracked: number;
  search: number;
  stoppedBecause?: string;
}

/** Pull mentions, tracked accounts and (optionally) keyword search into the reply work queue. */
/** `deadlineMs` (epoch ms): once passed, no further tracked account is read; the rest is picked up by the next poll. */
export async function pollX(deps: Deps, s: Settings, deadlineMs?: number): Promise<PollResult> {
  const out: PollResult = { mentions: 0, tracked: 0, search: 0 };
  try {
    const me = await ensureXIdentity(deps);
    if (!me) return { ...out, stoppedBecause: 'identity mismatch' };

    // 1) mentions + replies to us (cursor persisted, so each tweet is fetched once)
    const since = await getState<string>('mentions_since_id');
    const mentions = await deps.x.getMentions(me.id, since);
    const m = await store(deps, me.id, mentions, 'mention');
    out.mentions = m.inserted;
    if (m.newest) await setState('mentions_since_id', m.newest);

    // 2) tracked accounts (max 10 per poll)
    if (s.replyEnabled && s.trackedAccounts.length > 0) {
      const ids = (await getState<Record<string, string>>('x_user_ids')) ?? {};
      const cursors = (await getState<Record<string, string>>('tracked_since')) ?? {};
      for (const username of s.trackedAccounts.slice(0, 10)) {
        if (deadlineMs !== undefined && Date.now() > deadlineMs) { out.stoppedBecause = 'time budget reached, continuing next poll'; break; }
        let uid = ids[username.toLowerCase()];
        if (!uid) {
          const u = await deps.x.resolveUsername(username);
          if (!u) { log.warn('tracked account not found', { username }); continue; }
          uid = u.id;
          ids[username.toLowerCase()] = uid;
        }
        const tweets = await deps.x.getUserTweets(uid, cursors[username.toLowerCase()]);
        const r = await store(deps, me.id, tweets, 'tracked_account');
        out.tracked += r.inserted;
        if (r.newest) cursors[username.toLowerCase()] = r.newest;
      }
      await setState('x_user_ids', ids);
      await setState('tracked_since', cursors);
    }

    // 3) keyword search: off by default, it is the most expensive read
    if (s.replyEnabled && s.searchEnabled && s.trackedKeywords.length > 0) {
      const terms = s.trackedKeywords.slice(0, 3).map((k) => (/\s/.test(k) ? `"${k}"` : k));
      const q = `(${terms.join(' OR ')}) -is:retweet -is:reply lang:en`;
      const sinceId = await getState<string>('search_since_id');
      const tweets = await deps.x.searchRecent(q, sinceId);
      const r = await store(deps, me.id, tweets, 'keyword_search');
      out.search = r.inserted;
      if (r.newest) await setState('search_since_id', r.newest);
    }
  } catch (err) {
    if (err instanceof XRateLimitError || err instanceof XBudgetError) {
      out.stoppedBecause = (err as Error).message;
      log.info('X polling paused', { reason: out.stoppedBecause });
    } else if (err instanceof XAuthError) {
      out.stoppedBecause = (err as Error).message;
      await logEvent({ action: 'ERROR', decision: 'X_AUTH', reason: out.stoppedBecause, result: 'polling stopped' });
    } else {
      out.stoppedBecause = `error: ${(err as Error).message}`;
      log.warn('X polling failed', { err });
    }
  }
  return out;
}
