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

  finish('unit tests');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
