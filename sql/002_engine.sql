-- ============================================================================
-- 002_engine.sql  —  Phases 2-10: X auth, engine state, reply queue, seeds
-- ============================================================================

-- ---------- X OAuth tokens (rotate on refresh, so they live in the DB) ----------
-- access_token / refresh_token may be AES-256-GCM encrypted ("enc:v1:..."),
-- see src/lib/crypto.ts. needs_reauth = refresh failed, a human must re-run x:auth.
create table x_tokens (
  account_id     uuid primary key references accounts(id),
  access_token   text not null,
  refresh_token  text,
  expires_at     timestamptz not null,
  scope          text,
  needs_reauth   boolean not null default false,
  updated_at     timestamptz not null default now()
);

-- ---------- cooperative lock: only one tick may run at a time ----------
create table locks (
  name          text primary key,
  locked_until  timestamptz not null,
  holder        text
);

-- ---------- engine bookkeeping (cursors, backoff). Not user-editable. ----------
create table bot_state (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ---------- candidate tweets for the reply engine (work queue + dedupe) ----------
create table x_tweets_seen (
  x_post_id             text primary key,
  account_id            uuid not null references accounts(id),
  x_conversation_id     text not null,
  author_id             text not null,
  author_username       text,
  text                  text not null,
  created_at_x          timestamptz,
  in_reply_to_user_id   text,
  source                text not null check (source in ('mention','reply_to_us','tracked_account','keyword_search')),
  status                text not null default 'NEW'
                        check (status in ('NEW','REPLIED','IGNORED','SKIPPED')),
  decision_reason       text,
  fetched_at            timestamptz not null default now()
);
create index x_tweets_seen_status_idx on x_tweets_seen (account_id, status, fetched_at);

-- ---------- extra columns for the safety gate + approval flow ----------
alter table posts
  add column risk_level      text not null default 'LOW' check (risk_level in ('LOW','MEDIUM','HIGH')),
  add column safety_report   jsonb not null default '{}',
  add column publish_error   text;

alter table replies
  add column risk_level      text not null default 'LOW' check (risk_level in ('LOW','MEDIUM','HIGH')),
  add column safety_report   jsonb not null default '{}',
  add column publish_error   text,
  add column rejection_reason text,
  add column approved_by     text,
  add column approved_at     timestamptz;

-- A given parent tweet is replied to at most once (loop / double-reply guard).
create unique index replies_one_per_parent
  on replies (account_id, parent_x_post_id)
  where status in ('PENDING_APPROVAL','APPROVED','PUBLISHING','PUBLISHED','UNCERTAIN');

-- ---------- one pending scheduled job per type ----------
create unique index scheduled_jobs_one_pending
  on scheduled_jobs (job_type)
  where status in ('PENDING','RUNNING');

-- ---------- new tunable settings (limits can only be LOWERED by slot_limit) ----------
insert into settings (key, value) values
  ('min_reply_gap_minutes',            '10'),
  ('breaking_threshold',               '0.85'),
  ('max_bot_replies_per_conversation', '3'),
  ('max_replies_per_user_per_day',     '2'),
  ('reply_enabled',                    'true'),
  ('search_enabled',                   'false'),
  ('news_max_age_hours',               '12'),
  ('include_source_link',              'false'),
  ('approval_ttl_hours',               '12')
on conflict (key) do nothing;

-- ---------- default news sources (edit/disable in the sources table) ----------
-- Reliability is a judgement call, tune it. Items from sources below 0.75 need
-- an independent confirmation from a second domain before they can be posted.
insert into sources (name, kind, url, reliability) values
  ('CoinDesk',         'rss', 'https://www.coindesk.com/arc/outboundfeeds/rss/', 0.85),
  ('The Block',        'rss', 'https://www.theblock.co/rss.xml',                 0.85),
  ('Blockworks',       'rss', 'https://blockworks.co/feed',                      0.80),
  ('Cointelegraph',    'rss', 'https://cointelegraph.com/rss',                   0.75),
  ('Decrypt',          'rss', 'https://decrypt.co/feed',                         0.75),
  ('Bitcoin Magazine', 'rss', 'https://bitcoinmagazine.com/feed',                0.65),
  ('CryptoSlate',      'rss', 'https://cryptoslate.com/feed/',                   0.60)
on conflict (name) do nothing;
