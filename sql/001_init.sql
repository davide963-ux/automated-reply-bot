-- ============================================================================
-- 001_init.sql  —  Phase 1 schema
--
-- DESIGN RULE: the daily limits (6 posts / 10 replies / 16 total) are enforced
-- INSIDE the database, in three independent layers:
--   1. reserve_publish_slot()  atomic conditional UPDATE (the normal path)
--   2. CHECK constraints on daily_usage (hard backstop, even against buggy code)
--   3. settings can only LOWER limits: slot_limit() clamps to the hard caps
-- ============================================================================

-- ---------- accounts ----------
create table accounts (
  id          uuid primary key default gen_random_uuid(),
  handle      text not null unique,
  x_user_id   text unique,
  timezone    text not null default 'UTC',
  created_at  timestamptz not null default now()
);

-- ---------- settings (single bot, key/value) ----------
create table settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Bot starts PAUSED: nothing can be published until someone resumes it.
insert into settings (key, value) values
  ('bot_status',           '"PAUSED"'),
  ('collect_while_paused', 'true'),
  ('max_posts_per_day',    '6'),
  ('max_replies_per_day',  '10'),
  ('max_total_per_day',    '16'),
  ('professional_ratio',   '0.5'),
  ('min_confidence',       '0.7'),
  ('personality',          '"crypto-native, concise, slightly sarcastic"'),
  ('active_hours',         '[{"start":"08:00","end":"23:00"}]'),
  ('min_gap_minutes',      '90'),
  ('tracked_accounts',     '[]'),
  ('tracked_keywords',     '[]')
on conflict (key) do nothing;

-- ---------- daily_usage (counters + hard backstop) ----------
create table daily_usage (
  account_id          uuid not null references accounts(id),
  usage_date          date not null,               -- in the ACCOUNT timezone
  posts_count         int  not null default 0,
  replies_count       int  not null default 0,
  x_api_requests      int  not null default 0,
  llm_requests        int  not null default 0,
  news_requests       int  not null default 0,
  estimated_x_cost    numeric(12,4) not null default 0,
  estimated_llm_cost  numeric(12,4) not null default 0,
  estimated_news_cost numeric(12,4) not null default 0,
  updated_at          timestamptz not null default now(),
  primary key (account_id, usage_date),
  -- HARD CAPS: these cannot be exceeded no matter what the application does.
  constraint daily_posts_hard_cap   check (posts_count   between 0 and 6),
  constraint daily_replies_hard_cap check (replies_count between 0 and 10),
  constraint daily_total_hard_cap   check (posts_count + replies_count <= 16)
);

-- ---------- sources / news ----------
create table sources (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  kind         text not null check (kind in ('rss','api','x_account')),
  url          text,
  reliability  numeric(3,2) not null default 0.50 check (reliability between 0 and 1),
  enabled      boolean not null default true,
  created_at   timestamptz not null default now()
);

create table news_items (
  id                    uuid primary key default gen_random_uuid(),
  source_id             uuid references sources(id),
  url                   text not null unique,
  title                 text not null,
  summary               text,
  published_at          timestamptz,
  fetched_at            timestamptz not null default now(),
  topic                 text,
  content_hash          text,
  importance_score      numeric(4,3),
  crypto_relevance      numeric(4,3),
  freshness             numeric(4,3),
  source_reliability    numeric(4,3),
  account_relevance     numeric(4,3),
  duplicate_probability numeric(4,3),
  confidence            numeric(4,3),
  decision              text not null default 'PENDING'
                        check (decision in ('PENDING','POST','IGNORE','WAIT_FOR_CONFIRMATION')),
  decision_reason       text,
  confirmations         jsonb not null default '[]'   -- independent confirming URLs
);
create index news_items_fetched_idx  on news_items (fetched_at desc);
create index news_items_decision_idx on news_items (decision);

-- ---------- posts ----------
create table posts (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references accounts(id),
  x_post_id             text unique,
  content               text not null check (char_length(content) between 1 and 280),
  content_type          text not null check (content_type in ('professional','degen','flexible','breaking')),
  topic                 text,
  sources               jsonb not null default '[]',   -- URLs used to produce the post
  news_item_id          uuid references news_items(id),
  content_hash          text not null,                  -- sha256 of normalized text
  idempotency_key       text unique,                    -- prevents duplicate publish on retry
  reserved_usage_date   date,                           -- date the daily slot was reserved on
  status                text not null default 'DRAFT'
                        check (status in ('DRAFT','PENDING_APPROVAL','APPROVED','PUBLISHING',
                                          'PUBLISHED','FAILED','REJECTED','UNCERTAIN','DRY_RUN')),
  rejection_reason      text,
  approved_by           text,
  approved_at           timestamptz,
  created_at            timestamptz not null default now(),
  published_at          timestamptz,
  updated_at            timestamptz not null default now()
);
create index posts_created_idx on posts (account_id, created_at desc);
create index posts_status_idx  on posts (status);
-- The exact same text can never be live/in-flight twice.
create unique index posts_no_exact_dupe
  on posts (account_id, content_hash)
  where status in ('PUBLISHING','PUBLISHED','UNCERTAIN');

-- ---------- conversations ----------
create table conversations (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references accounts(id),
  x_conversation_id     text not null,
  root_x_post_id        text,
  root_author_id        text,
  topic                 text,
  sentiment             text check (sentiment in ('positive','neutral','negative','mixed')),
  interaction_type      text not null default 'other'
                        check (interaction_type in ('mention','reply_to_us','tracked_account','keyword_search','other')),
  first_seen_at         timestamptz not null default now(),
  last_interaction_at   timestamptz,
  unique (account_id, x_conversation_id)
);

-- ---------- replies ----------
create table replies (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references accounts(id),
  x_reply_id            text unique,
  parent_x_post_id      text not null,
  parent_text           text,
  conversation_id       uuid not null references conversations(id),
  target_user_id        text,
  content               text not null check (char_length(content) between 1 and 280),
  content_hash          text not null,
  reason_for_reply      text,
  decision_confidence   numeric(4,3),
  reply_style           text check (reply_style in ('professional','degen','neutral')),
  is_unsolicited        boolean not null default true,  -- false when a human replied to US
  idempotency_key       text unique,
  reserved_usage_date   date,
  status                text not null default 'DRAFT'
                        check (status in ('DRAFT','PENDING_APPROVAL','APPROVED','PUBLISHING',
                                          'PUBLISHED','FAILED','REJECTED','UNCERTAIN','DRY_RUN')),
  created_at            timestamptz not null default now(),
  published_at          timestamptz,
  updated_at            timestamptz not null default now()
);
create index replies_conv_idx on replies (conversation_id);
-- DB-LEVEL RULE: max 1 unsolicited bot reply per conversation.
create unique index replies_one_unsolicited_per_conversation
  on replies (conversation_id)
  where is_unsolicited and status in ('PENDING_APPROVAL','APPROVED','PUBLISHING','PUBLISHED','UNCERTAIN');

-- ---------- scheduler ----------
create table scheduled_jobs (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid references accounts(id),
  job_type     text not null,
  run_at       timestamptz not null,
  status       text not null default 'PENDING'
               check (status in ('PENDING','RUNNING','DONE','FAILED','CANCELLED')),
  payload      jsonb not null default '{}',
  attempts     int not null default 0,
  locked_at    timestamptz,
  last_error   text,
  created_at   timestamptz not null default now()
);
create index scheduled_jobs_due_idx on scheduled_jobs (status, run_at);

-- ---------- bot_events (explainable decision log; NEVER store secrets here) ----------
create table bot_events (
  id          bigint generated always as identity primary key,
  ts          timestamptz not null default now(),
  action      text not null,            -- NEWS_FOUND, POST_PUBLISHED, CONTENT_REJECTED, ERROR, ...
  input_ref   text,                     -- id/url of what was evaluated
  decision    text,
  reason      text,
  confidence  numeric(4,3),
  result      text,
  details     jsonb not null default '{}'
);
create index bot_events_ts_idx     on bot_events (ts desc);
create index bot_events_action_idx on bot_events (action, ts desc);

-- ============================================================================
-- Limit functions
-- ============================================================================

-- Reads a limit from settings, but NEVER lets it exceed the hard cap.
create or replace function slot_limit(p_key text, p_hard int)
returns int language sql as $$
  select least(
    coalesce((select (value #>> '{}')::int from settings where key = p_key), p_hard),
    p_hard
  );
$$;

-- Read-only: would a publish of this kind be allowed right now?
-- Returns: OK | PAUSED | POST_LIMIT | REPLY_LIMIT | TOTAL_LIMIT
create or replace function publish_slot_status(p_account uuid, p_kind text, p_tz text)
returns text language plpgsql as $$
declare
  v_date    date := (now() at time zone p_tz)::date;
  v_status  text;
  v_posts   int;
  v_replies int;
begin
  if p_kind not in ('post','reply') then
    raise exception 'invalid kind: %', p_kind;
  end if;

  select value #>> '{}' into v_status from settings where key = 'bot_status';
  if v_status is distinct from 'RUNNING' then
    return 'PAUSED';
  end if;

  select posts_count, replies_count into v_posts, v_replies
    from daily_usage where account_id = p_account and usage_date = v_date;
  v_posts   := coalesce(v_posts, 0);
  v_replies := coalesce(v_replies, 0);

  if v_posts + v_replies >= slot_limit('max_total_per_day', 16) then
    return 'TOTAL_LIMIT';
  elsif p_kind = 'post' and v_posts >= slot_limit('max_posts_per_day', 6) then
    return 'POST_LIMIT';
  elsif p_kind = 'reply' and v_replies >= slot_limit('max_replies_per_day', 10) then
    return 'REPLY_LIMIT';
  end if;
  return 'OK';
end;
$$;

-- Atomically reserve one slot. Concurrent callers are serialized by the row
-- lock taken by the UPDATE, and the limit is re-checked inside that UPDATE.
-- Returns {"status": "...", "usage_date": "YYYY-MM-DD"}.
create or replace function reserve_publish_slot(p_account uuid, p_kind text, p_tz text)
returns jsonb language plpgsql as $$
declare
  v_date   date := (now() at time zone p_tz)::date;
  v_status text;
  v_rows   int;
  v_max_p  int := slot_limit('max_posts_per_day', 6);
  v_max_r  int := slot_limit('max_replies_per_day', 10);
  v_max_t  int := slot_limit('max_total_per_day', 16);
begin
  v_status := publish_slot_status(p_account, p_kind, p_tz);
  if v_status <> 'OK' then
    return jsonb_build_object('status', v_status, 'usage_date', v_date);
  end if;

  insert into daily_usage (account_id, usage_date)
    values (p_account, v_date) on conflict do nothing;

  if p_kind = 'post' then
    update daily_usage
       set posts_count = posts_count + 1, updated_at = now()
     where account_id = p_account and usage_date = v_date
       and posts_count < v_max_p
       and posts_count + replies_count < v_max_t;
  else
    update daily_usage
       set replies_count = replies_count + 1, updated_at = now()
     where account_id = p_account and usage_date = v_date
       and replies_count < v_max_r
       and posts_count + replies_count < v_max_t;
  end if;

  get diagnostics v_rows = row_count;
  if v_rows = 1 then
    return jsonb_build_object('status', 'OK', 'usage_date', v_date);
  end if;

  -- Lost a race: report the real reason (fail closed if somehow still 'OK').
  v_status := publish_slot_status(p_account, p_kind, p_tz);
  if v_status = 'OK' then v_status := 'TOTAL_LIMIT'; end if;
  return jsonb_build_object('status', v_status, 'usage_date', v_date);
end;
$$;

-- Give a slot back. ONLY call this when X definitively did NOT create the post.
-- (If the outcome is unknown, keep the slot reserved: fail closed.)
create or replace function release_publish_slot(p_account uuid, p_kind text, p_usage_date date)
returns void language plpgsql as $$
begin
  if p_kind = 'post' then
    update daily_usage set posts_count = greatest(posts_count - 1, 0), updated_at = now()
     where account_id = p_account and usage_date = p_usage_date;
  elsif p_kind = 'reply' then
    update daily_usage set replies_count = greatest(replies_count - 1, 0), updated_at = now()
     where account_id = p_account and usage_date = p_usage_date;
  else
    raise exception 'invalid kind: %', p_kind;
  end if;
end;
$$;
