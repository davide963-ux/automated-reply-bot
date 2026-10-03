/**
 * The ONE manual test post (CLI). The dashboard has the same thing under Setup.
 * Goes through the same publisher as the bot, so it respects DRY_RUN, the PAUSED/RUNNING
 * switch, the daily limits and dedupe.
 *
 *   npm run x:test-post -- "gm, testing my bot" --confirm
 *
 * Without --confirm it only validates the text. With DRY_RUN=true nothing is sent.
 */
import { ensureAccount } from '../src/db/accounts';
import { closePool } from '../src/db/client';
import { createManualPost } from '../src/engine/control';
import { createDeps } from '../src/engine/deps';
import { checkAdvice, checkLength, checkSpam } from '../src/safety/rules';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const text = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!text) throw new Error('usage: npm run x:test-post -- "your text" --confirm');

  if (!args.includes('--confirm')) {
    for (const [name, r] of [['length', checkLength(text)], ['spam', checkSpam(text, 'post')], ['advice', checkAdvice(text)]] as const) {
      if (!r.ok) throw new Error(`${name} check failed: ${r.detail}`);
    }
    console.log('Text is valid. Re-run with --confirm to publish it.');
    return;
  }
  const result = await createManualPost(createDeps(await ensureAccount()), text);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main()
  .catch((err) => { console.error('x:test-post failed:', (err as Error).message); process.exitCode = 1; })
  .finally(() => closePool().catch(() => undefined));
