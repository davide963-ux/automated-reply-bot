/**
 * Pure-logic tests: no database, no network (except a throwaway local HTTP
 * server for the OAuth token endpoint). Run: npm run test:unit
 */
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { createHash } from 'crypto';
import { check, expectThrows, finish, section } from './lib/harness';

process.env.DATABASE_URL ??= 'postgres://unused:unused@localhost:1/unused';
process.env.LOG_LEVEL = 'error';

async function main(): Promise<void> {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const T = require('../src/lib/text') as typeof import('../src/lib/text');
  const { parseFeed } = require('../src/news/rss') as typeof import('../src/news/rss');
  const S = require('../src/news/scoring') as typeof import('../src/news/scoring');
  const R = require('../src/safety/rules') as typeof import('../src/safety/rules');
  const C = require('../src/lib/crypto') as typeof import('../src/lib/crypto');
  const TM = require('../src/lib/time') as typeof import('../src/lib/time');
  const { parseJsonReply } = require('../src/llm/client') as typeof import('../src/llm/client');
  const { SETTING_SCHEMAS } = require('../src/config/settings') as typeof import('../src/config/settings');
  const { isAuthorized } = require('../src/dashboard/handler') as typeof import('../src/dashboard/handler');
  const { pickPostType, computeNextPostGapMinutes } = require('../src/engine/postEngine') as typeof import('../src/engine/postEngine');
  const { prefilterTweet } = require('../src/engine/replyEngine') as typeof import('../src/engine/replyEngine');
  const { z } = require('zod') as typeof import('zod');

  // ------------------------------------------------------------------ text
  section('text utilities');
  check('hash ignores case, punctuation and URLs',
    T.contentHash('Bitcoin hits $100k!! https://x.com/a') === T.contentHash('bitcoin hits $100k'));
  check('hash differs for different text', T.contentHash('a b c') !== T.contentHash('a b d'));
  check('tweetLength: URL counts 23', T.tweetLength('hi https://example.com/very/long/path/that/is/long') === 3 + 23);
  check('tweetLength: emoji counts 2', T.tweetLength('a😀') === 3);
  check('extractNumbers canonicalises', JSON.stringify(T.extractNumbers('$1.50B and 100,000 and 12%')) === JSON.stringify(['1.5b', '100000', '12%']));
  check('extractNumbers keeps % distinct from a plain number (regression)', JSON.stringify(T.extractNumbers('up 15% to $15')) === JSON.stringify(['15%', '15']));
  check('extractNumbers: "5 meters" is not 5m (regression)', JSON.stringify(T.extractNumbers('5 meters')) === JSON.stringify(['5']));
  check('extractTickers', JSON.stringify(T.extractTickers('$eth up, $BTC flat, price $5')) === JSON.stringify(['ETH', 'BTC']));
  check('similarity: near duplicate high', T.similarity('SEC approves spot ether ETF', 'The SEC approves spot ether ETF today') > 0.5);
  check('similarity: unrelated low', T.similarity('SEC approves spot ether ETF', 'Solana validator outage resolved') < 0.2);
  check('stripHtml decodes entities', T.stripHtml('<p>Tom &amp; Jerry &#8217;s</p>') === 'Tom & Jerry ’s');

  // ------------------------------------------------------------------ rss
  section('RSS / Atom parser');
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[Bitcoin ETF sees record inflows]]></title><link>https://a.com/x?utm_source=tw&id=1</link>
      <description><![CDATA[<p>Spot <b>bitcoin</b> ETFs &amp; more</p>]]></description><pubDate>Fri, 02 Oct 2026 10:00:00 GMT</pubDate></item>
    <item><title>No link here</title></item>
    <item><title>Bad scheme</title><link>javascript:alert(1)</link></item>
    <item><title>Second</title><guid>https://b.com/2</guid></item></channel></rss>`;
  const items = parseFeed(rss);
  check('RSS: 2 valid items (bad ones dropped)', items.length === 2, String(items.length));
  check('RSS: CDATA + html stripped', items[0]?.title === 'Bitcoin ETF sees record inflows' && items[0]?.summary === 'Spot bitcoin ETFs & more');
  check('RSS: tracking params stripped, real params kept', items[0]?.url === 'https://a.com/x?id=1', items[0]?.url);
  check('RSS: date parsed', items[0]?.publishedAt?.toISOString() === '2026-10-02T10:00:00.000Z');
  check('RSS: guid used when link missing', items[1]?.url === 'https://b.com/2');
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom story</title><link rel="alternate" href="https://c.com/s"/>
    <summary>Hello</summary><updated>2026-10-02T09:00:00Z</updated></entry></feed>`;
  const a = parseFeed(atom);
  check('Atom: parsed', a.length === 1 && a[0]?.url === 'https://c.com/s' && a[0]?.summary === 'Hello');
  check('garbage input does not throw', parseFeed('<<<not xml').length === 0);

  // --------------------------------------------------------------- scoring
  section('news scoring and decisions');
  const now = new Date('2026-10-02T12:00:00Z');
  const ctx = { now, maxAgeHours: 12, trackedKeywords: [] as string[], usedTexts: [] as string[] };
  const mk = (title: string, summary: string, ageH: number, rel: number) => ({
    title, summary, url: 'https://x.com/' + encodeURIComponent(title), publishedAt: new Date(now.getTime() - ageH * 3_600_000), fetchedAt: now, sourceReliability: rel,
  });
  const big = S.scoreNews(mk('SEC approves spot Ethereum ETF, record $1.2 billion inflows on day one', 'The SEC approved the first spot Ethereum ETF; BlackRock and Fidelity report record inflows.', 1, 0.85), ctx);
  check('major story scores >= 0.7 confidence', big.confidence >= 0.7, JSON.stringify(big));
  check('major story decision POST', S.decideNews(big, { minConfidence: 0.7, confirmations: 0 }).decision === 'POST');
  const fluff = S.scoreNews(mk('Top 10 best crypto to buy now: price prediction', 'Sponsored guide', 1, 0.85), ctx);
  check('low-value listicle ignored', S.decideNews(fluff, { minConfidence: 0.7, confirmations: 0 }).decision === 'IGNORE');
  const offTopic = S.scoreNews(mk('Local bakery wins award for sourdough', 'Delicious bread', 1, 0.9), ctx);
  check('non-crypto ignored (relevance)', S.decideNews(offTopic, { minConfidence: 0.7, confirmations: 0 }).reason.includes('relevance'));
  const old = S.scoreNews(mk('SEC approves spot Ethereum ETF, record $1.2 billion inflows', 'x', 30, 0.85), ctx);
  check('stale story ignored', S.decideNews(old, { minConfidence: 0.7, confirmations: 0 }).reason === 'too old');
  const weak = S.scoreNews(mk('SEC approves spot Ethereum ETF, record $1.2 billion inflows on day one', 'BlackRock and Fidelity report record inflows.', 1, 0.6), ctx);
  check('low-reliability source waits for confirmation', S.decideNews(weak, { minConfidence: 0.5, confirmations: 0 }).decision === 'WAIT_FOR_CONFIRMATION', JSON.stringify(weak));
  check('...and posts once an independent source confirms', S.decideNews(weak, { minConfidence: 0.5, confirmations: 1 }).decision === 'POST');
  const dup = S.scoreNews(mk('SEC approves spot Ethereum ETF, record $1.2 billion inflows on day one', 'x', 1, 0.85), { ...ctx, usedTexts: ['SEC approves spot Ethereum ETF with record $1.2 billion inflows on day one'] });
  check('story we already posted is a duplicate', S.decideNews(dup, { minConfidence: 0.7, confirmations: 0 }).reason.includes('duplicates'));
  check('confirmation: other domain, same story', S.isConfirmation(
    { title: 'SEC approves spot Ethereum ETF with record inflows', url: 'https://a.com/1' },
    { title: 'Spot Ethereum ETF approved by SEC, record inflows reported', url: 'https://b.com/2' }));
  check('confirmation: same domain does not count', !S.isConfirmation(
    { title: 'SEC approves spot Ethereum ETF with record inflows', url: 'https://a.com/1' },
    { title: 'Spot Ethereum ETF approved by SEC, record inflows reported', url: 'https://www.a.com/2' }));
  // Calibration on realistic (not hand-crafted) headlines: the default threshold must keep good news and reject fluff.
  const realistic = (t: string, d: string, rel: number) => S.decideNews(S.scoreNews(mk(t, d, 2, rel), ctx), { minConfidence: 0.6, confirmations: 1 }).decision;
  check('realistic: earnings story passes at the 0.6 default', realistic('Coinbase Reports Third-Quarter Earnings Above Expectations', 'Coinbase posted higher trading revenue than analysts expected.', 0.85) === 'POST');
  check('realistic: treasury purchase passes', realistic('Strategy Buys Another 5,000 Bitcoin for $500 Million', 'The company disclosed the purchase in a filing.', 0.85) === 'POST');
  check('realistic: ETF delay passes', realistic('SEC Delays Decision on Spot XRP ETF Applications', 'The SEC pushed back its deadline on several XRP ETF filings.', 0.85) === 'POST');
  check('realistic: opinion piece is rejected', realistic('Why Stablecoin Regulation Matters for Banks, Says Analyst', 'An opinion piece on the stablecoin bill.', 0.75) === 'IGNORE');
  check('realistic: memoir excerpt is rejected', realistic('Binance Founder Releases Memoir Excerpt', 'A short excerpt was published.', 0.75) === 'IGNORE');
  check('realistic: off-topic prediction-market item is rejected', realistic('Polymarket Odds Show Traders Expect Rate Cut', 'Prediction market pricing points to a cut.', 0.8) === 'IGNORE');
  check('topic classification', S.classifyTopic('Hackers drain $20 million from DeFi protocol') === 'security');
  // Regressions found while calibrating against realistic headlines:
  check('topic: "billion" is not the word "bill" (regulation)', S.classifyTopic('Tether reserves hit $90 billion as stablecoin supply grows') === 'stablecoins');
  check('topic: "bank" is not the word "ban"', S.classifyTopic('Bank of Japan holds rates, yen steady') !== 'regulation');
  check('topic: headline wins over incidental summary words', S.scoreNews(mk('Dogecoin volume jumps 80% as Robinhood adds support', 'Volumes rose according to exchange data.', 1, 0.85), ctx).topic === 'memecoins');
  check('importance: "hackers"/"drain"/"stole" count as high-impact news',
    S.scoreImportance('Hackers drain $45 million from DeFi protocol', 'Attackers stole funds') > S.scoreImportance('Protocol updates its documentation page', 'Minor docs change'));

  // ---------------------------------------------------------- safety rules
  section('deterministic safety rules');
  const src = 'Bitcoin ETFs saw $1.2 billion in net inflows on Tuesday, a 15% rise from Monday, Ethereum also gained.';
  check('facts: numbers present in source pass', R.checkFacts('ETFs took in $1.2B, up 15%', src).ok);
  check('facts: invented number fails', !R.checkFacts('ETFs took in $2.5B', src).ok);
  check('facts: years and tiny ints are allowed', R.checkFacts('In 2026 the top 3 ETFs...', src).ok);
  check('facts: ticker alias ok ($BTC via bitcoin)', R.checkFacts('$BTC ETFs busy', src).ok);
  check('facts: ticker absent from source fails', !R.checkFacts('$DOGE ETFs busy', src).ok);
  check('duplicate: exact', !R.checkDuplicate('Hello World!', ['hello world']).ok);
  check('duplicate: near', !R.checkDuplicate('ETF inflows hit a record $1.2B on Tuesday', ['ETF inflows hit a record $1.2B on Tuesday morning']).ok);
  check('duplicate: different passes', R.checkDuplicate('Solana validators upgraded', ['ETF inflows hit a record']).ok);
  check('spam: giveaway', !R.checkSpam('Free crypto giveaway, DM me', 'post').ok);
  check('spam: wallet address', !R.checkSpam('send to 0x52908400098527886E0F7030069857D2E4169EE7', 'post').ok);
  check('spam: 2 hashtags', !R.checkSpam('news #btc #eth', 'post').ok);
  check('spam: link in a reply', !R.checkSpam('see https://x.com', 'reply').ok);
  check('spam: one link in a post is fine', R.checkSpam('news https://x.com', 'post').ok);
  check('spam: shouting', !R.checkSpam('BITCOIN IS ABSOLUTELY PUMPING RIGHT NOW EVERYONE', 'post').ok);
  check('spam: clean text passes', R.checkSpam('ETF inflows hit a record on Tuesday, per CoinDesk.', 'post').ok);
  check('advice: "you should buy"', !R.checkAdvice('you should buy the dip').ok);
  check('advice: price prediction', !R.checkAdvice('BTC will hit $200k').ok);
  check('advice: neutral news passes', R.checkAdvice('ETF inflows hit a record on Tuesday').ok);
  check('length: a long URL that X counts as 23 but is over 280 raw characters is refused (the database caps raw length)', !R.checkLength('a'.repeat(250) + ' https://example.com/' + 'x'.repeat(40)).ok);
  check('length: 281 fails, 280 passes', !R.checkLength('a'.repeat(281)).ok && R.checkLength('a'.repeat(280)).ok);
  check('risk: hack is MEDIUM', R.riskFloor('Protocol hacked, $20M drained').level === 'MEDIUM');
  check('risk: tragedy is HIGH', R.riskFloor('founder dies in accident').level === 'HIGH');
  check('risk: plain news LOW', R.riskFloor('ETF inflows hit a record').level === 'LOW');

  // ---------------------------------------------------------------- crypto
  section('token encryption at rest');
  const key = 'a'.repeat(64);
  const enc = C.encryptSecret('refresh-token-123', key);
  check('encrypted looks encrypted', enc.startsWith('enc:v1:') && !enc.includes('refresh-token-123'));
  check('round trip', C.decryptSecret(enc, key) === 'refresh-token-123');
  check('no key = plain text passthrough', C.encryptSecret('abc', undefined) === 'abc' && C.decryptSecret('abc', undefined) === 'abc');
  check('wrong key fails', (await expectThrows(async () => C.decryptSecret(enc, 'b'.repeat(64)))) !== null);
  const tampered = enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  check('tampering is detected (GCM tag)', (await expectThrows(async () => C.decryptSecret(tampered, key))) !== null);
  check('encrypted without key configured throws', (await expectThrows(async () => C.decryptSecret(enc, undefined))) !== null);
  check('bad key length rejected', (await expectThrows(async () => C.encryptSecret('x', 'abcd'))) !== null);

  // ------------------------------------------------------------------ time
  section('active hours');
  const win = [{ start: '08:00', end: '23:00' }];
  check('inside window (Rome 12:00 = 10:00Z)', TM.isWithinActiveHours(new Date('2026-10-02T10:00:00Z'), win, 'Europe/Rome'));
  check('outside window (Rome 03:00 = 01:00Z)', !TM.isWithinActiveHours(new Date('2026-10-02T01:00:00Z'), win, 'Europe/Rome'));
  const night = [{ start: '22:00', end: '06:00' }];
  check('overnight window: 23:00 inside, 12:00 outside', TM.isWithinActiveHours(new Date('2026-10-02T23:00:00Z'), night, 'UTC') && !TM.isWithinActiveHours(new Date('2026-10-02T12:00:00Z'), night, 'UTC'));
  check('no windows = always active', TM.isWithinActiveHours(new Date(), [], 'UTC'));
  const next = TM.nextActiveTime(new Date('2026-10-02T01:00:00Z'), win, 'Europe/Rome');
  check('nextActiveTime lands at 08:00 Rome (06:00Z)', next.toISOString() === '2026-10-02T06:00:00.000Z', next.toISOString());
  check('activeMinutesPerDay', TM.activeMinutesPerDay(win) === 900 && TM.activeMinutesPerDay(night) === 480);

  // ------------------------------------------------------- llm json + misc
  section('LLM JSON parsing, settings schema, dashboard auth, mix, prefilter');
  const sch = z.object({ a: z.number() });
  check('JSON inside code fence + prose', parseJsonReply('Sure!\n```json\n{"a": 1}\n```', sch).a === 1);
  check('no JSON throws', (await expectThrows(async () => parseJsonReply('nope', sch))) !== null);
  check('wrong shape throws', (await expectThrows(async () => parseJsonReply('{"a":"x"}', sch))) !== null);
  check('settings: max_posts_per_day 7 rejected (hard cap 6)', !SETTING_SCHEMAS.max_posts_per_day.safeParse(7).success && SETTING_SCHEMAS.max_posts_per_day.safeParse(4).success);
  check('settings: max_total 17 rejected', !SETTING_SCHEMAS.max_total_per_day.safeParse(17).success);
  check('settings: bad active_hours rejected', !SETTING_SCHEMAS.active_hours.safeParse([{ start: '25:00', end: '01:00' }]).success);
  const bearer = 'Bearer tok-1234567890abcdef';
  check('dashboard auth: bearer ok', isAuthorized(bearer, 'tok-1234567890abcdef'));
  check('dashboard auth: basic ok', isAuthorized('Basic ' + Buffer.from('anyone:tok-1234567890abcdef').toString('base64'), 'tok-1234567890abcdef'));
  check('dashboard auth: wrong token', !isAuthorized('Bearer nope', 'tok-1234567890abcdef'));
  check('dashboard auth: no token configured = closed', !isAuthorized(bearer, undefined));
  check('dashboard auth: no header', !isAuthorized(undefined, 'tok-1234567890abcdef'));
  check('mix: breaking overrides', pickPostType({ confidence: 0.9, importance: 0.8, breakingThreshold: 0.85, professionalRatio: 0.5, recentTypes: [], random: 0.1 }) === 'breaking');
  check('mix: rebalances toward ratio', pickPostType({ confidence: 0.7, importance: 0.5, breakingThreshold: 0.85, professionalRatio: 0.5, recentTypes: ['professional', 'professional', 'professional', 'professional', 'degen'], random: 0.1 }) === 'degen');
  const settings = { maxPostsPerDay: 6, maxTotalPerDay: 16, activeHours: win, minGapMinutes: 90 } as Parameters<typeof computeNextPostGapMinutes>[0];
  const g = computeNextPostGapMinutes(settings, 0.5);
  check('post gap: spread over active window, >= min gap', g >= 90 && g <= 900 / 6 * 1.4, String(g));
  const t0 = new Date('2026-10-02T12:00:00Z');
  check('prefilter: too short', prefilterTweet({ text: '@bot gm', created_at_x: t0, source: 'mention' }, t0) !== null);
  check('prefilter: stale tracked tweet', prefilterTweet({ text: 'Interesting take on ETF flows today', created_at_x: new Date(t0.getTime() - 5 * 3_600_000), source: 'tracked_account' }, t0) !== null);
  check('prefilter: old mention still ok (<24h)', prefilterTweet({ text: 'Why did ETF flows jump so much today?', created_at_x: new Date(t0.getTime() - 5 * 3_600_000), source: 'mention' }, t0) === null);
  check('prefilter: shill keywords', prefilterTweet({ text: 'GEM ALERT 100x presale live now', created_at_x: t0, source: 'tracked_account' }, t0) !== null);

  // ----------------------------------------------------------------- oauth
  section('OAuth PKCE + token endpoint (local fake server)');
  const seen: Array<{ auth?: string; body: URLSearchParams }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = new URLSearchParams(raw);
      seen.push({ auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (body.get('refresh_token') === 'dead') { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid_grant' })); return; }
      if (body.get('refresh_token') === 'boom') { res.statusCode = 503; res.end('{}'); return; }
      res.end(JSON.stringify({ access_token: 'AT-' + (body.get('grant_type') ?? ''), refresh_token: 'RT-new', expires_in: 7200, scope: 'tweet.read tweet.write' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  // oauth.ts reads config at import time, so load a fresh copy with the env pointing at the fake server
  process.env.X_API_BASE = `http://127.0.0.1:${port}`;
  process.env.X_CLIENT_ID = 'cid';
  process.env.X_CLIENT_SECRET = 'csecret';
  for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k];
  const O = require('../src/x/oauth') as typeof import('../src/x/oauth');

  const p = O.createPkce();
  check('PKCE verifier length 43-128', p.verifier.length >= 43 && p.verifier.length <= 128);
  check('PKCE challenge = base64url(sha256(verifier))', p.challenge === createHash('sha256').update(p.verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  const url = new URL(O.buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:3000/callback', state: p.state, challenge: p.challenge }));
  check('auth URL has S256 challenge, state and offline.access', url.searchParams.get('code_challenge_method') === 'S256' && url.searchParams.get('state') === p.state && (url.searchParams.get('scope') ?? '').includes('offline.access'));
  const t1 = await O.exchangeCode('CODE', 'VERIFIER', new Date('2026-10-02T12:00:00Z'));
  check('code exchange: tokens parsed', t1.accessToken === 'AT-authorization_code' && t1.refreshToken === 'RT-new' && t1.expiresAt.toISOString() === '2026-10-02T14:00:00.000Z');
  const last = seen[seen.length - 1]!;
  check('code exchange: Basic auth + verifier sent', last.auth === 'Basic ' + Buffer.from('cid:csecret').toString('base64') && last.body.get('code_verifier') === 'VERIFIER' && last.body.get('grant_type') === 'authorization_code');
  const t2 = await O.refreshAccessToken('RT-old');
  check('refresh: rotated refresh token returned', t2.refreshToken === 'RT-new' && seen[seen.length - 1]!.body.get('grant_type') === 'refresh_token');
  const deadErr = await O.refreshAccessToken('dead').catch((e: unknown) => e);
  check('refresh: invalid_grant is flagged definitive', deadErr instanceof O.TokenError && deadErr.invalidGrant);
  const boomErr = await O.refreshAccessToken('boom').catch((e: unknown) => e);
  check('refresh: 503 is transient (not invalidGrant)', boomErr instanceof O.TokenError && !boomErr.invalidGrant);
  server.close();

  section('environment fallbacks (clean child processes)');
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const probe = (env: Record<string, string>): { db: string; redirect: string } => {
    const out = execFileSync('npx', ['tsx', '-e', "const {config}=require('./src/config/env');console.log(JSON.stringify({db:config.db.url,redirect:config.x.redirectUri}))"], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', ...env }, encoding: 'utf8', cwd: process.cwd(),
    });
    return JSON.parse(out.trim().split('\n').pop()!) as { db: string; redirect: string };
  };
  const a1 = probe({ POSTGRES_URL: 'postgres://from-vercel/db' });
  check('DATABASE_URL falls back to POSTGRES_URL (Vercel integrations)', a1.db === 'postgres://from-vercel/db');
  const a2 = probe({ DATABASE_URL: 'postgres://explicit/db', POSTGRES_URL: 'postgres://other/db' });
  check('DATABASE_URL wins when both are set', a2.db === 'postgres://explicit/db');
  const a3 = probe({ DATABASE_URL: 'postgres://x/db', VERCEL_PROJECT_PRODUCTION_URL: 'my-bot.vercel.app' });
  check('X_REDIRECT_URI defaults to the Vercel production URL', a3.redirect === 'https://my-bot.vercel.app/api/x-callback');
  const a4 = probe({ DATABASE_URL: 'postgres://x/db', VERCEL_PROJECT_PRODUCTION_URL: 'my-bot.vercel.app', X_REDIRECT_URI: 'https://custom.example/api/x-callback' });
  check('explicit X_REDIRECT_URI wins', a4.redirect === 'https://custom.example/api/x-callback');
  const a5 = probe({ DATABASE_URL: 'postgres://x/db' });
  check('local default redirect when not on Vercel', a5.redirect === 'http://127.0.0.1:3000/callback');

  section('dashboard page script');
  const { dashboardHtml } = require('../src/dashboard/html') as typeof import('../src/dashboard/html');
  const pageHtml = dashboardHtml('testnonce');
  const pageJs = pageHtml.split('<script nonce="testnonce">')[1]!.split('</script>')[0]!;
  let pageParses = true;
  let pageErr = '';
  try { new Function(pageJs); } catch (e) { pageParses = false; pageErr = (e as Error).message; }
  check('the dashboard inline script is valid JavaScript (a syntax error leaves a blank page with no tabs)', pageParses, pageErr);
  check('every tab named in the script has a view', ['Setup', 'Overview', 'Approvals', 'Activity', 'News', 'Posts', 'Replies', 'Settings'].every((t) => new RegExp(`async ${t}\\(`).test(pageJs)));
  check('the page script never uses innerHTML (untrusted text is rendered with textContent)', !pageJs.includes('innerHTML'));

  section('Anthropic request body (current Claude models reject temperature)');
  const { anthropicBody } = require('../src/llm/client') as typeof import('../src/llm/client');
  const rq = { system: 's', user: 'u', maxTokens: 400, temperature: 0.8, purpose: 'x' };
  const modern = anthropicBody('claude-sonnet-7-1', rq) as { max_tokens: number; temperature?: number; output_config?: { effort: string } };
  check('never sends temperature, even when the caller asked for one', !('temperature' in modern) && !('top_p' in modern));
  check('a current reasoning model runs at low effort by default', modern.output_config?.effort === 'low');
  check('...with headroom for reasoning tokens (they count against max_tokens)', modern.max_tokens === 3400);
  const older = anthropicBody('claude-haiku-3-5', rq) as { max_tokens: number; output_config?: unknown };
  check('an older model gets no effort field (it would be rejected) and no headroom', older.output_config === undefined && older.max_tokens === 400);
  check('LLM_EFFORT=none disables effort even on a current model', (anthropicBody('claude-opus-9', rq, 'none') as { output_config?: unknown }).output_config === undefined);
  check('LLM_EFFORT=medium overrides the default', (anthropicBody('claude-opus-9', rq, 'medium') as { output_config: { effort: string } }).output_config.effort === 'medium');
  check('LLM_EFFORT is honoured on an older-looking id when set explicitly', (anthropicBody('claude-haiku-3-5', rq, 'high') as { output_config: { effort: string } }).output_config.effort === 'high');
  check('system prompt and user message are passed through', (anthropicBody('claude-opus-9', rq) as { system: string; messages: Array<{ role: string; content: string }> }).system === 's');

  section('OpenAI-compatible provider (xAI, Groq, OpenRouter, ...)');
  const { openaiUrl, openaiBody, parseOpenAiReply, LlmUnavailableError: LlmErr } = require('../src/llm/client') as typeof import('../src/llm/client');
  check('url: xAI documented base "https://api.x.ai/v1" is not doubled to /v1/v1', openaiUrl('https://api.x.ai/v1') === 'https://api.x.ai/v1/chat/completions');
  check('url: bare host gets /v1/chat/completions', openaiUrl('https://api.x.ai') === 'https://api.x.ai/v1/chat/completions');
  check('url: trailing slash tolerated', openaiUrl('https://api.x.ai/v1/') === 'https://api.x.ai/v1/chat/completions');
  check('url: a full chat/completions URL is used as is', openaiUrl('https://h.example/v1/chat/completions') === 'https://h.example/v1/chat/completions');
  check('url: Gemini-style ".../v1beta/openai" base', openaiUrl('https://generativelanguage.googleapis.com/v1beta/openai') === 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  check('url: Groq-style ".../openai/v1" base', openaiUrl('https://api.groq.com/openai/v1') === 'https://api.groq.com/openai/v1/chat/completions');
  check('url: OpenRouter-style base without /v1 gets the suffix', openaiUrl('https://openrouter.ai/api') === 'https://openrouter.ai/api/v1/chat/completions');
  check('url: default is OpenAI', openaiUrl(undefined) === 'https://api.openai.com/v1/chat/completions');
  const ob = openaiBody('some-model', { system: 's', user: 'u', maxTokens: 400, temperature: 0.8, purpose: 'x' }, { sendTemperature: true }) as { max_tokens: number; temperature?: number; reasoning_effort?: string; messages: Array<{ role: string }> };
  check('body: headroom for reasoning tokens', ob.max_tokens === 2900);
  check('body: temperature sent by default, system+user messages', ob.temperature === 0.8 && ob.messages.map((m) => m.role).join() === 'system,user');
  check('body: no reasoning_effort unless asked', ob.reasoning_effort === undefined);
  check('body: LLM_SEND_TEMPERATURE=false omits temperature', !('temperature' in (openaiBody('m', { system: 's', user: 'u', maxTokens: 10, temperature: 0, purpose: 'x' }, { sendTemperature: false }))));
  check('body: LLM_EFFORT=low becomes reasoning_effort', (openaiBody('m', { system: 's', user: 'u', maxTokens: 10, purpose: 'x' }, { sendTemperature: true, effort: 'low' }) as { reasoning_effort?: string }).reasoning_effort === 'low');
  check('body: Claude-only levels (xhigh/max/none) are never sent', !('reasoning_effort' in openaiBody('m', { system: 's', user: 'u', maxTokens: 10, purpose: 'x' }, { sendTemperature: true, effort: 'max' })) && !('reasoning_effort' in openaiBody('m', { system: 's', user: 'u', maxTokens: 10, purpose: 'x' }, { sendTemperature: true, effort: 'none' })));
  const okReply = parseOpenAiReply({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 400 } });
  check('reply: text parsed', okReply.text === 'hi' && okReply.inputTokens === 100);
  check('reply: reasoning tokens excluded from completion_tokens are still counted (total - prompt)', okReply.outputTokens === 300, String(okReply.outputTokens));
  check('reply: when completion_tokens already includes them, nothing is double counted', parseOpenAiReply({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 100, completion_tokens: 300, total_tokens: 400 } }).outputTokens === 300);
  check('reply: missing usage is tolerated', parseOpenAiReply({ choices: [{ message: { content: 'x' } }] }).outputTokens === 0);
  check('reply: finish_reason "length" is a clear error that suggests LLM_EFFORT', (await expectThrows(async () => parseOpenAiReply({ choices: [{ message: { content: '{"a"' }, finish_reason: 'length' }] }))) !== null);
  check('reply: content_filter is reported as such', /filtered/.test((await expectThrows(async () => parseOpenAiReply({ choices: [{ message: { content: null }, finish_reason: 'content_filter' }] }))) ?? ''));
  check('reply: errors are LlmUnavailableError (retried later, never published)', await (async () => { try { parseOpenAiReply({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }); return false; } catch (e) { return e instanceof LlmErr; } })());

  section('each serverless entry point starts WITHOUT the sql/ folder (the x-connect incident)');
  const { mkdtempSync, cpSync, symlinkSync, rmSync: rmTmp, writeFileSync } = require('fs') as typeof import('fs');
  const { join: pjoin } = require('path') as typeof import('path');
  const { tmpdir: osTmp } = require('os') as typeof import('os');
  // A bundle like Vercel's for functions that do not list includeFiles: code and node_modules, no sql/.
  const bundle = mkdtempSync(pjoin(osTmp(), 'bundle-'));
  cpSync('src', pjoin(bundle, 'src'), { recursive: true });
  cpSync('api', pjoin(bundle, 'api'), { recursive: true });
  cpSync('package.json', pjoin(bundle, 'package.json'));
  cpSync('tsconfig.json', pjoin(bundle, 'tsconfig.json'));
  symlinkSync(pjoin(process.cwd(), 'node_modules'), pjoin(bundle, 'node_modules'), 'dir');
  writeFileSync(pjoin(bundle, 'probe.ts'), `
    const http = require('http');
    const [, , file, path] = process.argv;
    const h = require('./api/' + file + '.ts').default;
    const s = http.createServer((q, r) => h(q, r)).listen(0, '127.0.0.1', async () => {
      const res = await fetch('http://127.0.0.1:' + s.address().port + path);
      console.log(JSON.stringify({ status: res.status, body: (await res.text()).slice(0, 300) }));
      s.close(); process.exit(0);
    });`);
  const probeBundle = (file: string, path: string) => {
    const out = execFileSync('npx', ['tsx', 'probe.ts', file, path], {
      cwd: bundle, encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', DATABASE_URL: 'postgres://x/y', DASHBOARD_TOKEN: 'tok-1234567890abcdef', CRON_SECRET: 'cron-secret-1234567890', X_CLIENT_ID: 'cid' },
    });
    return JSON.parse(out.trim().split('\n').pop()!) as { status: number; body: string };
  };
  const bx = probeBundle('x-connect', '/api/x-connect');
  check('x-connect (no sql/ in the bundle) answers 401 asking for the password, not "failed to start"', bx.status === 401 && !/failed to start|sql\/ directory/.test(bx.body), JSON.stringify(bx));
  const bcb = probeBundle('x-callback', '/api/x-callback?code=a&state=b');
  check('x-callback (no sql/) answers 400 "invalid callback", not a crash', bcb.status === 400 && /Invalid callback/.test(bcb.body), JSON.stringify(bcb));
  const bt = probeBundle('tick', '/api/tick');
  check('tick (no sql/) answers 401, not a crash', bt.status === 401, JSON.stringify(bt));
  const bd = probeBundle('dashboard', '/api/dashboard');
  check('dashboard page (no sql/) still serves the login prompt', bd.status === 401, JSON.stringify(bd));
  rmTmp(bundle, { recursive: true, force: true });

  section('plain-language hints for X refusals');
  const { describeXRejection } = require('../src/x/client') as typeof import('../src/x/client');
  const credits = describeXRejection(402, '{"detail":"credits depleted","status":402,"title":"Payment Required","type":"https://api.x.com/2/problems/credits-depleted"}') ?? '';
  check('402 credits depleted (the owner\'s real error) says to buy credits', /credits/i.test(credits) && /Buy Credits/.test(credits));
  check('401 says to reconnect', /reconnect/i.test(describeXRejection(401, '') ?? ''));
  check('429 says the bot backs off', /back/i.test(describeXRejection(429, '') ?? ''));
  check('403 duplicate vs other 403 are told apart', /duplicate/i.test(describeXRejection(403, 'duplicate content') ?? '') && /Read and write/.test(describeXRejection(403, 'forbidden') ?? ''));
  check('unknown statuses get no invented advice', describeXRejection(418, 'teapot') === undefined);

  section('Vercel deploy config');
  const fs = require('fs') as typeof import('fs');
  const vj = JSON.parse(fs.readFileSync('vercel.json', 'utf8')) as { outputDirectory?: string; buildCommand?: string; functions?: Record<string, { includeFiles?: string }>; crons?: Array<{ path: string; schedule: string }> };
  check('vercel.json: outputDirectory exists (the "No Output Directory named public" error)', !!vj.outputDirectory && fs.existsSync(vj.outputDirectory) && fs.statSync(vj.outputDirectory).isDirectory());
  check('vercel.json: public/ has an index.html that sends visitors to the dashboard', fs.existsSync('public/index.html') && fs.readFileSync('public/index.html', 'utf8').includes('/api/dashboard'));
  check('vercel.json: no heavy build step (Vercel compiles api/*.ts itself)', !!vj.buildCommand && !/tsc|npm run build/.test(vj.buildCommand));
  check('vercel.json: every function file exists', Object.keys(vj.functions ?? {}).every((f) => fs.existsSync(f)));
  check('vercel.json: dashboard function bundles the sql/ migrations', vj.functions?.['api/dashboard.ts']?.includeFiles === 'sql/**' && fs.existsSync('sql/001_init.sql'));
  check('vercel.json: cron is daily (the only schedule Hobby accepts)', (vj.crons ?? []).every((c) => /^\d+ \d+ \* \* \*$/.test(c.schedule)) && (vj.crons ?? []).every((c) => fs.existsSync(`api/${c.path.replace('/api/', '')}.ts`)));

  section('database variable discovery (Vercel adds a prefix such as storage_)');
  const { findDatabaseUrl } = require('../src/config/env') as typeof import('../src/config/env');
  const U = 'postgres://u:p@h.example/db?sslmode=require';
  const pick = (env: Record<string, string>) => findDatabaseUrl(env as NodeJS.ProcessEnv)?.name;
  check('explicit DATABASE_URL wins over everything', pick({ DATABASE_URL: U, storage_DATABASE_URL: U, POSTGRES_URL: U }) === 'DATABASE_URL');
  check('then POSTGRES_URL', pick({ POSTGRES_URL: U, storage_DATABASE_URL: U }) === 'POSTGRES_URL');
  check('the exact variable set Vercel/Neon created in this project: storage_DATABASE_URL (pooled) is chosen',
    pick({ storage_NEON_PROJECT_ID: 'x', storage_POSTGRES_HOST: 'h', storage_POSTGRES_PASSWORD: 'p', storage_POSTGRES_PRISMA_URL: U, storage_POSTGRES_URL_NON_POOLING: U,
           storage_DATABASE_URL: U, storage_DATABASE_URL_UNPOOLED: U, storage_POSTGRES_URL: U, storage_POSTGRES_URL_NO_SSL: U }) === 'storage_DATABASE_URL');
  check('only POSTGRES_URL with a prefix works too', pick({ storage_POSTGRES_URL: U, storage_POSTGRES_URL_NON_POOLING: U }) === 'storage_POSTGRES_URL');
  check('unpooled / non-pooling / no-ssl / prisma variants alone are NOT used', pick({ storage_DATABASE_URL_UNPOOLED: U, storage_POSTGRES_URL_NON_POOLING: U, storage_POSTGRES_URL_NO_SSL: U, storage_POSTGRES_PRISMA_URL: U }) === undefined);
  check('values that are not postgres URLs are ignored', pick({ DATABASE_URL: 'not-a-url', storage_DATABASE_URL: 'mysql://x' }) === undefined);
  check('prefix case does not matter', pick({ MY_DB_DATABASE_URL: U }) === 'MY_DB_DATABASE_URL');
  const prefixed = probe({ storage_DATABASE_URL: 'postgres://prefixed/db', storage_DATABASE_URL_UNPOOLED: 'postgres://unpooled/db' });
  check('config really loads from storage_DATABASE_URL (clean process)', prefixed.db === 'postgres://prefixed/db', JSON.stringify(prefixed));

  section('crash-proof serverless loading (the FUNCTION_INVOCATION_FAILED incident)');
  const { lazyHandler, summarizeBootError } = require('../src/lib/boot') as typeof import('../src/lib/boot');
  const { describeDbError } = require('../src/lib/dberror') as typeof import('../src/lib/dberror');
  const fakeRes = () => {
    const r = { status: 0, headers: {} as Record<string, string>, body: '', headersSent: false,
      writeHead(s: number, h: Record<string, string>) { r.status = s; r.headers = h; r.headersSent = true; return r; },
      end(b?: string) { r.body = b ?? ''; } };
    return r;
  };
  const fakeReq = (accept = 'text/html') => ({ headers: { accept } }) as unknown as import('http').IncomingMessage;
  const sum = summarizeBootError(new Error('Invalid environment configuration:\n  - DATABASE_URL: required\n  - DATABASE_SSL: expected "true"|"false"'));
  check('boot: config errors list the variable names', sum.kind === 'config' && sum.lines.length === 2 && sum.lines[0]!.startsWith('DATABASE_URL'));
  const page1 = fakeRes();
  await lazyHandler(() => { throw new Error('Invalid environment configuration:\n  - DATABASE_URL: required'); })(fakeReq(), page1 as unknown as import('http').ServerResponse);
  check('boot: a config failure returns a readable 500 page, not a crash', page1.status === 500 && page1.body.includes('DATABASE_URL') && page1.body.includes('Environment Variables'));
  const json1 = fakeRes();
  await lazyHandler(() => { throw new Error('Invalid environment configuration:\n  - DATABASE_URL: required'); })(fakeReq('application/json'), json1 as unknown as import('http').ServerResponse);
  check('boot: JSON clients get JSON', json1.status === 500 && JSON.parse(json1.body).details[0].startsWith('DATABASE_URL'));
  process.env.SUPERSECRET_TOKEN = 'zzz-secret-value-123456';
  const leak = fakeRes();
  await lazyHandler(() => { throw new Error('boom zzz-secret-value-123456 inside'); })(fakeReq(), leak as unknown as import('http').ServerResponse);
  check('boot: secret values are scrubbed from the page', !leak.body.includes('zzz-secret-value-123456'));
  delete process.env.SUPERSECRET_TOKEN;
  const xss = fakeRes();
  await lazyHandler(() => { throw new Error('Invalid environment configuration:\n  - <script>alert(1)</script>: bad'); })(fakeReq(), xss as unknown as import('http').ServerResponse);
  check('boot: output is HTML-escaped', !xss.body.includes('<script>alert') && xss.body.includes('&lt;script&gt;'));
  let loads = 0;
  const good = lazyHandler(() => { loads++; return (_q, r) => { (r as unknown as ReturnType<typeof fakeRes>).writeHead(200, {}); (r as unknown as ReturnType<typeof fakeRes>).end('hi'); }; });
  const g1 = fakeRes(); const g2 = fakeRes();
  await good(fakeReq(), g1 as unknown as import('http').ServerResponse);
  await good(fakeReq(), g2 as unknown as import('http').ServerResponse);
  check('boot: a healthy handler is loaded once and used', g1.status === 200 && g2.body === 'hi' && loads === 1);
  const thrower = fakeRes();
  await lazyHandler(() => () => { throw new Error('db exploded'); })(fakeReq(), thrower as unknown as import('http').ServerResponse);
  check('boot: a handler that throws becomes a clean 500, not FUNCTION_INVOCATION_FAILED', thrower.status === 500 && !thrower.body.includes('db exploded'));
  check('dberror: wrong password', /login/.test(describeDbError({ code: '28P01' }) ?? ''));
  check('dberror: SSL hint', /DATABASE_SSL/.test(describeDbError(new Error('The server does not support SSL connections')) ?? ''));
  check('dberror: unreachable (also inside an AggregateError)', /Cannot reach/.test(describeDbError({ errors: [{ code: 'ECONNREFUSED' }] }) ?? ''));
  check('dberror: unknown errors reveal nothing', describeDbError(new Error('password=hunter2 something odd')) === undefined);

  // Replay of the incident against the REAL entry point: no env at all, real HTTP server.
  const replay = (env: Record<string, string>, route = '/api/dashboard'): { status: number; body: string } => {
    const script = `
      const http=require('http');
      const h=require('./api/${route.split('/')[2]}.ts').default;
      const s=http.createServer((q,r)=>h(q,r)).listen(0,'127.0.0.1',async()=>{
        const res=await fetch('http://127.0.0.1:'+s.address().port+'${route}');
        console.log(JSON.stringify({status:res.status,body:(await res.text()).slice(0,600)}));
        s.close(); process.exit(0);
      });`;
    const out = execFileSync('npx', ['tsx', '-e', script], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', ...env }, encoding: 'utf8', cwd: process.cwd() });
    return JSON.parse(out.trim().split('\n').pop()!) as { status: number; body: string };
  };
  const noEnv = replay({});
  check('REPLAY: dashboard with NO environment variables answers 500 with a clear page naming DATABASE_URL', noEnv.status === 500 && noEnv.body.includes('DATABASE_URL') && noEnv.body.includes('Environment Variables'), JSON.stringify(noEnv));
  const badBool = replay({ DATABASE_URL: 'postgres://x/y', DATABASE_SSL: 'yes' });
  check('REPLAY: a mistyped variable names the culprit', badBool.status === 500 && badBool.body.includes('DATABASE_SSL'), JSON.stringify(badBool));
  const noToken = replay({ DATABASE_URL: 'postgres://x/y' });
  check('REPLAY: valid config but no DASHBOARD_TOKEN -> explains how to enable (503)', noToken.status === 503 && noToken.body.includes('DASHBOARD_TOKEN'), JSON.stringify(noToken));
  const tickNoEnv = replay({}, '/api/tick');
  check('REPLAY: /api/tick with no environment is also a readable 500', tickNoEnv.status === 500 && tickNoEnv.body.includes('DATABASE_URL'), JSON.stringify(tickNoEnv));

  section('reply scope');
  const { replyCriteria, personaSystem } = require('../src/llm/content') as typeof import('../src/llm/content');
  const cryptoCrit = replyCriteria('crypto');
  const generalCrit = replyCriteria('general');
  check('crypto scope: replies only to crypto discussion (unchanged)', /substantive crypto discussion/.test(cryptoCrit) && !/everyday topic/.test(cryptoCrit));
  check('general scope: everyday topics allowed', /everyday topic/.test(generalCrit) && !/substantive crypto discussion/.test(generalCrit));
  check('both scopes keep politics / trolling / shilling / advice-bait on the IGNORE list', [cryptoCrit, generalCrit].every((c) => /politics/.test(c) && /trolling/.test(c) && /shilling/.test(c) && /price-prediction bait/.test(c)));
  check('general scope: any topic, politics/health only in the IMO format, still ignores self-harm, diagnosis, legal advice and tragedies', /IMO/.test(generalCrit) && /self-harm/.test(generalCrit) && /diagnosis, dose or treatment/.test(generalCrit) && /legal advice/.test(generalCrit) && /tragedies/.test(generalCrit) && /invent personal anecdotes/.test(generalCrit));
  check('persona says "about crypto" only in crypto scope', /about crypto/.test(personaSystem('x', 'crypto')) && !/about crypto/.test(personaSystem('x', 'general')));
  check('persona keeps the hard rules in both scopes', /No financial advice/.test(personaSystem('x', 'general')) && /No politics/.test(personaSystem('x', 'general')));
  check('reply_scope setting only accepts crypto|general', SETTING_SCHEMAS.reply_scope.safeParse('general').success && !SETTING_SCHEMAS.reply_scope.safeParse('anything').success);

  section('reply facts');
  const { pickRelevantNews } = require('../src/engine/replyEngine') as typeof import('../src/engine/replyEngine');
  const newsItems = [
    { title: 'Spot Ether ETFs record $1.2 billion inflows', summary: 'Friday saw the largest daily inflows since launch.', source: 'CoinDesk' },
    { title: 'Local bakery wins award', summary: 'Sourdough', source: 'Bread Weekly' },
    { title: 'Bitcoin miners add hashrate', summary: null, source: 'The Block' },
  ];
  const picked = pickRelevantNews('why did etf inflows spike the last friday', newsItems);
  check('a question about ETF inflows picks the matching story, not the bakery', picked.length === 1 && /Spot Ether ETFs/.test(picked[0]!) && /CoinDesk/.test(picked[0]!), JSON.stringify(picked));
  check('a single shared word is not enough (no weak matches)', pickRelevantNews('bitcoin is great', newsItems).length === 0);
  check('no usable words -> no facts', pickRelevantNews('why did the', newsItems).length === 0);
  const sysReply = personaSystem('x', 'general', true);
  check('reply mode: concepts may use general knowledge, specifics need the FACTS', /FACTS provided/.test(sysReply) && /general knowledge/.test(sysReply));
  check('post mode keeps the strict only-the-material rule', /ONLY facts present in the provided material/.test(personaSystem('x', 'crypto')) && !/general knowledge/.test(personaSystem('x', 'crypto')));
  check('reply mode still bans advice and invented numbers, and puts politics/health behind the IMO format', /No financial advice/.test(sysReply) && /never invent them/.test(sysReply) && /start the reply with "IMO,"/.test(sysReply) && /not a doctor/.test(sysReply) && /not a politician/.test(sysReply));

  section('custom rules');
  const CU = require('../src/safety/custom') as typeof import('../src/safety/custom');
  const rule = (kind: 'block_output' | 'skip_input' | 'require_approval' | 'instruction', text: string, target: 'post' | 'reply' | 'both' = 'both') => ({ id: 'abcdef12', kind, target, text });
  check('phrases match case-insensitively on word boundaries', CU.phraseRegex('moon').test('To the MOON') && !CU.phraseRegex('moon').test('honeymooner'));
  check('regex characters in a phrase are literal (cannot hang or break)', CU.phraseRegex('a+b(').test('see a+b( here') && !CU.phraseRegex('.*').test('anything'));
  check('target filter: a reply-only rule does not touch posts', CU.findCustomMatch([rule('block_output', 'moon', 'reply')], 'block_output', 'post', 'moon') === undefined && CU.findCustomMatch([rule('block_output', 'moon', 'reply')], 'block_output', 'reply', 'moon') !== undefined);
  check('kind filter: a skip rule never blocks output', CU.findCustomMatch([rule('skip_input', 'moon')], 'block_output', 'post', 'moon') === undefined);
  check('instructions are collected per target', CU.instructionsFor([rule('instruction', 'Be brief', 'reply'), rule('instruction', 'No jokes', 'post')], 'reply').join() === 'Be brief');
  check('persona prompt carries owner instructions and still says the hard rules win', /OWNER INSTRUCTIONS/.test(personaSystem('x', 'crypto', false, ['Be brief'])) && /HARD RULES above always win/.test(personaSystem('x', 'crypto', false, ['Be brief'])) && !/OWNER INSTRUCTIONS/.test(personaSystem('x')));
  check('a disabled switchable rule stops forcing approval; HIGH rules cannot be disabled', R.riskFloorFor(['risk.politics'], 'new election results').level === 'LOW' && R.riskFloorFor(R.SWITCHABLE_RULE_IDS, 'founder dies').level === 'HIGH');
  check('exactly the 5 approval-only built-ins are switchable', R.SWITCHABLE_RULE_IDS.length === 5 && R.builtinCatalog().filter((b) => !b.locked).length === 5);
  check('tweet prefilter honours a skip rule', prefilterTweet({ text: 'soon wen moon for everyone', created_at_x: new Date(), source: 'tracked_account' }, new Date(), [rule('skip_input', 'wen moon', 'reply')])?.includes('your rule') === true);

  section('LLM deadline');
  const { callTimeoutMs, withDeadline } = require('../src/llm/client') as typeof import('../src/llm/client');
  check('no deadline: the usual 60 s timeout', callTimeoutMs({}) === 60_000);
  check('a deadline 30 s away shortens the timeout to leave a margin', callTimeoutMs({ deadlineMs: 1_030_000 }, 1_000_000) === 28_000);
  check('a far deadline never lengthens it past 60 s', callTimeoutMs({ deadlineMs: 9_000_000 }, 1_000_000) === 60_000);
  check('under 4 s left: the call is refused instead of causing a 504', (() => { try { callTimeoutMs({ deadlineMs: 1_003_000 }, 1_000_000); return false; } catch (e) { return /time budget/.test((e as Error).message); } })());
  let seenDeadline: number | undefined;
  await withDeadline({ complete: async (r) => { seenDeadline = r.deadlineMs; return { text: '', inputTokens: 0, outputTokens: 0 }; } }, 12345).complete({ system: '', user: '', maxTokens: 1, purpose: 't' });
  check('withDeadline stamps every call', seenDeadline === 12345);

  section('generalist: post mix, disclaimers, no code');
  const { pickPostKinds } = require('../src/engine/postEngine') as typeof import('../src/engine/postEngine');
  const { ensureDisclaimer, sensitiveDomain } = require('../src/llm/disclaimer') as typeof import('../src/llm/disclaimer');
  const mix = { news: 50, thoughts: 30, random: 20 };
  check('post mix: a low roll picks news first, the others follow as fallbacks by weight', pickPostKinds(mix, true, 0.0).join() === 'news,thoughts,random');
  check('post mix: a middle roll picks a crypto thought', pickPostKinds(mix, true, 0.6).join() === 'thoughts,news,random');
  check('post mix: a high roll picks random', pickPostKinds(mix, true, 0.99).join() === 'random,news,thoughts');
  check('post mix: no news available -> news is never offered', !pickPostKinds(mix, false, 0.0).includes('news') && pickPostKinds(mix, false, 0.0).length === 2);
  check('post mix: news-only with no news -> nothing to do', pickPostKinds({ news: 100, thoughts: 0, random: 0 }, false, 0.5).length === 0);
  check('post mix: weight 0 means never', !pickPostKinds({ news: 50, thoughts: 0, random: 50 }, true, 0.3).includes('thoughts'));
  const draw = (n: number) => Array.from({ length: n }, (_, i) => pickPostKinds(mix, true, (i + 0.5) / n)[0]);
  const counts = draw(1000).reduce<Record<string, number>>((a, k) => ({ ...a, [k!]: (a[k!] ?? 0) + 1 }), {});
  check('post mix: over many rolls the shares are ~50 / 30 / 20', Math.abs((counts.news ?? 0) - 500) <= 5 && Math.abs((counts.thoughts ?? 0) - 300) <= 5 && Math.abs((counts.random ?? 0) - 200) <= 5, JSON.stringify(counts));
  check('disclaimer: health gets IMO opener and the not-a-doctor line', ensureDisclaimer('Vitamin D helps your body use calcium.', 'health') === "IMO, Vitamin D helps your body use calcium. Double-check this, I'm not a doctor.");
  check('disclaimer: politics gets the not-a-politician line', /not a politician\.$/.test(ensureDisclaimer('Voter ID rules differ a lot by country.', 'politics') ?? ''));
  check('disclaimer: already complete text is left alone', ensureDisclaimer("IMO, it varies. Double-check this, I'm not a doctor.", 'health') === "IMO, it varies. Double-check this, I'm not a doctor.");
  check('disclaimer: too long for a tweet -> null (the reply is dropped, never truncated)', ensureDisclaimer('x'.repeat(260), 'health') === null);
  check('sensitive backstop catches health and politics, ignores normal topics', sensitiveDomain('what is a good dose of ibuprofen, my doctor is away') === 'health' && sensitiveDomain('who will win the election') === 'politics' && sensitiveDomain('why is my react component rendering twice') === null);
  check('no-code gate rejects backticks, shell commands, arrows and tags', ['use `useEffect` here', 'run npm install react', 'const x = () => 1', '<div>hi</div>', 'try console.log(x)'].every((t) => !R.checkNoCode(t).ok));
  check('no-code gate lets plain-words answers through', R.checkNoCode('Strict Mode renders twice in development on purpose. Production does not. Your app is probably not haunted.').ok);
  check('self-harm tweets are skipped before any model call', prefilterTweet({ text: '@Wtm_cto i want to kill myself', created_at_x: new Date(), source: 'mention' }, new Date()) === 'sensitive: self-harm');
  check('original-post persona has the no-numbers rule and no news rule', /NO numbers, statistics/.test(personaSystem('x', 'general', false, [], true)) && !/ONLY facts present in the provided material/.test(personaSystem('x', 'general', false, [], true)));
  check('every mode forbids code and claiming to be human', [personaSystem('x'), personaSystem('x', 'general', true), personaSystem('x', 'general', false, [], true)].every((p) => /NEVER write code/.test(p) && /Never claim to be human/.test(p)));
  check('post_mix / seeds settings validate', SETTING_SCHEMAS.post_mix.safeParse({ news: 1, thoughts: 0, random: 0 }).success && !SETTING_SCHEMAS.post_mix.safeParse({ news: 0, thoughts: 0, random: 0 }).success && !SETTING_SCHEMAS.thought_seeds.safeParse([]).success);

  finish('unit tests');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
