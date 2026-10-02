/**
 * Proves the daily limits hold at DATABASE level, against a real Postgres.
 * Spins up a throwaway embedded Postgres (no install, no Docker), applies the
 * real migrations, then attacks the limits in different ways.
 *
 *   npm run test:limits
 *
 * Note: Postgres refuses to run as root, so run this as a normal user.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const PORT = 54329;
let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

async function expectThrows(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

async function main(): Promise<void> {
  // embedded-postgres is ESM-only; load it with a dynamic import from this CommonJS file.
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = mkdtempSync(join(tmpdir(), 'pg-limits-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('limits_test');

  // Config is read at import time, so set env BEFORE importing app modules.
  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${PORT}/limits_test`;
  process.env.ACCOUNT_TIMEZONE = 'Europe/Tirane';
  process.env.LOG_LEVEL = 'error';

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { runMigrations } = require('../src/db/migrate') as typeof import('../src/db/migrate');
  const { query, closePool } = require('../src/db/client') as typeof import('../src/db/client');
  const { reservePublishSlot, releasePublishSlot, getUsageToday } =
    require('../src/services/rateLimit') as typeof import('../src/services/rateLimit');

  const newAccount = async (): Promise<string> => {
    const { rows } = await query<{ id: string }>(
      'insert into accounts (handle, timezone) values ($1, $2) returning id',
      [`acct_${randomUUID().slice(0, 8)}`, 'Europe/Tirane'],
    );
    return rows[0]!.id;
  };
  const setSetting = (k: string, v: unknown) =>
    query(
      `insert into settings (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [k, JSON.stringify(v)],
    );

  try {
    await runMigrations();
    console.log('\nMigrations applied.\n');

    // 1 ------------------------------------------------------------------
    console.log('1. Bot starts PAUSED: nothing can be reserved');
    const a1 = await newAccount();
    const paused = await reservePublishSlot(a1, 'post');
    check('post refused while PAUSED', !paused.ok && paused.reason === 'PAUSED');

    await setSetting('bot_status', 'RUNNING');

    // 2 ------------------------------------------------------------------
    console.log('\n2. Post limit: 6 allowed, 7th refused');
    const results = [];
    for (let i = 0; i < 7; i++) results.push(await reservePublishSlot(a1, 'post'));
    check('first 6 posts OK', results.slice(0, 6).every((r) => r.ok));
    const seventh = results[6]!;
    check('7th post refused with POST_LIMIT', !seventh.ok && seventh.reason === 'POST_LIMIT');

    // 3 ------------------------------------------------------------------
    console.log('\n3. Reply limit: 10 allowed, 11th refused (posts and replies are separate buckets)');
    const replyRes = [];
    for (let i = 0; i < 11; i++) replyRes.push(await reservePublishSlot(a1, 'reply'));
    check('first 10 replies OK', replyRes.slice(0, 10).every((r) => r.ok));
    const eleventh = replyRes[10]!;
    check('11th reply refused with REPLY_LIMIT or TOTAL_LIMIT', !eleventh.ok && ['REPLY_LIMIT', 'TOTAL_LIMIT'].includes(eleventh.reason));
    const u1 = await getUsageToday(a1);
    check('counters are exactly 6 posts + 10 replies = 16', u1.postsToday === 6 && u1.repliesToday === 10);

    // 4 ------------------------------------------------------------------
    console.log('\n4. Concurrency: 40 simultaneous post attempts must yield exactly 6 successes');
    const a2 = await newAccount();
    const burst = await Promise.all(Array.from({ length: 40 }, () => reservePublishSlot(a2, 'post')));
    const okCount = burst.filter((r) => r.ok).length;
    check(`exactly 6 of 40 succeeded (got ${okCount})`, okCount === 6);
    check('counter in DB equals 6', (await getUsageToday(a2)).postsToday === 6);

    // 5 ------------------------------------------------------------------
    console.log('\n5. Concurrency across both kinds: 30 posts + 30 replies in parallel');
    const a3 = await newAccount();
    const mixed = await Promise.all([
      ...Array.from({ length: 30 }, () => reservePublishSlot(a3, 'post')),
      ...Array.from({ length: 30 }, () => reservePublishSlot(a3, 'reply')),
    ]);
    const posts = mixed.slice(0, 30).filter((r) => r.ok).length;
    const replies = mixed.slice(30).filter((r) => r.ok).length;
    check(`posts succeeded = 6 (got ${posts})`, posts === 6);
    check(`replies succeeded = 10 (got ${replies})`, replies === 10);

    // 6 ------------------------------------------------------------------
    console.log('\n6. Settings can only LOWER limits, never raise them');
    await setSetting('max_posts_per_day', 100);
    const a4 = await newAccount();
    let ok4 = 0;
    for (let i = 0; i < 10; i++) if ((await reservePublishSlot(a4, 'post')).ok) ok4++;
    check(`max_posts_per_day=100 still capped at 6 (got ${ok4})`, ok4 === 6);
    await setSetting('max_posts_per_day', 6);

    await setSetting('max_posts_per_day', 2);
    const a5 = await newAccount();
    let ok5 = 0;
    for (let i = 0; i < 10; i++) if ((await reservePublishSlot(a5, 'post')).ok) ok5++;
    check(`max_posts_per_day=2 lowers the cap (got ${ok5})`, ok5 === 2);
    await setSetting('max_posts_per_day', 6);

    // 7 ------------------------------------------------------------------
    console.log('\n7. Total limit applies across kinds when lowered');
    await setSetting('max_total_per_day', 5);
    const a6 = await newAccount();
    const t = [
      await reservePublishSlot(a6, 'post'),
      await reservePublishSlot(a6, 'post'),
      await reservePublishSlot(a6, 'post'),
      await reservePublishSlot(a6, 'reply'),
      await reservePublishSlot(a6, 'reply'),
      await reservePublishSlot(a6, 'reply'),
    ];
    check('first 5 OK', t.slice(0, 5).every((r) => r.ok));
    const sixth = t[5]!;
    check('6th refused with TOTAL_LIMIT', !sixth.ok && sixth.reason === 'TOTAL_LIMIT');
    await setSetting('max_total_per_day', 16);

    // 8 ------------------------------------------------------------------
    console.log('\n8. Hard backstop: raw SQL tampering is rejected by CHECK constraints');
    const a7 = await newAccount();
    const e1 = await expectThrows(() =>
      query(`insert into daily_usage (account_id, usage_date, posts_count) values ($1, current_date, 7)`, [a7]),
    );
    check('posts_count = 7 rejected', e1 !== null && /daily_posts_hard_cap/.test(e1), e1 ?? '');
    const e2 = await expectThrows(() =>
      query(`insert into daily_usage (account_id, usage_date, replies_count) values ($1, current_date, 11)`, [a7]),
    );
    check('replies_count = 11 rejected', e2 !== null && /daily_replies_hard_cap/.test(e2), e2 ?? '');
    const e3 = await expectThrows(() =>
      query(`insert into daily_usage (account_id, usage_date, posts_count, replies_count) values ($1, current_date, 6, 11)`, [a7]),
    );
    check('6 posts + 11 replies rejected', e3 !== null, e3 ?? '');

    // 9 ------------------------------------------------------------------
    console.log('\n9. Release gives a slot back (only for definitive failures)');
    const a8 = await newAccount();
    const held = [];
    for (let i = 0; i < 6; i++) held.push(await reservePublishSlot(a8, 'post'));
    check('slots full', !(await reservePublishSlot(a8, 'post')).ok);
    const first = held[0]!;
    if (first.ok) await releasePublishSlot(a8, first);
    check('after release one more post is allowed', (await reservePublishSlot(a8, 'post')).ok);
    check('and then it is full again', !(await reservePublishSlot(a8, 'post')).ok);
    // release can never push the counter below zero
    const a9 = await newAccount();
    await reservePublishSlot(a9, 'post');
    const one = await reservePublishSlot(a9, 'post');
    if (one.ok) {
      await releasePublishSlot(a9, one);
      await releasePublishSlot(a9, one);
      await releasePublishSlot(a9, one);
    }
    check('counter never goes negative', (await getUsageToday(a9)).postsToday >= 0);

    // 10 -----------------------------------------------------------------
    console.log('\n10. One unsolicited reply per conversation (DB unique index)');
    const a10 = await newAccount();
    const conv = await query<{ id: string }>(
      `insert into conversations (account_id, x_conversation_id) values ($1, 'conv-1') returning id`,
      [a10],
    );
    const convId = conv.rows[0]!.id;
    const insertReply = (hash: string, status = 'PUBLISHED') =>
      query(
        `insert into replies (account_id, parent_x_post_id, conversation_id, content, content_hash, is_unsolicited, status)
         values ($1, 'p1', $2, 'hi', $3, true, $4)`,
        [a10, convId, hash, status],
      );
    await insertReply('h1');
    const dupConv = await expectThrows(() => insertReply('h2'));
    check('second unsolicited reply in same conversation rejected', dupConv !== null && /replies_one_unsolicited_per_conversation/.test(dupConv), dupConv ?? '');
    const draftOk = await expectThrows(() => insertReply('h3', 'DRAFT'));
    check('a DRAFT does not block (only live replies count)', draftOk === null, draftOk ?? '');
    const humanFollowUp = await expectThrows(() =>
      query(
        `insert into replies (account_id, parent_x_post_id, conversation_id, content, content_hash, is_unsolicited, status)
         values ($1, 'p2', $2, 'follow up', 'h4', false, 'PUBLISHED')`,
        [a10, convId],
      ),
    );
    check('reply to a human who answered US (not unsolicited) is allowed', humanFollowUp === null, humanFollowUp ?? '');

    // 11 -----------------------------------------------------------------
    console.log('\n11. Exact same post text cannot be published twice');
    const insertPost = (status: string) =>
      query(
        `insert into posts (account_id, content, content_type, content_hash, status)
         values ($1, 'same text', 'degen', 'hash-same', $2)`,
        [a10, status],
      );
    await insertPost('PUBLISHED');
    const dupPost = await expectThrows(() => insertPost('PUBLISHING'));
    check('duplicate live post rejected', dupPost !== null && /posts_no_exact_dupe/.test(dupPost), dupPost ?? '');
    const dupDraft = await expectThrows(() => insertPost('DRAFT'));
    check('duplicate DRAFT allowed (can be regenerated/ignored later)', dupDraft === null, dupDraft ?? '');

    // 12 -----------------------------------------------------------------
    console.log('\n12. Fail closed: DB down -> reservation refused');
    const a11 = await newAccount();
    await closePool();
    const down = await reservePublishSlot(a11, 'post');
    check('DB unreachable returns DB_ERROR, not ok', !down.ok && down.reason === 'DB_ERROR');
  } finally {
    await pg.stop().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('test runner crashed:', err);
  process.exit(1);
});
