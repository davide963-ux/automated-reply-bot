/**
 * The ONE manual test post. Goes through the same publisher as the bot, so it
 * respects DRY_RUN, the PAUSED/RUNNING switch, the daily limits and dedupe.
 *
 *   npm run x:test-post -- "gm, testing my bot" --confirm
 *
 * Without --confirm it only validates the text. With DRY_RUN=true nothing is sent.
 */
import { ensureAccount } from '../src/db/accounts';
import { closePool, query } from '../src/db/client';
import { createDeps } from '../src/engine/deps';
import { publishRow } from '../src/engine/publisher';
import { contentHash, sha256 } from '../src/lib/text';
import { checkAdvice, checkLength, checkSpam } from '../src/safety/rules';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const text = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!text) throw new Error('usage: npm run x:test-post -- "your text" --confirm');

  for (const [name, r] of [['length', checkLength(text)], ['spam', checkSpam(text, 'post')], ['advice', checkAdvice(text)]] as const) {
    if (!r.ok) throw new Error(`${name} check failed: ${r.detail}`);
  }
  if (!confirm) { console.log('Text is valid. Re-run with --confirm to publish it.'); return; }

  const accountId = await ensureAccount();
  const deps = createDeps(accountId);
  if (deps.flags.dryRun) { console.log('DRY_RUN=true: nothing will be sent. Set DRY_RUN=false to post for real.'); return; }

  const ins = await query<{ id: string }>(
    `insert into posts (account_id, content, content_type, content_hash, idempotency_key, status)
     values ($1,$2,'flexible',$3,$4,'DRAFT') on conflict (idempotency_key) do nothing returning id`,
    [accountId, text, contentHash(text), sha256(`${accountId}|manual|${text}`)],
  );
  const id = ins.rows[0]?.id;
  if (!id) throw new Error('this exact test post was already created before');
  console.log(JSON.stringify(await publishRow(deps, 'post', id), null, 2));
}

main()
  .catch((err) => { console.error('x:test-post failed:', (err as Error).message); process.exitCode = 1; })
  .finally(() => closePool().catch(() => undefined));
