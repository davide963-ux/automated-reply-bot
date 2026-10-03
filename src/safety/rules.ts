import { extractNumbers, extractTickers, extractUrls, normalize, similarity, tweetLength } from '../lib/text';

/**
 * Deterministic safety rules. Pure functions: no DB, no network, no LLM.
 * Each check returns { ok, detail }. The gate (gate.ts) combines them with
 * the LLM judge and the database state (recent texts).
 */
export interface CheckResult {
  ok: boolean;
  detail: string;
}
const pass = (detail = 'ok'): CheckResult => ({ ok: true, detail });
const fail = (detail: string): CheckResult => ({ ok: false, detail });

export const MAX_TWEET_CHARS = 280;

export function checkLength(text: string, max = MAX_TWEET_CHARS): CheckResult {
  if (!text.trim()) return fail('empty text');
  const len = tweetLength(text);
  return len <= max ? pass(`${len}/${max}`) : fail(`too long: ${len}/${max}`);
}

// ---------------------------------------------------------------------------
// Factuality (deterministic part): every hard fact in the text must be in the material
// ---------------------------------------------------------------------------
const TICKER_ALIASES: Record<string, string[]> = {
  BTC: ['bitcoin', 'btc'], ETH: ['ethereum', 'ether', 'eth'], SOL: ['solana', 'sol'], XRP: ['ripple', 'xrp'],
  DOGE: ['dogecoin', 'doge'], USDT: ['tether', 'usdt'], USDC: ['usdc', 'circle'], ADA: ['cardano', 'ada'],
  BNB: ['binance', 'bnb'], AVAX: ['avalanche', 'avax'], LINK: ['chainlink', 'link'], DOT: ['polkadot', 'dot'],
};

const isYear = (n: string) => /^(19|20)\d{2}$/.test(n) && Number(n) >= 2009 && Number(n) <= 2035;
const isSmallInt = (n: string) => /^\d{1,2}$/.test(n);

export function checkFacts(text: string, material: string): CheckResult {
  const have = new Set(extractNumbers(material));
  const missing = extractNumbers(text).filter((n) => !isYear(n) && !isSmallInt(n) && !have.has(n));
  if (missing.length) return fail(`numbers not in the source: ${[...new Set(missing)].join(', ')}`);

  const mat = normalize(material);
  const unknownTickers = extractTickers(text).filter((t) => {
    const names = TICKER_ALIASES[t] ?? [t.toLowerCase()];
    return !names.some((n) => new RegExp(`(^|\\s)${n}(\\s|$)`).test(mat));
  });
  if (unknownTickers.length) return fail(`tickers not in the source: ${unknownTickers.join(', ')}`);
  return pass();
}

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------
export function checkDuplicate(text: string, recent: string[], threshold = 0.6): CheckResult {
  const n = normalize(text);
  for (const r of recent) {
    if (normalize(r) === n) return fail('exact duplicate of a recent post/reply');
  }
  let best = 0;
  for (const r of recent) best = Math.max(best, similarity(text, r));
  return best >= threshold ? fail(`too similar to a recent post/reply (${best.toFixed(2)})`) : pass(`max similarity ${best.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// Spam / scam / advice patterns
// ---------------------------------------------------------------------------
const SPAM_PATTERNS: Array<[RegExp, string]> = [
  [/\b(dm me|dm for|follow (me|back)|f4f|link in bio|join (my|our) (telegram|discord|channel|group))\b/i, 'solicitation'],
  [/\b(giveaway|airdrop (is )?live|claim (your )?(free|reward)|free (crypto|tokens?|eth|btc|nft))\b/i, 'giveaway/scam wording'],
  [/\b(guaranteed|100x|1000x|10x gem|risk[- ]free|double your)\b/i, 'too-good-to-be-true claim'],
  [/\b(send|deposit|transfer) .{0,30}\b(to receive|and (get|receive))\b/i, 'send-to-receive scam pattern'],
  [/\b0x[a-fA-F0-9]{40}\b/, 'wallet address'],
  [/\b(bc1[a-z0-9]{25,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/, 'wallet address'],
  [/(.)\1{5,}/u, 'repeated characters'],
];

const ADVICE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(you should|you must|gotta|time to|better|should) (buy|sell|ape|long|short|accumulate|dump)\b/i, 'financial advice'],
  [/\b(buy|sell|long|short|ape) (now|here|this|the dip|before)\b/i, 'financial advice'],
  [/\bprice target\b/i, 'price prediction'],
  [/\b(will|going to|gonna) (hit|reach|pump|dump|moon|explode|crash|go to)\b/i, 'price prediction'],
  [/\bto the moon\b/i, 'hype'],
  [/\b(financial advice|nfa|dyor)\b/i, 'advice framing'],
];

export function checkSpam(text: string, kind: 'post' | 'reply'): CheckResult {
  for (const [re, why] of SPAM_PATTERNS) if (re.test(text)) return fail(`spam: ${why}`);

  const hashtags = (text.match(/(?:^|\s)#\w+/g) ?? []).length;
  if (hashtags > 1) return fail(`spam: ${hashtags} hashtags`);

  const mentions = (text.match(/(?:^|\s)@\w{1,15}/g) ?? []).length;
  if (mentions > (kind === 'reply' ? 1 : 0)) return fail(`spam: ${mentions} @mentions`);

  const urls = extractUrls(text).length;
  if (urls > (kind === 'post' ? 1 : 0)) return fail(`spam: ${urls} link(s)`);

  const emoji = [...text].filter((c) => (c.codePointAt(0) ?? 0) > 0x1f000).length;
  if (emoji > 3) return fail(`spam: ${emoji} emoji`);

  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 20 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6) return fail('spam: shouting (all caps)');

  return pass();
}

export function checkAdvice(text: string): CheckResult {
  for (const [re, why] of ADVICE_PATTERNS) if (re.test(text)) return fail(`risk: ${why}`);
  return pass();
}

// ---------------------------------------------------------------------------
// Risk level (deterministic floor; the LLM judge can only raise it)
// ---------------------------------------------------------------------------
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
export const maxRisk = (a: RiskLevel, b: RiskLevel): RiskLevel => (RISK_ORDER[a] >= RISK_ORDER[b] ? a : b);

const HIGH_RISK: Array<[RegExp, string]> = [
  [/\b(dies|died|death|dead|killed|suicide|shooting|murder|terror)/i, 'death/tragedy'],
  [/\b(kike|nigger|faggot|retard|tranny)\b/i, 'slur'],
];
const MEDIUM_RISK: Array<[RegExp, string]> = [
  [/\b(scam|scammer|rug ?pull|ponzi|fraud|criminal|crook|laundering|stole|stolen|insider trading)\b/i, 'accusation of wrongdoing'],
  [/\b(trump|biden|harris|election|democrat|republican|vote|gaza|ukraine|israel|russia|war)\b/i, 'politics/geopolitics'],
  [/\b(hack(?:ed)?|exploit(?:ed)?|drained|breach)\b/i, 'security incident'],
  [/\b(lawsuit|sues?|indict|arrest|charged|subpoena)\b/i, 'legal action'],
];

export function riskFloor(...texts: string[]): { level: RiskLevel; reasons: string[] } {
  const all = texts.join(' \n ');
  const reasons: string[] = [];
  let level: RiskLevel = 'LOW';
  for (const [re, why] of HIGH_RISK) if (re.test(all)) { reasons.push(why); level = 'HIGH'; }
  if (level !== 'HIGH') {
    for (const [re, why] of MEDIUM_RISK) if (re.test(all)) { reasons.push(why); level = 'MEDIUM'; }
  }
  return { level, reasons };
}
