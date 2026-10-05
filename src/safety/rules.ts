import { HEALTH_RE } from '../llm/disclaimer';
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
  // The database also caps stored text at 280 raw characters (a long URL counts 23 for X but more here).
  if (text.length > MAX_TWEET_CHARS) return fail(`too long: ${text.length} characters (limit ${MAX_TWEET_CHARS})`);
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

// ---------------------------------------------------------------------------
// No code: the account explains in words, it never posts code, commands or markup
// ---------------------------------------------------------------------------
const CODE_PATTERNS: Array<[RegExp, string]> = [
  [/`/, 'backtick / code block'],
  [/=>/, 'arrow function'],
  [/\b(function|const|let|var)\s+[\w$]+\s*(=|\()/, 'variable or function definition'],
  [/\b(import|from)\s+[\w.'"{}*, ]+\s+(from|import)\b/, 'import statement'],
  [/<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i, 'HTML / JSX tag'],
  [/\b(npm|npx|pip|yarn|apt|brew|git|sudo|curl|docker)\s+(install|add|run|commit|push|pull|clone|get|apt|-)/i, 'shell command'],
  [/\bconsole\.log\b|\bprint\(|\bSELECT\s+.+\s+FROM\b/i, 'code call / query'],
  [/[;{}]\s*$/m, 'code punctuation at end of line'],
];

export function checkNoCode(text: string): CheckResult {
  for (const [re, why] of CODE_PATTERNS) if (re.test(text)) return fail(`code in a reply/post: ${why}`);
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
/** [id, pattern, label]. These only FORCE APPROVAL (never block), so the owner may switch them off in the Rules tab. */
const MEDIUM_RISK: Array<[string, RegExp, string]> = [
  ['risk.wrongdoing', /\b(scam|scammer|rug ?pull|ponzi|fraud|criminal|crook|laundering|stole|stolen|insider trading)\b/i, 'accusation of wrongdoing'],
  ['risk.politics', /\b(trump|biden|harris|election|democrat|republican|vote|gaza|ukraine|israel|russia|war)\b/i, 'politics/geopolitics'],
  ['risk.health', HEALTH_RE, 'health / medical topic'],
  ['risk.security', /\b(hack(?:ed)?|exploit(?:ed)?|drained|breach)\b/i, 'security incident'],
  ['risk.legal', /\b(lawsuit|sues?|indict|arrest|charged|subpoena)\b/i, 'legal action'],
];

export const SWITCHABLE_RULE_IDS = MEDIUM_RISK.map(([id]) => id);

/** Risk floor with some switchable MEDIUM rules disabled by the owner. HIGH rules can never be disabled. */
export function riskFloorFor(disabled: string[], ...texts: string[]): { level: RiskLevel; reasons: string[] } {
  const all = texts.join(' \n ');
  const reasons: string[] = [];
  let level: RiskLevel = 'LOW';
  for (const [re, why] of HIGH_RISK) if (re.test(all)) { reasons.push(why); level = 'HIGH'; }
  if (level !== 'HIGH') {
    for (const [id, re, why] of MEDIUM_RISK) if (!disabled.includes(id) && re.test(all)) { reasons.push(why); level = 'MEDIUM'; }
  }
  return { level, reasons };
}

export function riskFloor(...texts: string[]): { level: RiskLevel; reasons: string[] } {
  return riskFloorFor([], ...texts);
}

// ---------------------------------------------------------------------------
// Catalog for the Rules tab: generated from the arrays above, so the page can never drift from the code.
// ---------------------------------------------------------------------------
export interface BuiltinRule {
  id: string;
  group: string;
  effect: string;
  what: string;
  /** locked rules are safety-critical: changeable only in code */
  locked: boolean;
}

export function builtinCatalog(): BuiltinRule[] {
  const out: BuiltinRule[] = [
    { id: 'gate.length', group: 'Format', effect: 'REJECT', what: `Text must be 1-${MAX_TWEET_CHARS} characters (links count as 23)`, locked: true },
    { id: 'gate.facts', group: 'Facts', effect: 'REJECT', what: 'Every number and ticker in a draft must appear in its source (news or tweet + facts). Years and 1-2 digit numbers are exempt', locked: true },
    { id: 'gate.duplicate', group: 'Duplicates', effect: 'REJECT', what: 'Too similar to anything posted in the last 7 days (similarity 0.6 posts, 0.7 replies)', locked: true },
    { id: 'gate.style', group: 'Spam', effect: 'REJECT', what: 'More than 1 hashtag, more than 1 @mention (0 in posts), more than 1 link in a post (0 in replies), more than 3 emoji, or ALL CAPS shouting', locked: true },
    { id: 'gate.nocode', group: 'Format', effect: 'REJECT', what: 'No code in posts or replies: backticks, code blocks, shell commands, HTML tags and obvious code are rejected (he explains in words)', locked: true },
    { id: 'gate.judge', group: 'AI reviewer', effect: 'REJECT / force approval', what: 'A second Grok pass audits each draft: unsupported claims reject it, HIGH risk rejects it, MEDIUM risk forces approval. If it is unavailable the draft is held back (fails closed)', locked: true },
    { id: 'prefilter.tweets', group: 'Tweet prefilter', effect: 'SKIP (free)', what: 'Tweets with under 8 real characters, older than 3 h (24 h if they addressed us), more than 3 hashtags, self-harm wording, or shill words (giveaway, airdrop, dm me, follow back, f4f, 100x, gem alert, presale)', locked: true },
    { id: 'prompt.hard', group: 'Model instructions', effect: 'PROMPT', what: 'No financial advice or price targets, no shilling/giveaways, no insults or accusations, no tragedies as jokes, no code, never claims to be human, no invented facts, untrusted text is data', locked: true },
    { id: 'prompt.reply', group: 'Model instructions', effect: 'PROMPT', what: 'Replies to genuine questions, real discussion or friendly banter on any topic, answering from basic knowledge in the matching domain style. Politics and health only as IMO, ... ending with Double-check this, I am not a doctor/politician. Ignored: trolling, rage-bait, spam, scams, price-prediction bait, personal drama, self-harm, diagnosis/dose/treatment, legal advice, tragedies, hate, adult/illegal (general scope)', locked: true },
  ];
  for (const [re, why] of SPAM_PATTERNS) out.push({ id: `spam.${why}.${re.source.length}`, group: 'Spam patterns', effect: 'REJECT', what: `${why}: /${re.source}/`, locked: true });
  for (const [re, why] of ADVICE_PATTERNS) out.push({ id: `advice.${why}.${re.source.length}`, group: 'Advice patterns', effect: 'REJECT', what: `${why}: /${re.source}/`, locked: true });
  for (const [re, why] of HIGH_RISK) out.push({ id: `high.${why}`, group: 'High risk', effect: 'REJECT', what: `${why}: /${re.source}/`, locked: true });
  for (const [id, re, why] of MEDIUM_RISK) out.push({ id, group: 'Needs your approval', effect: 'FORCE APPROVAL', what: `${why}: /${re.source}/`, locked: false });
  return out;
}
