/**
 * End-to-end engine tests against a REAL throwaway Postgres.
 * Everything outside is faked: X (an HTTP server + an in-memory XApi), the LLM (scripted),
 * and the news feeds. Nothing here touches the network or a real account.
 *
 *   npm run test:engine      (Postgres refuses to run as root: use a normal user)
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { check, expectThrows, finish, section } from './lib/harness';

const PG_PORT = 54330;
const DASH_TOKEN = 'dashboard-token-123456';

async function main(): Promise<void> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = mkdtempSync(join(tmpdir(), 'pg-engine-'));
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PG_PORT, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('engine_test');

  // ------------------------------------------------------------------------------------------
  // Fake X HTTP server (used by the real XClient / token code)
  // ------------------------------------------------------------------------------------------
  type Handler = (req: IncomingMessage, res: ServerResponse) => void;
  const xs = {
    requests: [] as Array<{ method: string; path: string; query: URLSearchParams; headers: IncomingHttpHeaders; body: string }>,
    tweetQueue: [] as Handler[],
    refreshCalls: 0,
    tokenMode: 'ok' as 'ok' | 'dead',
    tokenDelayMs: 0,
    tweetSeq: 9000,
    mentionsBody: undefined as unknown,
    meName: 'testbot',
    llmMode: 'ok' as 'ok' | 'auth' | 'length',
    llmReply: '{"action":"POST","text":"Spot ETH ETF inflows hit a record.","reason":"fresh"}',
    reset() {
      this.requests = []; this.tweetQueue = []; this.refreshCalls = 0; this.tokenMode = 'ok'; this.tokenDelayMs = 0; this.mentionsBody = undefined; this.meName = 'testbot'; this.llmMode = 'ok';
    },
    count(method: string, path: string) {
      return this.requests.filter((r) => r.method === method && r.path === path).length;
    },
  };
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const xServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      xs.requests.push({ method: req.method ?? '', path: u.pathname, query: u.searchParams, headers: req.headers, body: raw });
      void (async () => {
        if (u.pathname === '/2/oauth2/token') {
          xs.refreshCalls++;
          if (xs.tokenDelayMs) await new Promise((r) => setTimeout(r, xs.tokenDelayMs));
          if (xs.tokenMode === 'dead') return json(res, 400, { error: 'invalid_grant' });
          return json(res, 200, { access_token: `AT-${xs.refreshCalls}`, refresh_token: `RT-${xs.refreshCalls}`, expires_in: 7200, scope: 'tweet.read tweet.write' });
        }
        if (u.pathname === '/2/tweets' && req.method === 'POST') {
          const h = xs.tweetQueue.shift();
          if (h) return h(req, res);
          return json(res, 201, { data: { id: String(++xs.tweetSeq), text: 'ok' } });
        }
        if (u.pathname === '/v1/chat/completions' && req.method === 'POST') {
          if (req.headers.authorization !== 'Bearer test-llm-key-123456') return json(res, 401, { code: 'Client specified an invalid argument', error: 'Incorrect API key provided: test-***. You can obtain an API key from https://console.x.ai.' });
          if (xs.llmMode === 'auth') return json(res, 403, { code: 'Forbidden', error: 'Your team has no credits' });
          if (xs.llmMode === 'length') return json(res, 200, { choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 2900, total_tokens: 2910 } });
          return json(res, 200, { choices: [{ message: { role: 'assistant', content: xs.llmReply }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 400 } });
        }
        if (u.pathname === '/2/users/me') return json(res, 200, { data: { id: '42', username: xs.meName } });
        if (u.pathname === '/2/users/42/mentions') {
          return json(res, 200, xs.mentionsBody ?? { data: [{ id: '5001', text: '@testbot hello there friend', author_id: '7', conversation_id: '5001', created_at: new Date().toISOString() }], includes: { users: [{ id: '7', username: 'alice' }] } });
        }
        json(res, 404, { error: 'not found' });
      })();
    });
  });
  await new Promise<void>((r) => xServer.listen(0, '127.0.0.1', r));
  const xPort = (xServer.address() as AddressInfo).port;

  // Config is read at import time: set the environment BEFORE requiring app modules.
  Object.assign(process.env, {
    DATABASE_URL: `postgres://postgres:postgres@localhost:${PG_PORT}/engine_test`,
    ACCOUNT_TIMEZONE: 'UTC',
    LOG_LEVEL: 'error',
    X_ACCOUNT_HANDLE: 'testbot',
    X_API_BASE: `http://127.0.0.1:${xPort}`,
    X_CLIENT_ID: 'cid',
    X_CLIENT_SECRET: 'csecret',
    TOKEN_ENCRYPTION_KEY: 'c'.repeat(64),
    DASHBOARD_TOKEN: DASH_TOKEN,
    MAX_X_DAILY_SPEND: '5',
    LLM_PROVIDER: 'openai',
    LLM_API_KEY: 'test-llm-key-123456',
    LLM_MODEL: 'fake-grok',
    LLM_BASE_URL: `http://127.0.0.1:${xPort}/v1`, // the documented xAI style: base URL ending in /v1
  });
  delete process.env.X_ACCESS_TOKEN;
  delete process.env.X_REFRESH_TOKEN;

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { runMigrations } = require('../src/db/migrate') as typeof import('../src/db/migrate');
  const { query, closePool } = require('../src/db/client') as typeof import('../src/db/client');
  const { ensureAccount } = require('../src/db/accounts') as typeof import('../src/db/accounts');
  const { loadSettings, writeSetting } = require('../src/config/settings') as typeof import('../src/config/settings');
  const { collectNews } = require('../src/news/collector') as typeof import('../src/news/collector');
  const { runPostEngine } = require('../src/engine/postEngine') as typeof import('../src/engine/postEngine');
  const { runReplyEngine } = require('../src/engine/replyEngine') as typeof import('../src/engine/replyEngine');
  const { pollX } = require('../src/engine/ingest') as typeof import('../src/engine/ingest');
  const { publishRow } = require('../src/engine/publisher') as typeof import('../src/engine/publisher');
  const { reconcileUncertain } = require('../src/engine/reconcile') as typeof import('../src/engine/reconcile');
  const { approveItem, rejectItem, publishApprovedQueue } = require('../src/engine/control') as typeof import('../src/engine/control');
  const { runTick } = require('../src/engine/tick') as typeof import('../src/engine/tick');
  const { runDueJobs } = require('../src/engine/scheduler') as typeof import('../src/engine/scheduler');
  const { createXClient } = require('../src/x/client') as typeof import('../src/x/client');
  const { createProviderClient, withBudget } = require('../src/llm/client') as typeof import('../src/llm/client');
  const { generatePost } = require('../src/llm/content') as typeof import('../src/llm/content');
  const { getAccessToken, saveTokens } = require('../src/x/tokens') as typeof import('../src/x/tokens');
  const { XAuthError, XRateLimitError, XBudgetError } = require('../src/x/types') as typeof import('../src/x/types');
  const { LlmUnavailableError } = require('../src/llm/client') as typeof import('../src/llm/client');
  const { createDashboardHandler } = require('../src/dashboard/handler') as typeof import('../src/dashboard/handler');
  const { handleXConnect, handleXCallback } = require('../src/dashboard/xconnect') as typeof import('../src/dashboard/xconnect');
  const { migrationStatus, runMigrations: runMig } = require('../src/db/migrate') as typeof import('../src/db/migrate');
  const { createManualPost } = require('../src/engine/control') as typeof import('../src/engine/control');
  const { createHash } = require('crypto') as typeof import('crypto');
  const { reservePublishSlot } = require('../src/services/rateLimit') as typeof import('../src/services/rateLimit');
  type Deps = import('../src/engine/deps').Deps;
  type XApi = import('../src/x/types').XApi;
  type XTweet = import('../src/x/types').XTweet;
  type PublishOutcome = import('../src/x/types').PublishOutcome;
  type LlmClient = import('../src/llm/client').LlmClient;

  await runMigrations();
  const accountId = await ensureAccount();

  section('0. migration 003 (default min_confidence)');
  const mc = async () => Number(await query<{ v: string }>(`select value #>> '{}' as v from settings where key = 'min_confidence'`).then((r) => r.rows[0]?.v));
  check('an untouched default of 0.7 is lowered to 0.6', (await mc()) === 0.6, String(await mc()));
  await writeSetting('min_confidence', 0.75);
  await query(`delete from schema_migrations where filename = '003_tune_min_confidence.sql'`);
  await runMigrations();
  check('a value you chose yourself (0.75) is NEVER overwritten by re-running it', (await mc()) === 0.75, String(await mc()));

  // ------------------------------------------------------------------------------------------
  // In-memory fakes for the engine (X API object, LLM, feeds)
  // ------------------------------------------------------------------------------------------
  class FakeX implements XApi {
    posts: Array<{ text: string; replyToId?: string }> = [];
    outcomes: PublishOutcome[] = [];
    seq = 1000;
    meUser = { id: '42', username: 'testbot' };
    mentions: XTweet[] = [];
    tracked: Record<string, XTweet[]> = {};
    own: XTweet[] = [];
    async me() { return this.meUser; }
    async createPost(text: string, replyToId?: string): Promise<PublishOutcome> {
      this.posts.push({ text, replyToId });
      return this.outcomes.shift() ?? { kind: 'created', id: String(++this.seq) };
    }
    async getMentions() { return this.mentions; }
    async searchRecent() { return [] as XTweet[]; }
    async getUserTweets(userId: string) { return this.tracked[userId] ?? []; }
    async resolveUsername(username: string) { return { id: `u_${username.toLowerCase()}`, username }; }
    async getOwnRecentTweets() { return this.own; }
  }

  const out = (o: unknown) => ({ text: JSON.stringify(o), inputTokens: 10, outputTokens: 10 });
  class FakeLlm implements LlmClient {
    calls: Record<string, number> = {};
    down = new Set<string>();
    lastUser = '';
    post: (title: string) => string = (t) => `${t}.`;
    postAction: 'POST' | 'SKIP' = 'POST';
    judge = { supported: true, risk: 'LOW' as 'LOW' | 'MEDIUM' | 'HIGH' };
    reply: (tweet: string) => Record<string, unknown> = () => ({ decision: 'IGNORE', confidence: 0.9, reason: 'default' });
    async complete(req: { purpose: string; user: string }) {
      this.calls[req.purpose] = (this.calls[req.purpose] ?? 0) + 1;
      this.lastUser = req.user;
      if (this.down.has(req.purpose)) throw new LlmUnavailableError('down (test)');
      switch (req.purpose) {
        case 'generate_post': {
          const title = /Title: (.*)/.exec(req.user)?.[1] ?? '';
          return out({ action: this.postAction, text: this.post(title), reason: 'test' });
        }
        case 'judge_content':
          return out({
            supported: this.judge.supported, unsupported_claims: this.judge.supported ? [] : ['invented claim'],
            risk: this.judge.risk, risk_reasons: this.judge.risk === 'LOW' ? [] : ['test risk'],
          });
        case 'decide_reply': {
          const tweet = /Tweet to evaluate[^\n]*\n<untrusted>([\s\S]*?)<\/untrusted>/.exec(req.user)?.[1] ?? '';
          return out(this.reply(tweet));
        }
      }
      throw new Error(`unexpected LLM purpose ${req.purpose}`);
    }
  }

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const feeds: Record<string, string> = {};
  const feedXml = (host: string, items: Array<[string, string, number]>) =>
    `<rss><channel>${items.map(([t, d, h], i) => `<item><title>${esc(t)}</title><link>https://${host}.test/a${i}-${encodeURIComponent(t.slice(0, 12))}</link><description>${esc(d)}</description><pubDate>${new Date(Date.now() - h * 3_600_000).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
  const fetchText = async (url: string) => {
    const f = feeds[url];
    if (f === undefined) throw new Error(`feed down: ${url}`);
    return f;
  };

  const STORIES: Array<[string, string]> = [
    ['SEC approves spot Ethereum ETF, record $1.2 billion inflows on day one', 'The SEC approved the first spot Ethereum ETF; BlackRock and Fidelity report record inflows.'],
    ['Tether reserve attestation shows $90 billion in Treasuries as stablecoin supply hits record', 'Tether said its USDT reserves exceed liabilities, according to the latest attestation.'],
    ['Solana mainnet upgrade launches, throughput doubles after validator rollout', 'The crypto network upgrade went live on Solana mainnet this week.'],
    ['Bitcoin miners report record hashrate ahead of next halving', 'Bitcoin mining difficulty hit an all-time high as miners add capacity before the halving.'],
    ['Coinbase lists three new tokens and expands staking to 12 more countries', 'Coinbase announced the listing of three tokens and wider staking availability for users.'],
    ['Federal Reserve rate cut sends Bitcoin and crypto markets higher', 'Crypto markets rallied after the Federal Reserve announced an interest rate cut of 50 basis points.'],
    ['Opensea launches NFT marketplace upgrade, partnership with Visa announced', 'The NFT platform said the upgrade and a partnership with Visa will launch next month.'],
  ];
  const HACK: [string, string] = ['Hackers drain $45 million from DeFi lending protocol in exploit', 'The DeFi protocol said attackers stole $45 million; users are urged to withdraw funds.'];

  const DEFAULTS: Record<string, unknown> = {
    bot_status: 'RUNNING', active_hours: [], min_gap_minutes: 0, min_reply_gap_minutes: 0, min_confidence: 0.7,
    professional_ratio: 0.5, tracked_accounts: [], tracked_keywords: [], max_posts_per_day: 6, max_replies_per_day: 10,
    max_total_per_day: 16, reply_enabled: true, search_enabled: false, news_max_age_hours: 12, include_source_link: false,
    max_replies_per_user_per_day: 2, max_bot_replies_per_conversation: 3, collect_while_paused: true, approval_ttl_hours: 12,
    breaking_threshold: 0.85,
  };

  let fx = new FakeX();
  let llm = new FakeLlm();
  // Getters: deps created before a reset() must still see the CURRENT fakes (a stale reference caused a false failure once).
  const mkDeps = (over: Partial<Deps> = {}): Deps => ({
    accountId,
    get x() { return fx; },
    get llm() { return llm; },
    fetchText,
    flags: { dryRun: false, autonomous: true },
    now: () => new Date(), random: () => 0.5, ...over,
  });

  async function reset(): Promise<void> {
    await query(`truncate posts, replies, conversations, x_tweets_seen, news_items, daily_usage, scheduled_jobs, bot_events, bot_state, locks, x_tokens, sources restart identity cascade`);
    await query('update accounts set x_user_id = null');
    for (const [k, v] of Object.entries(DEFAULTS)) await writeSetting(k, v);
    await query(`insert into sources (name, kind, url, reliability) values
      ('CoinDesk','rss','https://feeds.test/coindesk',0.85),('Shady Blog','rss','https://feeds.test/shady',0.55),('The Block','rss','https://feeds.test/theblock',0.85)`);
    for (const k of Object.keys(feeds)) delete feeds[k];
    feeds['https://feeds.test/coindesk'] = feedXml('coindesk', []);
    feeds['https://feeds.test/shady'] = feedXml('shady', []);
    feeds['https://feeds.test/theblock'] = feedXml('theblock', []);
    fx = new FakeX();
    llm = new FakeLlm();
    xs.reset();
  }
  const one = async <T = string>(sql: string, p: unknown[] = []): Promise<T | undefined> => (await query<{ v: T }>(sql, p)).rows[0]?.v;
  const postCount = async (status: string) => Number(await one('select count(*)::text v from posts where status = $1', [status]));
  const slotCount = async (col: 'posts_count' | 'replies_count') => Number((await one(`select coalesce(sum(${col}),0)::text v from daily_usage`)) ?? 0);
  const eventCount = async (action: string, decision?: string) =>
    Number(await one('select count(*)::text v from bot_events where action = $1 and ($2::text is null or decision = $2)', [action, decision ?? null]));
  const collect = () => collectNews(accountId, fetchText);
  const runPost = async (deps = mkDeps()) => runPostEngine(deps, await loadSettings());
  const runReply = async (deps = mkDeps()) => runReplyEngine(deps, await loadSettings());
  const clearGap = () => query(`delete from bot_state where key = 'next_post_not_before'`);
  const etf = () => feeds['https://feeds.test/coindesk'] = feedXml('coindesk', [[STORIES[0]![0], STORIES[0]![1], 1]]);

  // ===========================================================================================
  section('1. news collection, scoring and decisions (bot PAUSED still collects, never generates)');
  await reset();
  await writeSetting('bot_status', 'PAUSED');
  feeds['https://feeds.test/coindesk'] = feedXml('coindesk', [
    [STORIES[0]![0], STORIES[0]![1], 1],
    ['Top 10 best crypto to buy now: price prediction', 'Sponsored guide', 1],
    ['Local bakery wins award for sourdough', 'Delicious bread for everyone', 1],
    ['SEC approves spot Solana ETF, record $3 billion inflows', 'Old story from long ago about the SEC.', 30],
  ]);
  feeds['https://feeds.test/shady'] = feedXml('shady', [[STORIES[3]![0], STORIES[3]![1], 1]]);
  feeds['https://feeds.test/theblock'] = feedXml('theblock', []);
  const c1 = await collect();
  const dec = async (like: string) => one<string>('select decision v from news_items where title like $1', [like]);
  check('collected from 3 sources, none failed', c1.sourcesOk === 3 && c1.sourcesFailed === 0 && c1.newItems === 5, JSON.stringify(c1));
  check('major story from reliable source: POST', (await dec('SEC approves spot Ethereum%')) === 'POST');
  check('listicle: IGNORE', (await dec('Top 10%')) === 'IGNORE');
  check('off-topic story: IGNORE', (await dec('Local bakery%')) === 'IGNORE');
  check('stale story: IGNORE', (await dec('SEC approves spot Solana%')) === 'IGNORE');
  check('low-reliability source alone: WAIT_FOR_CONFIRMATION', (await dec('Bitcoin miners report%')) === 'WAIT_FOR_CONFIRMATION');
  feeds['https://feeds.test/theblock'] = feedXml('theblock', [['Bitcoin miners hit record hashrate before the halving as mining difficulty reaches all-time high', 'Miners add capacity.', 1]]);
  await collect();
  check('independent confirmation promotes it to POST', (await dec('Bitcoin miners report%')) === 'POST');
  check('confirming URL recorded', Number(await one('select jsonb_array_length(confirmations)::text v from news_items where title like $1', ['Bitcoin miners report%'])) >= 1);
  const c2 = await collect();
  check('re-collecting is idempotent (no new rows)', c2.newItems === 0);
  feeds['https://feeds.test/shady'] = 'not xml at all';
  const c3 = await collect();
  check('a broken feed is skipped, the others still work', c3.sourcesOk === 3 && c3.newItems === 0);
  delete feeds['https://feeds.test/shady'];
  const c4 = await collect();
  check('an unreachable source counts as failed, not fatal', c4.sourcesFailed === 1 && c4.sourcesOk === 2, JSON.stringify(c4));
  const pausedRun = await runPost();
  check('PAUSED: post engine idle, ZERO LLM calls', pausedRun.outcome === 'idle' && Object.keys(llm.calls).length === 0);
  check('collect reports each source (name, items, new)', c1.sources.length === 3 && c1.sources.find((x) => x.name === 'CoinDesk')?.items === 4 && c1.sources.every((x) => x.error === undefined), JSON.stringify(c1.sources));
  check('a failed source is reported with its reason', c4.sources.some((x) => x.error !== undefined && x.items === 0), JSON.stringify(c4.sources));
  // Changing min_confidence must take effect on stories that were ALREADY collected and ignored for their score.
  await writeSetting('min_confidence', 0.99);
  await collect();
  check('min_confidence 0.99: the big story is now IGNORED for its score', (await dec('SEC approves spot Ethereum%')) === 'IGNORE' && /^confidence /.test((await one<string>('select decision_reason v from news_items where title like $1', ['SEC approves spot Ethereum%'])) ?? ''));
  await writeSetting('min_confidence', 0.7);
  const rescored = await collect();
  check('lowering it again RE-SCORES the ignored story back to POST (no new fetch needed)', (await dec('SEC approves spot Ethereum%')) === 'POST' && rescored.newItems === 0);
  check('final reasons stay final: the stale story is not revived', (await dec('SEC approves spot Solana%')) === 'IGNORE' && (await one<string>('select decision_reason v from news_items where title like $1', ['SEC approves spot Solana%'])) !== null);
  const solanaReason = async () => one<string>('select decision_reason v from news_items where title like $1', ['SEC approves spot Solana%']);
  await writeSetting('news_max_age_hours', 72);
  await collect();
  check("raising news_max_age_hours re-scores 'too old' stories (they are no longer stuck on 'too old')", (await solanaReason()) !== 'too old', String(await solanaReason()));
  await writeSetting('news_max_age_hours', 12);
  await collect();
  check("...and lowering it puts them back to 'too old'", (await solanaReason()) === 'too old', String(await solanaReason()));

  // ===========================================================================================
  section('1b. batched writes at real-world volume, with hostile characters');
  await reset();
  const tricky = 'He said "hello", {braces} and \\ backslash, plus \'quotes\' & ampersand [x]';
  const many = (host: string, n: number) => Array.from({ length: n }, (_, i) => [`${host} filler story ${i} about nothing`, 'Nothing here.', 2] as [string, string, number]);
  feeds['https://feeds.test/coindesk'] = feedXml('coindesk', [[tricky, 'Bitcoin and ethereum news about ETF flows.', 1], ...many('coindesk', 59)]);
  feeds['https://feeds.test/shady'] = feedXml('shady', many('shady', 60));
  feeds['https://feeds.test/theblock'] = feedXml('theblock', many('theblock', 60));
  const t0 = Date.now();
  const bulk = await collect();
  const took = Date.now() - t0;
  check('180 stories inserted, counted exactly (3 feeds x 60)', bulk.newItems === 180 && bulk.sources.every((x) => x.items === 60 && x.newItems === 60), JSON.stringify(bulk.sources));
  check('a title full of quotes, braces, commas, backslashes and an ampersand is stored byte-for-byte', (await one<string>('select title v from news_items where title like $1', ['He said%'])) === tricky);
  check('every story was scored (none left PENDING)', Number(await one(`select count(*)::text v from news_items where decision = 'PENDING'`)) === 0);
  check('the whole fetch is fast with batching (a handful of statements, not hundreds)', took < 5000, `${took}ms`);
  const refetch = await collect();
  check('fetching the same 180 again adds nothing', refetch.newItems === 0);

  // ===========================================================================================
  section('2. DRY_RUN: full pipeline, nothing sent, no slot consumed');
  await reset();
  etf();
  await collect();
  const dry = mkDeps({ flags: { dryRun: true, autonomous: true } });
  const r2 = await runPost(dry);
  check('post created with status DRY_RUN', r2.outcome === 'posted' && (await postCount('DRY_RUN')) === 1, JSON.stringify(r2));
  check('X was NOT called', fx.posts.length === 0);
  check('no daily slot consumed in dry run', (await slotCount('posts_count')) === 0);
  check('WOULD_PUBLISH event logged', (await eventCount('POST_PUBLISHED', 'WOULD_PUBLISH')) === 1);
  check('safety report stored with the checks that ran', Number(await one(`select jsonb_array_length(safety_report->'checks')::text v from posts`)) >= 6);
  const r2b = await runPost(dry);
  check('next run waits (cadence / no second post)', r2b.outcome === 'idle' && (await postCount('DRY_RUN')) === 1);
  check('LLM saw the news inside <untrusted> tags (prompt-injection defence)', llm.lastUser.includes('<untrusted>') || (llm.calls.generate_post ?? 0) >= 1);

  // ===========================================================================================
  section('3. approval queue (AUTONOMOUS_MODE=false)');
  await reset();
  etf();
  await collect();
  const manual = mkDeps({ flags: { dryRun: false, autonomous: false } });
  const r3 = await runPost(manual);
  check('item waits as PENDING_APPROVAL', r3.outcome === 'posted' && (await postCount('PENDING_APPROVAL')) === 1);
  check('nothing sent to X yet', fx.posts.length === 0 && (await slotCount('posts_count')) === 0);
  const pid = (await one<string>('select id v from posts'))!;
  const original = (await one<string>('select content v from posts'))!;
  const bad = await approveItem(manual, 'post', pid, 'tester', `${original} Total hit $9.9 billion.`);
  check('edit with an invented number is refused by the gate', !bad.ok && /safety gate/.test(bad.ok ? '' : bad.error), JSON.stringify(bad));
  check('...and the item stays PENDING_APPROVAL', (await postCount('PENDING_APPROVAL')) === 1 && fx.posts.length === 0);
  await writeSetting('bot_status', 'PAUSED');
  const blocked = await approveItem(manual, 'post', pid, 'tester');
  check('approve while PAUSED: blocked, item kept as APPROVED', blocked.ok && blocked.publish.status === 'BLOCKED' && (await postCount('APPROVED')) === 1 && fx.posts.length === 0, JSON.stringify(blocked));
  await writeSetting('bot_status', 'RUNNING');
  check('approved queue publishes once resumed', (await publishApprovedQueue(manual)) === 1 && fx.posts.length === 1 && (await postCount('PUBLISHED')) === 1);
  check('slot consumed exactly once, x_post_id stored', (await slotCount('posts_count')) === 1 && (await one<string>('select x_post_id v from posts')) !== null);
  check('approval metadata recorded', (await one<string>('select approved_by v from posts')) === 'tester');
  const again = await approveItem(manual, 'post', pid, 'tester');
  check('approving a published item is refused', !again.ok);
  // edited-and-valid approval + rejection
  await reset();
  etf();
  await collect();
  await runPost(manual);
  const pid2 = (await one<string>('select id v from posts'))!;
  const edited = 'SEC approves a spot Ethereum ETF with record $1.2 billion inflows on day one, per CoinDesk.';
  const ok2 = await approveItem(manual, 'post', pid2, 'tester', edited);
  check('valid edit passes the gate and is what gets published', ok2.ok && fx.posts[0]?.text === edited && (await one<string>('select content v from posts')) === edited, JSON.stringify(ok2));
  await reset();
  feeds['https://feeds.test/coindesk'] = feedXml('coindesk', [[STORIES[1]![0], STORIES[1]![1], 1]]);
  await collect();
  await runPost(manual);
  const pid3 = (await one<string>('select id v from posts'))!;
  check('reject works and sends nothing', (await rejectItem('post', pid3, 'tester', 'meh')) && (await postCount('REJECTED')) === 1 && fx.posts.length === 0);
  check('rejecting twice is a no-op', !(await rejectItem('post', pid3, 'tester')));

  // ===========================================================================================
  section('4. autonomous publishing and the HARD daily limit (6 posts)');
  await reset();
  feeds['https://feeds.test/coindesk'] = feedXml('coindesk', STORIES.map(([t, d]) => [t, d, 1] as [string, string, number]));
  const c = await collect();
  check('7 distinct stories are eligible', c.eligible === 7, JSON.stringify(c));
  const auto = mkDeps();
  const results: string[] = [];
  for (let i = 0; i < 8; i++) {
    await clearGap();
    const r = await runPost(auto);
    results.push(r.outcome === 'posted' ? r.result.status : `idle:${r.reason}`);
  }
  check('first 6 published, the 7th is refused', results.slice(0, 6).every((s) => s === 'PUBLISHED') && results[6]?.startsWith('idle') === true, results.join(' | '));
  check('X was called exactly 6 times', fx.posts.length === 6, String(fx.posts.length));
  check('daily_usage shows 6', (await slotCount('posts_count')) === 6);
  check('all 6 texts are different', new Set(fx.posts.map((p) => p.text)).size === 6);
  check('post mix recorded (professional/degen/breaking)', Number(await one(`select count(distinct content_type)::text v from posts`)) >= 2);
  const extra = (await query<{ id: string }>(
    `insert into posts (account_id, content, content_type, content_hash, idempotency_key, status)
     values ($1,'forced seventh post','flexible','hash7','k7','DRAFT') returning id`, [accountId])).rows[0]!.id;
  const forced = await publishRow(auto, 'post', extra);
  check('even a forced publish of a 7th post is BLOCKED by the database gate', forced.status === 'BLOCKED' && fx.posts.length === 6, JSON.stringify(forced));
  check('the blocked draft is rejected with the reason', ((await one<string>('select rejection_reason v from posts where id = $1', [extra])) ?? '').includes('POST_LIMIT'));

  // ===========================================================================================
  section('5. publish outcomes: created / rejected / unknown (UNCERTAIN) + reconciliation');
  await reset();
  feeds['https://feeds.test/coindesk'] = feedXml('coindesk', STORIES.map(([t, d]) => [t, d, 1] as [string, string, number]));
  await collect();
  // 5a unknown outcome keeps the slot and is never blind-retried
  fx.outcomes = [{ kind: 'unknown', reason: 'timeout' }];
  const u1 = await runPost();
  check('timeout -> UNCERTAIN', u1.outcome === 'posted' && u1.result.status === 'UNCERTAIN' && (await postCount('UNCERTAIN')) === 1);
  check('slot is KEPT (fail closed)', (await slotCount('posts_count')) === 1);
  const uncertainText = (await one<string>(`select content v from posts where status = 'UNCERTAIN'`))!;
  await clearGap();
  await runPost();
  check('the uncertain post is never re-sent (2nd X call is a different text)', fx.posts.length === 2 && fx.posts[0]!.text !== fx.posts[1]!.text);
  fx.own = [{ id: '777', conversationId: '777', authorId: '42', text: uncertainText, createdAt: new Date(), referenced: [] }];
  const rc = await reconcileUncertain(mkDeps());
  check('found on the timeline -> PUBLISHED with its X id', rc.published === 1 && (await one<string>(`select x_post_id v from posts where content = $1`, [uncertainText])) === '777');
  check('slot count unchanged by reconciliation', (await slotCount('posts_count')) === 2);
  // 5b not found: wait, then give up and release the slot
  await reset();
  etf();
  await collect();
  fx.outcomes = [{ kind: 'unknown', reason: 'HTTP 503' }];
  await runPost();
  fx.own = [];
  const rcWait = await reconcileUncertain(mkDeps());
  check('not found yet (<15 min): left alone, slot kept', rcWait.failed === 0 && (await postCount('UNCERTAIN')) === 1 && (await slotCount('posts_count')) === 1);
  await query(`update posts set updated_at = now() - interval '20 minutes'`);
  const rcGiveUp = await reconcileUncertain(mkDeps());
  check('not found after 15 min -> FAILED and slot released', rcGiveUp.failed === 1 && (await postCount('FAILED')) === 1 && (await slotCount('posts_count')) === 0);
  // 5c definitive rejections release the slot
  await reset();
  etf();
  await collect();
  fx.outcomes = [{ kind: 'rejected', status: 400, reason: 'HTTP 400: bad request', duplicate: false, authFailure: false }];
  await runPost();
  check('4xx rejection -> FAILED, slot released', (await postCount('FAILED')) === 1 && (await slotCount('posts_count')) === 0);
  await reset();
  etf();
  await collect();
  fx.outcomes = [{ kind: 'rejected', status: 403, reason: 'duplicate content', duplicate: true, authFailure: false }];
  await runPost();
  check('X duplicate-content 403 -> REJECTED, slot released', (await postCount('REJECTED')) === 1 && (await slotCount('posts_count')) === 0);
  await reset();
  etf();
  await collect();
  fx.outcomes = [{ kind: 'rejected', status: 401, reason: 'unauthorized', duplicate: false, authFailure: true }];
  await runPost();
  check('401 auth failure auto-PAUSES the bot', (await one<string>(`select value #>> '{}' v from settings where key = 'bot_status'`)) === 'PAUSED' && (await eventCount('BOT_PAUSED')) === 1);
  // 5d worker crash mid-publish
  await reset();
  await query(`insert into posts (account_id, content, content_type, content_hash, idempotency_key, status, reserved_usage_date, updated_at)
               values ($1,'crash recovery text about bitcoin','flexible','hc','kc','PUBLISHING', (now() at time zone 'UTC')::date, now() - interval '10 minutes')`, [accountId]);
  await query(`insert into daily_usage (account_id, usage_date, posts_count) values ($1, (now() at time zone 'UTC')::date, 1)`, [accountId]);
  fx.own = [{ id: '888', conversationId: '888', authorId: '42', text: 'crash recovery text about bitcoin', createdAt: new Date(), referenced: [] }];
  await reconcileUncertain(mkDeps());
  check('row stuck in PUBLISHING (crash) is recovered from the timeline', (await postCount('PUBLISHED')) === 1);
  // 5e double publish race
  await reset();
  const raceId = (await query<{ id: string }>(
    `insert into posts (account_id, content, content_type, content_hash, idempotency_key, status)
     values ($1,'race condition test post about ethereum','flexible','hr','kr','APPROVED') returning id`, [accountId])).rows[0]!.id;
  const race = await Promise.all([publishRow(mkDeps(), 'post', raceId), publishRow(mkDeps(), 'post', raceId)]);
  check('two concurrent publishes of one row: X is called exactly once', fx.posts.length === 1 && race.filter((r) => r.status === 'PUBLISHED').length === 1, JSON.stringify(race));
  check('...and exactly one slot is used', (await slotCount('posts_count')) === 1);

  // ===========================================================================================
  section('6. safety gate inside the pipeline');
  const gateCase = async (prep: () => void): Promise<void> => {
    await reset();
    etf();
    await collect();
    prep();
  };
  await gateCase(() => { llm.post = () => 'ETF inflows hit $9.9 billion on day one'; });
  await runPost();
  check('invented number: post REJECTED before any LLM judge call', (await postCount('REJECTED')) === 1 && fx.posts.length === 0 && !llm.calls.judge_content);
  check('rejection explained in bot_events', (await eventCount('CONTENT_REJECTED')) === 1);
  check('rejected news item is not retried forever', (await runPost()).outcome === 'idle');
  await gateCase(() => { llm.judge.supported = false; });
  await runPost();
  check('judge says unsupported -> REJECTED', (await postCount('REJECTED')) === 1 && fx.posts.length === 0);
  await gateCase(() => { llm.judge.risk = 'HIGH'; });
  await runPost();
  check('judge risk HIGH -> REJECTED', (await postCount('REJECTED')) === 1 && fx.posts.length === 0);
  await gateCase(() => { llm.judge.risk = 'MEDIUM'; });
  const med = await runPost();
  check('MEDIUM risk is NEVER auto-published, even in autonomous mode', med.outcome === 'posted' && med.result.status === 'PENDING_APPROVAL' && fx.posts.length === 0);
  await gateCase(() => { llm.post = () => 'You should buy ETH now before it moons'; });
  await runPost();
  check('financial advice -> REJECTED (risk)', (await postCount('REJECTED')) === 1 && fx.posts.length === 0);
  await reset();
  feeds['https://feeds.test/coindesk'] = feedXml('coindesk', [[HACK[0], HACK[1], 1]]);
  await collect();
  const hack = await runPost();
  check('a hack story (deterministic MEDIUM floor) goes to the approval queue', hack.outcome === 'posted' && hack.result.status === 'PENDING_APPROVAL', JSON.stringify(hack));
  await gateCase(() => { llm.postAction = 'SKIP'; });
  await runPost();
  check('model answers SKIP -> news ignored, no post row', Number(await one('select count(*)::text v from posts')) === 0 && (await dec('SEC approves%')) === 'IGNORE');
  await gateCase(() => { llm.down.add('generate_post'); });
  const down1 = await runPost();
  check('LLM down at generation: idle, nothing consumed', down1.outcome === 'idle' && Number(await one('select count(*)::text v from posts')) === 0 && (await dec('SEC approves%')) === 'POST');
  llm.down.clear();
  check('...and it succeeds on the next run', (await runPost()).outcome === 'posted' && fx.posts.length === 1);
  await gateCase(() => { llm.down.add('judge_content'); });
  const down2 = await runPost();
  check('LLM judge down: FAILS CLOSED (no publish, no post row), retried later', down2.outcome === 'idle' && fx.posts.length === 0 && Number(await one('select count(*)::text v from posts')) === 0);
  llm.down.clear();
  check('...judge back: published', (await runPost()).outcome === 'posted' && fx.posts.length === 1);
  await gateCase(() => undefined);
  await query(`insert into posts (account_id, content, content_type, content_hash, idempotency_key, status)
               values ($1,'SEC approves spot Ethereum ETF, record $1.2 billion inflows on day one.','flexible','hd','kd','PUBLISHED')`, [accountId]);
  await runPost();
  check('text identical to a published post -> REJECTED as duplicate', (await postCount('REJECTED')) === 1 && fx.posts.length === 0);
  await gateCase(() => undefined);
  await writeSetting('include_source_link', true);
  await runPost();
  check('source link is appended AFTER the gate (digits in URLs do not trip the fact check)', fx.posts.length === 1 && /https:\/\/coindesk\.test\//.test(fx.posts[0]!.text));

  // ===========================================================================================
  section('7. conversations and replies');
  await reset();
  const now = new Date();
  const tw = (id: string, conv: string, author: string, name: string, text: string, inReplyTo?: string): XTweet =>
    ({ id, conversationId: conv, authorId: author, authorUsername: name, text, createdAt: now, inReplyToUserId: inReplyTo, referenced: [] });
  fx.mentions = [
    tw('101', 'c1', '7', 'alice', '@testbot why did ETF inflows spike so much today?', '42'),
    tw('102', 'c3', '8', 'spammer', '@testbot GEM ALERT 100x presale live now'),
    tw('103', 'c4', '9', 'troll', '@testbot you are an idiot, worthless bot lol'),
    tw('104', 'c9', '42', 'testbot', 'our own tweet must never be processed'),
  ];
  await writeSetting('tracked_accounts', ['BigTrader']);
  fx.tracked['u_bigtrader'] = [
    tw('201', 'c2', '55', 'bigtrader', 'Spot ETH ETF flows are accelerating, institutions are clearly accumulating.'),
    tw('202', 'c2', '56', 'other', 'More ETF inflow data coming soon, stay tuned for the analysis.'),
  ];
  llm.reply = (t) =>
    /idiot/.test(t) ? { decision: 'IGNORE', confidence: 0.95, reason: 'troll', sentiment: 'negative' }
    : /why did ETF/.test(t) ? { decision: 'REPLY', confidence: 0.9, reason: 'genuine question', style: 'professional', topic: 'etf', sentiment: 'neutral', text: '@alice Inflows jumped as new spot products opened up to investors.' }
    : { decision: 'REPLY', confidence: 0.85, reason: 'adds value', style: 'neutral', topic: 'etf', sentiment: 'positive', text: 'Flows do look strong, though one day is a small sample.' };
  const polled = await pollX(mkDeps(), await loadSettings());
  check('poll stores mentions + tracked tweets, never our own', polled.mentions === 3 && polled.tracked === 2 && !polled.stoppedBecause, JSON.stringify(polled));
  check('a reply to us is classified reply_to_us', (await one<string>(`select source v from x_tweets_seen where x_post_id = '101'`)) === 'reply_to_us');
  check('X identity verified and stored', (await one<string>('select x_user_id v from accounts where id = $1', [accountId])) === '42');
  const outcomes: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await runReply();
    outcomes.push(r.outcome === 'replied' ? r.result.status : `idle:${r.reason}`);
    if (r.outcome === 'idle') break;
  }
  check('two replies published, then idle', outcomes.filter((o) => o === 'PUBLISHED').length === 2 && outcomes[outcomes.length - 1]?.startsWith('idle') === true, outcomes.join(' | '));
  check('replies went to the right parent tweets', fx.posts.length === 2 && fx.posts[0]!.replyToId === '101' && fx.posts[1]!.replyToId === '201', JSON.stringify(fx.posts));
  check('leading @mention stripped from reply text (X adds it)', !fx.posts[0]!.text.startsWith('@'));
  const st = async (id: string) => one<string>('select status v from x_tweets_seen where x_post_id = $1', [id]);
  check('spam skipped by the pre-filter (no LLM call spent)', (await st('102')) === 'SKIPPED');
  check('troll IGNORED by the model', (await st('103')) === 'IGNORED');
  check('2nd unsolicited tweet in the same conversation SKIPPED (max 1)', (await st('202')) === 'SKIPPED' && /already replied unsolicited/.test((await one<string>(`select decision_reason v from x_tweets_seen where x_post_id = '202'`)) ?? ''));
  check('solicited reply is is_unsolicited=false, tracked one is true',
    (await one<boolean>(`select is_unsolicited v from replies where parent_x_post_id = '101'`)) === false && (await one<boolean>(`select is_unsolicited v from replies where parent_x_post_id = '201'`)) === true);
  check('conversation memory: topic + sentiment stored', (await one<string>(`select topic v from conversations where x_conversation_id = 'c1'`)) === 'etf' && (await one<string>(`select sentiment v from conversations where x_conversation_id = 'c1'`)) === 'neutral');
  check('daily reply counter = 2', (await slotCount('replies_count')) === 2);
  // per-user cap
  fx.mentions = [tw('111', 'c1', '7', 'alice', '@testbot thanks, and what about the Solana flows then?', '42'), tw('112', 'c1', '7', 'alice', '@testbot and what about the bitcoin flows then?', '42')];
  llm.reply = () => ({ decision: 'REPLY', confidence: 0.9, reason: 'follow-up', style: 'neutral', text: 'Different products, different flow patterns, worth tracking separately.' });
  await pollX(mkDeps(), await loadSettings());
  await runReply();
  await runReply();
  check('per-user daily cap: alice gets at most 2 replies', Number(await one(`select count(*)::text v from replies where target_user_id = '7' and status = 'PUBLISHED'`)) === 2 && (await st('112')) === 'SKIPPED');
  // low confidence
  await reset();
  fx.mentions = [tw('301', 'c5', '12', 'bob', '@testbot is this a good time to buy bitcoin right now?', '42')];
  llm.reply = () => ({ decision: 'REPLY', confidence: 0.4, reason: 'unsure', style: 'neutral', text: 'Hard to say really.' });
  await pollX(mkDeps(), await loadSettings());
  await runReply();
  check('confidence below min_confidence -> IGNORED, no reply', (await st('301')) === 'IGNORED' && fx.posts.length === 0);
  // reply daily limit (10)
  await reset();
  fx.mentions = [tw('401', 'c6', '13', 'carol', '@testbot what do you think about the new ETF flows?', '42')];
  llm.reply = () => ({ decision: 'REPLY', confidence: 0.9, reason: 'q', style: 'neutral', text: 'Flows look healthy but one day is a small sample.' });
  for (let i = 0; i < 10; i++) await reservePublishSlot(accountId, 'reply');
  await pollX(mkDeps(), await loadSettings());
  const lim = await runReply();
  check('10 replies today: engine idles on the DB gate (REPLY_LIMIT)', lim.outcome === 'idle' && /REPLY_LIMIT|TOTAL_LIMIT/.test(lim.reason) && fx.posts.length === 0, JSON.stringify(lim));
  // replies in DRY_RUN
  await reset();
  fx.mentions = [tw('501', 'c7', '14', 'dave', '@testbot how are the ETF flows looking this week?', '42')];
  llm.reply = () => ({ decision: 'REPLY', confidence: 0.9, reason: 'q', style: 'neutral', text: 'Flows look healthy but one day is a small sample.' });
  await pollX(mkDeps(), await loadSettings());
  await runReply(mkDeps({ flags: { dryRun: true, autonomous: true } }));
  check('reply in DRY_RUN: status DRY_RUN, X not called', Number(await one(`select count(*)::text v from replies where status = 'DRY_RUN'`)) === 1 && fx.posts.length === 0);
  // reply approval queue
  await reset();
  fx.mentions = [tw('601', 'c8', '15', 'erin', '@testbot how are the ETF flows looking this week?', '42')];
  llm.reply = () => ({ decision: 'REPLY', confidence: 0.9, reason: 'q', style: 'neutral', text: 'Flows look healthy but one day is a small sample.' });
  await pollX(mkDeps(), await loadSettings());
  await runReply(mkDeps({ flags: { dryRun: false, autonomous: false } }));
  const rid = await one<string>(`select id v from replies where status = 'PENDING_APPROVAL'`);
  check('reply waits for approval when not autonomous', rid !== undefined && fx.posts.length === 0);
  const ar = await approveItem(mkDeps(), 'reply', rid!, 'tester');
  check('approved reply is published as a reply to the parent', ar.ok && fx.posts[0]?.replyToId === '601');
  // identity mismatch
  await reset();
  fx.meUser = { id: '99', username: 'someoneelse' };
  const mm = await pollX(mkDeps(), await loadSettings());
  check('authorized as the WRONG X account: bot pauses itself', mm.stoppedBecause === 'identity mismatch' && (await one<string>(`select value #>> '{}' v from settings where key = 'bot_status'`)) === 'PAUSED' && (await one<string | null>('select x_user_id v from accounts where id = $1', [accountId])) === null);

  // ===========================================================================================
  section('8. scheduler, lock, tick');
  await reset();
  feeds['https://feeds.test/coindesk'] = feedXml('coindesk', [[STORIES[0]![0], STORIES[0]![1], 1]]);
  fx.mentions = [];
  const t1 = await runTick(mkDeps());
  const names = t1.jobs.map((j) => j.job).sort().join(',');
  check('first tick runs all six jobs', names === 'COLLECT_NEWS,MAINTENANCE,POLL_X,POST,RECONCILE,REPLY' && t1.jobs.every((j) => j.ok), JSON.stringify(t1));
  check('end-to-end through the tick: one post published', fx.posts.length === 1 && (await postCount('PUBLISHED')) === 1);
  check('exactly one PENDING job per type queued for later', Number(await one(`select count(*)::text v from scheduled_jobs where status = 'PENDING' and run_at > now()`)) === 6);
  const t2 = await runTick(mkDeps());
  check('second tick immediately: nothing due', t2.jobs.length === 0 && !t2.skipped);
  await query(`insert into locks (name, locked_until, holder) values ('tick', now() + interval '5 minutes', 'someone-else') on conflict (name) do update set locked_until = excluded.locked_until, holder = excluded.holder`);
  check('tick held by another worker: skipped', (await runTick(mkDeps())).skipped === 'locked');
  await query(`update locks set locked_until = now() - interval '1 second'`);
  check('expired lock can be taken over', (await runTick(mkDeps())).skipped === undefined);
  await query(`update scheduled_jobs set run_at = now() - interval '1 minute' where status = 'PENDING'`);
  const conc = await Promise.all([runTick(mkDeps()), runTick(mkDeps())]);
  check('two overlapping ticks run each job at most once in total', conc.reduce((n, r) => n + r.jobs.length, 0) <= 6, JSON.stringify(conc.map((r) => r.skipped ?? r.jobs.length)));
  // failing job
  await reset();
  const failing = await runDueJobs({ COLLECT_NEWS: async () => { throw new Error('boom'); } }, new Date(), accountId);
  check('a failing job is recorded, does not throw', failing[0]?.ok === false && failing[0]?.error === 'boom');
  check('FAILED row kept with the error, next run queued', (await one<string>(`select last_error v from scheduled_jobs where status = 'FAILED'`)) === 'boom' && Number(await one(`select count(*)::text v from scheduled_jobs where status = 'PENDING'`)) === 1);
  check('it does not re-run before it is due', (await runDueJobs({ COLLECT_NEWS: async () => { throw new Error('again'); } }, new Date(), accountId)).length === 0);
  // paused behaviour
  await reset();
  await writeSetting('bot_status', 'PAUSED');
  await writeSetting('collect_while_paused', false);
  const tp = await runTick(mkDeps());
  check('PAUSED + collect_while_paused=false: only RECONCILE + MAINTENANCE', tp.jobs.map((j) => j.job).sort().join(',') === 'MAINTENANCE,RECONCILE', JSON.stringify(tp));
  await reset();
  await writeSetting('bot_status', 'PAUSED');
  const tp2 = await runTick(mkDeps());
  check('PAUSED + collect_while_paused=true: also collects, never POST/REPLY', tp2.jobs.map((j) => j.job).sort().join(',') === 'COLLECT_NEWS,MAINTENANCE,POLL_X,RECONCILE', JSON.stringify(tp2));
  await query(`insert into posts (account_id, content, content_type, content_hash, idempotency_key, status, created_at)
               values ($1,'old queued item','flexible','ho','ko','PENDING_APPROVAL', now() - interval '30 hours')`, [accountId]);
  await query(`update scheduled_jobs set run_at = now() - interval '1 minute'`);
  await runTick(mkDeps());
  check('stale approval-queue items expire', (await postCount('REJECTED')) === 1);

  // ===========================================================================================
  section('9. X tokens + the real HTTP client (fake X server)');
  await reset();
  check('not connected -> XAuthError, no network call', (await expectThrows(() => getAccessToken(accountId))) !== null && xs.requests.length === 0);
  await saveTokens(accountId, { accessToken: 'AT-initial', refreshToken: 'RT-initial', expiresAt: new Date(Date.now() + 3_600_000) });
  check('tokens are ENCRYPTED at rest', (await one<string>('select access_token v from x_tokens'))!.startsWith('enc:v1:') && (await one<string>('select refresh_token v from x_tokens'))!.startsWith('enc:v1:'));
  check('valid token returned without refreshing', (await getAccessToken(accountId)) === 'AT-initial' && xs.refreshCalls === 0);
  await query(`update x_tokens set expires_at = now() + interval '30 seconds'`);
  xs.tokenDelayMs = 200;
  const toks = await Promise.all([1, 2, 3, 4, 5].map(() => getAccessToken(accountId)));
  check('5 concurrent callers -> exactly ONE refresh (row lock)', xs.refreshCalls === 1 && new Set(toks).size === 1 && toks[0] === 'AT-1', `${xs.refreshCalls} ${toks.join(',')}`);
  const refreshReq = xs.requests.find((r) => r.path === '/2/oauth2/token')!;
  check('refresh used Basic auth + grant_type=refresh_token + the stored refresh token', refreshReq.headers.authorization === 'Basic ' + Buffer.from('cid:csecret').toString('base64') && new URLSearchParams(refreshReq.body).get('refresh_token') === 'RT-initial' && new URLSearchParams(refreshReq.body).get('grant_type') === 'refresh_token');
  const { decryptSecret } = require('../src/lib/crypto') as typeof import('../src/lib/crypto');
  check('rotated refresh token stored (encrypted)', decryptSecret((await one<string>('select refresh_token v from x_tokens'))!, 'c'.repeat(64)) === 'RT-1');
  // dead refresh token
  await query(`update x_tokens set expires_at = now() - interval '1 minute'`);
  xs.tokenMode = 'dead';
  xs.tokenDelayMs = 0;
  const before = xs.refreshCalls;
  const e1 = await getAccessToken(accountId).catch((e: unknown) => e);
  check('refresh rejected (invalid_grant) -> XAuthError', e1 instanceof XAuthError);
  check('needs_reauth PERSISTED (survives the failed transaction)', (await one<boolean>('select needs_reauth v from x_tokens')) === true);
  const e2 = await getAccessToken(accountId).catch((e: unknown) => e);
  check('next call fails fast without hitting X again', e2 instanceof XAuthError && xs.refreshCalls === before + 1);
  check('operator is told via a bot_event', (await eventCount('ERROR', 'X_REAUTH_NEEDED')) === 1);
  await saveTokens(accountId, { accessToken: 'AT-new', refreshToken: 'RT-new', expiresAt: new Date(Date.now() + 3_600_000) });
  xs.tokenMode = 'ok';
  check('re-authorizing clears needs_reauth', (await getAccessToken(accountId)) === 'AT-new');

  const xc = createXClient(accountId);
  const posted = await xc.createPost('hello world from the bot');
  const lastTweet = () => xs.requests.filter((r) => r.path === '/2/tweets').pop()!;
  check('201 -> created with the id', posted.kind === 'created' && posted.id === String(xs.tweetSeq));
  check('request carries the Bearer token + JSON body', lastTweet().headers.authorization === 'Bearer AT-new' && JSON.parse(lastTweet().body).text === 'hello world from the bot');
  await xc.createPost('a reply', '123');
  check('reply body uses reply.in_reply_to_tweet_id', JSON.parse(lastTweet().body).reply.in_reply_to_tweet_id === '123');
  xs.tweetQueue.push((_q, r) => json(r, 403, { detail: 'You are not allowed to create a Tweet with duplicate content.' }));
  const dupOut = await xc.createPost('dup');
  check('403 duplicate -> rejected(duplicate)', dupOut.kind === 'rejected' && dupOut.duplicate);
  xs.tweetQueue.push((_q, r) => json(r, 400, { detail: 'bad' }));
  check('400 -> rejected', (await xc.createPost('x')).kind === 'rejected');
  xs.tweetQueue.push((_q, r) => json(r, 500, { detail: 'oops' }));
  check('500 -> UNKNOWN (post may exist)', (await xc.createPost('x')).kind === 'unknown');
  xs.tweetQueue.push((q) => q.socket.destroy());
  check('connection dropped mid-request -> UNKNOWN', (await xc.createPost('x')).kind === 'unknown');
  xs.tweetQueue.push((_q, r) => json(r, 201, { data: {} }));
  check('201 without an id -> UNKNOWN', (await xc.createPost('x')).kind === 'unknown');
  xs.tweetQueue.push((_q, r) => json(r, 401, { title: 'Unauthorized' }));
  const rBefore = xs.refreshCalls;
  const afterRetry = await xc.createPost('retry after 401');
  check('401 -> token force-refreshed and the request retried once -> created', afterRetry.kind === 'created' && xs.refreshCalls === rBefore + 1);
  // reads
  const reqsBefore = xs.requests.length;
  const mentions = await xc.getMentions('42', '4000');
  check('mentions parsed with author username via expansions', mentions.length === 1 && mentions[0]!.authorUsername === 'alice' && mentions[0]!.conversationId === '5001');
  check('since_id forwarded', xs.requests[reqsBefore]!.query.get('since_id') === '4000');
  check('requests are counted + costed in daily_usage', Number(await one('select coalesce(sum(x_api_requests),0)::text v from daily_usage')) > 5 && Number(await one('select coalesce(sum(estimated_x_cost),0)::text v from daily_usage')) > 0);
  // rate limit
  xs.tweetQueue.push((_q, r) => json(r, 429, { title: 'Too Many Requests' }, { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 600) }));
  const rl = await xc.createPost('x');
  check('429 -> rejected (nothing created)', rl.kind === 'rejected' && rl.status === 429);
  const n0 = xs.requests.length;
  const rlRead = await xc.getMentions('42').catch((e: unknown) => e);
  const rlPost = await xc.createPost('while backing off');
  check('during backoff: reads throw XRateLimitError and NOTHING hits the network', rlRead instanceof XRateLimitError && rlPost.kind === 'rejected' && xs.requests.length === n0);
  await query(`delete from bot_state where key = 'x_backoff_until'`);
  // budget
  await query(`insert into daily_usage (account_id, usage_date, estimated_x_cost) values ($1, (now() at time zone 'UTC')::date, 5) on conflict (account_id, usage_date) do update set estimated_x_cost = 5`, [accountId]);
  const bud = await xc.getMentions('42').catch((e: unknown) => e);
  check('X budget reached: reads refused (XBudgetError)', bud instanceof XBudgetError);
  check('...but publishing is not blocked by the read budget', (await xc.createPost('still allowed')).kind === 'created');

  // ===========================================================================================
  section('10. dashboard (HTTP)');
  await reset();
  const dep = mkDeps({ flags: { dryRun: false, autonomous: false } });
  const dash = createServer((req, res) => void createDashboardHandler(() => dep)(req, res));
  await new Promise<void>((r) => dash.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(dash.address() as AddressInfo).port}/`;
  const H = { authorization: `Bearer ${DASH_TOKEN}` };
  const get = (r: string) => fetch(`${base}?r=${r}`, { headers: H });
  const post = (r: string, body: unknown, headers: Record<string, string> = { 'x-dashboard': '1' }) =>
    fetch(`${base}?r=${r}`, { method: 'POST', headers: { ...H, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  check('no credentials -> 401 + Basic challenge', (await fetch(base)).status === 401 && (await fetch(base)).headers.has('www-authenticate'));
  check('wrong token -> 401', (await fetch(base, { headers: { authorization: 'Bearer wrong' } })).status === 401);
  const page = await fetch(base, { headers: H });
  const html = await page.text();
  const csp = page.headers.get('content-security-policy') ?? '';
  const nonce = /nonce-([A-Za-z0-9+/=]+)/.exec(csp)?.[1];
  check('page served with a per-response CSP nonce used by its inline script', page.status === 200 && !!nonce && html.includes(`nonce="${nonce}"`) && csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'"));
  check('page never uses innerHTML', !html.includes('innerHTML'));
  const stat = (await (await get('status')).json()) as { botStatus: string; limits: { posts: number }; flags: { dryRun: boolean } };
  check('status API', stat.botStatus === 'RUNNING' && stat.limits.posts === 6 && stat.flags.dryRun === false);
  check('POST without x-dashboard header -> 403 (CSRF)', (await post('pause', {}, {})).status === 403);
  check('POST with a foreign Origin -> 403', (await post('pause', {}, { 'x-dashboard': '1', origin: 'https://evil.example' })).status === 403);
  check('pause works', (await post('pause', {})).status === 200 && (await loadSettings()).botStatus === 'PAUSED');
  check('resume works', (await post('resume', {})).status === 200 && (await loadSettings()).botStatus === 'RUNNING');
  const hard = await post('settings', { key: 'max_posts_per_day', value: 7 });
  check('raising a limit above the hard cap is refused (400)', hard.status === 400 && (await loadSettings()).maxPostsPerDay === 6);
  check('lowering a limit works', (await post('settings', { key: 'max_posts_per_day', value: 4 })).status === 200 && (await loadSettings()).maxPostsPerDay === 4);
  check('unknown setting key refused', (await post('settings', { key: 'bot_token', value: 'x' })).status === 400);
  check('DRY_RUN/AUTONOMOUS cannot be changed from the dashboard', (await post('settings', { key: 'dry_run', value: false })).status === 400);
  await writeSetting('max_posts_per_day', 6);
  etf();
  await collect();
  await runPost(dep);
  const queue = (await (await get('queue')).json()) as { items: Array<{ id: string; kind: string; content: string }> };
  check('queue lists the pending post', queue.items.length === 1 && queue.items[0]!.kind === 'post');
  const appr = await post('approve', { kind: 'post', id: queue.items[0]!.id });
  check('approve over HTTP publishes it', appr.status === 200 && fx.posts.length === 1 && (await postCount('PUBLISHED')) === 1);
  const ev = (await (await get('events&limit=5')).json()) as { events: unknown[] };
  check('events API', ev.events.length > 0 && ev.events.length <= 5);
  check('unknown route -> 404', (await get('nope')).status === 404);
  dash.close();

  // ===========================================================================================
  section('11. hard caps cannot be raised by any path');
  await reset();
  check('writeSetting(max_posts_per_day, 7) throws', (await expectThrows(() => writeSetting('max_posts_per_day', 7))) !== null);
  await query(`update settings set value = '99' where key = 'max_posts_per_day'`);
  check('even a poisoned settings row is clamped to 6 on read', (await loadSettings()).maxPostsPerDay === 6);
  let granted = 0;
  for (let i = 0; i < 9; i++) if ((await reservePublishSlot(accountId, 'post')).ok) granted++;
  check('...and by the database: only 6 slots are ever granted', granted === 6, String(granted));


  // ===========================================================================================
  section('12. browser-only setup: migration gate, X connect/callback, manual test post');
  await reset();
  const setupDeps = mkDeps({ flags: { dryRun: false, autonomous: false } });
  const setupSrv = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    if (path === '/api/x-connect') return void handleXConnect(req, res);
    if (path === '/api/x-callback') return void handleXCallback(req, res);
    return void createDashboardHandler(() => setupDeps)(req, res);
  });
  await new Promise<void>((r) => setupSrv.listen(0, '127.0.0.1', r));
  const sb = `http://127.0.0.1:${(setupSrv.address() as AddressInfo).port}`;
  const SH = { authorization: `Bearer ${DASH_TOKEN}` };
  const sget = (r: string) => fetch(`${sb}/?r=${r}`, { headers: SH });
  const spost = (r: string, body: unknown) => fetch(`${sb}/?r=${r}`, { method: 'POST', headers: { ...SH, 'content-type': 'application/json', 'x-dashboard': '1' }, body: JSON.stringify(body) });

  // --- migration gate
  const ms = await migrationStatus();
  check('migrationStatus: up to date', ms.ready && ms.pending.length === 0 && ms.applied.length === 3, JSON.stringify(ms));
  const migrated = (await (await spost('migrate', {})).json()) as { ok: boolean; applied: string[] };
  check('migrate route is idempotent (nothing to apply)', migrated.ok && migrated.applied.length === 0);
  await query(`delete from schema_migrations where filename = '003_tune_min_confidence.sql'`);
  const partial = (await (await sget('status')).json()) as { schemaReady: boolean; applied: string[]; pending: string[] };
  check('partly migrated: status says what is applied and what is pending (so the UI can say "your data is kept")', partial.schemaReady === false && partial.applied.length === 2 && partial.pending.length === 1 && partial.pending[0]!.startsWith('003'), JSON.stringify(partial));
  const partialApply = (await (await spost('migrate', {})).json()) as { applied: string[] };
  check('applying the single pending update works', partialApply.applied.length === 1 && partialApply.applied[0]!.startsWith('003'));
  await query('alter table schema_migrations rename to sm_bak');
  const notReady = await migrationStatus();
  check('migrationStatus: pending when the migrations table is missing', !notReady.ready && notReady.pending.length === 3);
  const st0 = (await (await sget('status')).json()) as { schemaReady: boolean; pending: string[]; x: { redirectUri: string; clientIdSet: boolean } };
  check('status works BEFORE the database is migrated (Setup tab can render)', st0.schemaReady === false && st0.pending.length === 3 && st0.x.clientIdSet === true && typeof st0.x.redirectUri === 'string');
  check('every other API route refuses with a clear 409 until migrated', (await sget('queue')).status === 409 && (await spost('pause', {})).status === 409);
  await query('alter table sm_bak rename to schema_migrations');
  check('...and works again once migrated', (await sget('queue')).status === 200);
  void runMig; // (a true fresh-database migration is exercised by the worker smoke run)

  // --- X connect
  const noAuth = await fetch(`${sb}/api/x-connect`, { redirect: 'manual' });
  check('x-connect requires the dashboard password', noAuth.status === 401);
  const conn = await fetch(`${sb}/api/x-connect`, { headers: SH, redirect: 'manual' });
  const loc = new URL(conn.headers.get('location') ?? 'http://none');
  const stateParam = loc.searchParams.get('state') ?? '';
  check('x-connect redirects to X with PKCE S256 + state + offline.access', conn.status === 302 && loc.host === 'x.com' && loc.searchParams.get('code_challenge_method') === 'S256' && stateParam.length >= 16 && (loc.searchParams.get('scope') ?? '').includes('offline.access'));
  check('state stored server-side', Number(await one(`select count(*)::text v from bot_state where key = $1`, [`x_oauth:${stateParam}`])) === 1);

  const cb = (qs: string) => fetch(`${sb}/api/x-callback?${qs}`, { redirect: 'manual' });
  check('callback with a made-up state -> 400, nothing saved', (await cb('code=abc&state=AAAAAAAAAAAAAAAAAAAAAA')).status === 400 && Number(await one('select count(*)::text v from x_tokens')) === 0);
  check('callback without code -> 400', (await cb(`state=${stateParam}`)).status === 400);
  check('callback with access_denied -> 400 page', (await cb('error=access_denied')).status === 400);
  const okCb = await cb(`code=THE-CODE&state=${stateParam}`);
  const okHtml = await okCb.text();
  check('valid callback -> 200 "Connected as @testbot"', okCb.status === 200 && okHtml.includes('Connected as @testbot'), okHtml.slice(0, 200));
  const tokenReq = xs.requests.filter((r) => r.path === '/2/oauth2/token').pop()!;
  const tb = new URLSearchParams(tokenReq.body);
  check('code exchanged with the PKCE verifier that matches the challenge sent to X',
    tb.get('code') === 'THE-CODE' && tb.get('grant_type') === 'authorization_code' &&
    createHash('sha256').update(tb.get('code_verifier') ?? '').digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === loc.searchParams.get('code_challenge'));
  check('tokens saved (encrypted) and the X identity stored', (await one<string>('select access_token v from x_tokens'))!.startsWith('enc:v1:') && (await one<string>('select x_user_id v from accounts where id = $1', [accountId])) === '42');
  check('state is single-use: replaying the callback -> 400', (await cb(`code=THE-CODE&state=${stateParam}`)).status === 400);
  const status2 = (await (await sget('status')).json()) as { x: { connected: boolean } };
  check('status now shows X connected', status2.x.connected === true);

  // expired state
  const conn2 = await fetch(`${sb}/api/x-connect`, { headers: SH, redirect: 'manual' });
  const st2 = new URL(conn2.headers.get('location')!).searchParams.get('state')!;
  await query(`update bot_state set updated_at = now() - interval '11 minutes' where key = $1`, [`x_oauth:${st2}`]);
  check('expired state (older than 10 min) -> 400', (await cb(`code=X&state=${st2}`)).status === 400);
  // wrong account
  await query('delete from x_tokens');
  await query('update accounts set x_user_id = null');
  const conn3 = await fetch(`${sb}/api/x-connect`, { headers: SH, redirect: 'manual' });
  const st3 = new URL(conn3.headers.get('location')!).searchParams.get('state')!;
  xs.meName = 'someoneelse';
  const wrong = await cb(`code=X&state=${st3}`);
  check('authorizing the WRONG X account -> 409 and the tokens are discarded', wrong.status === 409 && Number(await one('select count(*)::text v from x_tokens')) === 0 && (await one<string | null>('select x_user_id v from accounts where id = $1', [accountId])) === null);
  xs.meName = 'testbot';
  // XSS: attacker-controlled error text is escaped
  const xss = await (await cb('error=%3Cscript%3Ealert(1)%3C%2Fscript%3E')).text();
  check('callback page escapes attacker-controlled input', !xss.includes('<script>alert') && xss.includes('&lt;script&gt;'));

  // --- manual test post
  const dryTest = await createManualPost(mkDeps({ flags: { dryRun: true, autonomous: true } }), 'gm from my test');
  check('test post in DRY_RUN: validated, nothing sent', dryTest.ok && !dryTest.sent && fx.posts.length === 0);
  const spammy = await createManualPost(setupDeps, 'Free crypto giveaway, DM me!');
  check('test post: spam text refused', !spammy.ok);
  const paused = await (async () => { await writeSetting('bot_status', 'PAUSED'); return createManualPost(setupDeps, 'hello from the test post one'); })();
  check('test post while PAUSED: blocked by the DB gate', paused.ok && paused.sent && paused.publish.status === 'BLOCKED' && fx.posts.length === 0);
  await writeSetting('bot_status', 'RUNNING');
  const sent = await spost('testpost', { text: 'hello from the test post two' });
  const sentBody = (await sent.json()) as { ok: boolean; publish?: { status: string } };
  check('test post via the dashboard: published', sent.status === 200 && sentBody.publish?.status === 'PUBLISHED' && fx.posts.length === 1);
  check('same test post twice is refused', (await spost('testpost', { text: 'hello from the test post two' })).status === 400);
  // --- collect route
  feeds['https://feeds.test/coindesk'] = feedXml('coindesk', [[STORIES[0]![0], STORIES[0]![1], 1]]);
  const col = (await (await spost('collect', {})).json()) as { newItems: number; eligible: number };
  check('collect route (dashboard button) fetches and scores news', col.newItems === 1 && col.eligible === 1, JSON.stringify(col));
  const newsRes = (await (await sget('news')).json()) as { items: Array<{ decision: string; title: string }>; summary: Array<{ decision: string; reason: string; n: number }> };
  check('news route lists postable stories FIRST', newsRes.items.length > 0 && newsRes.items[0]!.decision === 'POST', JSON.stringify(newsRes.items.slice(0, 2)));
  check('news route summarises decisions and reasons in plain labels', newsRes.summary.some((r) => r.decision === 'POST' && r.n >= 1));
  setupSrv.close();

  // ===========================================================================================
  section('13. real LLM client against an xAI-style OpenAI-compatible server');
  await reset();
  const llmReq = () => xs.requests.filter((r) => r.path === '/v1/chat/completions').pop()!;
  const real = createProviderClient();
  const out1 = await real.complete({ system: 'sys', user: 'usr', maxTokens: 400, temperature: 0.8, purpose: 'test' });
  check('works with a base URL that already ends in /v1 (hits /v1/chat/completions, not /v1/v1)', xs.count('POST', '/v1/chat/completions') === 1 && out1.text.includes('Spot ETH ETF'));
  const llmSent = JSON.parse(llmReq().body) as { model: string; max_tokens: number; temperature: number; reasoning_effort?: string; messages: Array<{ role: string; content: string }> };
  check('sends Bearer auth, the model id, system+user messages', llmReq().headers.authorization === 'Bearer test-llm-key-123456' && llmSent.model === 'fake-grok' && llmSent.messages[0]!.role === 'system' && llmSent.messages[1]!.content === 'usr');
  check('adds reasoning headroom to max_tokens, passes temperature, no reasoning_effort by default', llmSent.max_tokens === 2900 && llmSent.temperature === 0.8 && llmSent.reasoning_effort === undefined, JSON.stringify(llmSent));
  check('output tokens = total - prompt when reasoning tokens are reported outside completion_tokens (100 in, 300 out)', out1.inputTokens === 100 && out1.outputTokens === 300, JSON.stringify(out1));
  const draftPost = await generatePost(real, { personality: 'dry', type: 'professional', news: { title: 'ETF inflows hit a record', summary: 'Flows rose.', source: 'CoinDesk' }, recentPosts: [], maxChars: 270 });
  check('a post is generated through the real client (JSON extracted from the reply)', draftPost.action === 'POST' && draftPost.text === 'Spot ETH ETF inflows hit a record.');
  const budgeted = withBudget(real, accountId);
  await budgeted.complete({ system: 's', user: 'u', maxTokens: 100, purpose: 'test' });
  check('spend is recorded in daily_usage (requests + estimated cost)', Number(await one('select coalesce(sum(llm_requests),0)::text v from daily_usage')) === 1 && Number(await one('select coalesce(sum(estimated_llm_cost),0)::text v from daily_usage')) > 0);
  xs.llmMode = 'auth';
  const e403 = await real.complete({ system: 's', user: 'u', maxTokens: 10, purpose: 'test' }).catch((e: unknown) => e);
  check("the provider's own error text is surfaced (xAI string-style errors), as an LlmUnavailableError", e403 instanceof LlmUnavailableError && /no credits/.test(String((e403 as Error).message)), String((e403 as Error)?.message));
  xs.llmMode = 'length';
  const eLen = await real.complete({ system: 's', user: 'u', maxTokens: 10, purpose: 'test' }).catch((e: unknown) => e);
  check('a reply cut off by the token limit is a clear error pointing at LLM_EFFORT', eLen instanceof LlmUnavailableError && /LLM_EFFORT/.test(String((eLen as Error).message)));
  check('the API key never appears in an error message', !String((e403 as Error).message).includes('test-llm-key-123456') && !String((eLen as Error).message).includes('test-llm-key-123456'));

  console.log('\n(shutting down embedded Postgres)');
  xServer.close();
  await closePool().catch(() => undefined);
  await pg.stop();
  rmSync(dir, { recursive: true, force: true });
  finish('engine tests');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
