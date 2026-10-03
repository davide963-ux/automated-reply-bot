import { domainOf, jaccard, keywords, similarity, extractNumbers } from '../lib/text';

/**
 * Deterministic news scoring. No LLM here: it is cheap, explainable and unit
 * tested. The LLM only comes in later, to write and to judge the post.
 */
export interface NewsInput {
  title: string;
  summary: string;
  url: string;
  publishedAt: Date | null;
  fetchedAt: Date;
  sourceReliability: number;
}

export interface Scores {
  topic: string;
  importance: number;
  cryptoRelevance: number;
  freshness: number;
  sourceReliability: number;
  accountRelevance: number;
  duplicateProbability: number;
  confidence: number;
}

export type NewsDecision = 'POST' | 'IGNORE' | 'WAIT_FOR_CONFIRMATION';

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const CRYPTO_TERMS = [
  'bitcoin', 'btc', 'ethereum', 'ether', 'eth', 'crypto', 'cryptocurrency', 'blockchain', 'defi', 'stablecoin',
  'stablecoins', 'token', 'tokens', 'solana', 'xrp', 'ripple', 'binance', 'coinbase', 'altcoin', 'altcoins',
  'nft', 'nfts', 'dao', 'web3', 'layer-2', 'layer2', 'l2', 'staking', 'airdrop', 'memecoin', 'memecoins',
  'dogecoin', 'doge', 'usdt', 'usdc', 'tether', 'circle', 'etf', 'halving', 'miner', 'miners', 'mining',
  'wallet', 'exchange', 'onchain', 'on-chain', 'cardano', 'polkadot', 'avalanche', 'chainlink', 'uniswap',
  'arbitrum', 'optimism', 'base', 'ledger', 'satoshi', 'sec', 'cftc', 'mica', 'cbdc', 'tokenization',
];
const CRYPTO_SET = new Set(CRYPTO_TERMS);

const MAJOR_ENTITIES = [
  'bitcoin', 'ethereum', 'solana', 'xrp', 'tether', 'usdc', 'binance', 'coinbase', 'blackrock', 'sec', 'fed',
  'microstrategy', 'strategy', 'grayscale', 'fidelity', 'jpmorgan', 'visa', 'mastercard', 'paypal',
];

const HIGH_IMPACT = [
  /\betf\b/, /\bapprov(?:e|es|ed|al)\b/, /\blawsuit\b/, /\bsues?\b/, /\bsettle(?:s|d|ment)\b/, /\bhack(?:ed|s|ers?|ing)?\b/,
  /\bexploit(?:ed|s)?\b/, /\bstol(?:e|en)\b/, /\bdrain(?:ed|s)?\b/, /\bbankrupt/, /\bhalving\b/, /\ball-time high\b/, /\brecord\b/,
  /\blist(?:s|ing|ed)\b/, /\bdelist/, /\bmainnet\b/, /\bupgrade\b/, /\bhard fork\b/, /\blaunch(?:es|ed)?\b/,
  /\bacquir/, /\bpartnership\b/, /\bregulat/, /\bban(?:s|ned)?\b/, /\binterest rate/, /\brate cut/, /\bliquidat/,
  /\bearnings\b/, /\bbuys?\b/, /\bpurchas(?:e|es|ed)\b/, /\bmints?\b/, /\bburns?\b/, /\bfiles?\b/, /\bfiling\b/, /\bdelays?\b/,
  /\bfunding\b/, /\bfundrais/,
    /\boutflows?\b/, /\binflows?\b/, /\btreasury\b/, /\breserve\b/, /\bfreez(?:e|es|ing)\b/, /\bseiz/,
];

const LOW_VALUE = [
  /\bprice prediction\b/, /\bhow to\b/, /\btop \d+\b/, /\bbest .* to buy\b/, /\bsponsored\b/, /\bpress release\b/,
  /\bopinion\b/, /\bpodcast\b/, /\bweekly (?:recap|roundup)\b/, /\bwhat is\b/, /\bguide\b/, /\bwill .* hit \$/,
  /\bcould (?:soar|surge|explode|crash)\b/, /\btechnical analysis\b/, /\bprice analysis\b/,
];

// Whole-word matches only (explicit \w* for stems): "billion" must not match "bill", "bank" must not match "ban".
// Order matters: the first match wins, so specific topics come before broad ones.
const TOPICS: Array<[string, RegExp]> = [
  ['security', /\b(hack\w*|exploit\w*|stolen|stole|drain\w*|breach\w*|phishing|rug\w*)\b/],
  ['etf', /\b(etfs?|grayscale|blackrock|fidelity)\b/],
  ['regulation', /\b(sec|cftc|regulat\w*|lawsuits?|court|bans?|banned|mica|legislation|bills?|senate|congress|compliance)\b/],
  ['stablecoins', /\b(stablecoins?|usdt|usdc|tether|circle|cbdc)\b/],
  ['macro', /\b(fed|inflation|interest rates?|rate cuts?|treasury|treasuries|dollar|recession|tariffs?)\b/],
  ['exchanges', /\b(binance|coinbase|kraken|okx|bybit|exchanges?|listings?|lists|delist\w*)\b/],
  ['defi', /\b(defi|uniswap|aave|lending|dex|staking|yield|liquidity)\b/],
  ['memecoins', /\b(memecoins?|doge|dogecoin|shib|pepe|bonk)\b/],
  ['nft', /\b(nfts?|opensea)\b/],
  ['solana', /\b(solana|sol)\b/],
  ['ethereum', /\b(ethereum|ether|eth|layer-2|layer2|l2|arbitrum|optimism)\b/],
  ['bitcoin', /\b(bitcoin|btc|halving|satoshi|miners?|mining)\b/],
];

export function classifyTopic(text: string): string {
  const t = text.toLowerCase();
  for (const [name, re] of TOPICS) if (re.test(t)) return name;
  return 'general';
}

function countTerms(text: string): number {
  let n = 0;
  for (const w of text.toLowerCase().split(/[^a-z0-9-]+/)) if (CRYPTO_SET.has(w)) n++;
  return n;
}

export function scoreImportance(title: string, summary: string): number {
  const t = `${title}`.toLowerCase();
  const all = `${title} ${summary}`.toLowerCase();
  let s = 0.25;
  const hits = HIGH_IMPACT.filter((re) => re.test(all)).length;
  s += Math.min(0.4, hits * 0.15);
  if (MAJOR_ENTITIES.some((e) => new RegExp(`\\b${e}\\b`).test(t))) s += 0.15;
  const nums = extractNumbers(title);
  if (nums.some((n) => /(m|b|t)$/.test(n) || /^\d{4,}$/.test(n))) s += 0.1;
  if (LOW_VALUE.some((re) => re.test(all))) s -= 0.3;
  return clamp01(s);
}

export function scoreRelevance(title: string, summary: string): number {
  const weighted = countTerms(title) + 0.4 * countTerms(summary);
  return clamp01(1 - Math.exp(-0.9 * weighted));
}

export function scoreFreshness(publishedAt: Date | null, fetchedAt: Date, now: Date, maxAgeHours: number): number {
  const ref = publishedAt ?? fetchedAt;
  const ageH = (now.getTime() - ref.getTime()) / 3_600_000;
  if (ageH > maxAgeHours) return 0;
  return clamp01(Math.exp(-Math.max(0, ageH) / 6));
}

export function scoreAccountRelevance(text: string, trackedKeywords: string[]): number {
  if (trackedKeywords.length === 0) return 0.5;
  const t = text.toLowerCase();
  const hits = trackedKeywords.filter((k) => t.includes(k.toLowerCase())).length;
  return clamp01(0.4 + 0.3 * hits);
}

/** Highest similarity to anything we already used (past posts or posted news titles). */
export function duplicateProbability(text: string, usedTexts: string[]): number {
  let best = 0;
  for (const u of usedTexts) best = Math.max(best, similarity(text, u));
  return best;
}

export interface ScoreContext {
  now: Date;
  maxAgeHours: number;
  trackedKeywords: string[];
  usedTexts: string[];
}

export function scoreNews(item: NewsInput, ctx: ScoreContext): Scores {
  const text = `${item.title} ${item.summary}`;
  const importance = scoreImportance(item.title, item.summary);
  const cryptoRelevance = scoreRelevance(item.title, item.summary);
  const freshness = scoreFreshness(item.publishedAt, item.fetchedAt, ctx.now, ctx.maxAgeHours);
  const accountRelevance = scoreAccountRelevance(text, ctx.trackedKeywords);
  const dup = duplicateProbability(item.title, ctx.usedTexts);

  const base =
    0.3 * importance + 0.25 * cryptoRelevance + 0.15 * freshness + 0.2 * item.sourceReliability + 0.1 * accountRelevance;
  const confidence = clamp01(base * (1 - 0.9 * dup * dup));

  return {
    // The headline decides the topic; the summary only breaks ties when the headline says nothing.
    topic: classifyTopic(item.title) !== 'general' ? classifyTopic(item.title) : classifyTopic(text),
    importance: round3(importance),
    cryptoRelevance: round3(cryptoRelevance),
    freshness: round3(freshness),
    sourceReliability: round3(item.sourceReliability),
    accountRelevance: round3(accountRelevance),
    duplicateProbability: round3(dup),
    confidence: round3(confidence),
  };
}

/** Sources below this reliability need an independent confirmation before posting. */
export const RELIABLE_SOURCE_THRESHOLD = 0.75;
export const DUPLICATE_THRESHOLD = 0.6;

export function decideNews(
  s: Scores,
  opts: { minConfidence: number; confirmations: number },
): { decision: NewsDecision; reason: string } {
  if (s.freshness === 0) return { decision: 'IGNORE', reason: 'too old' };
  if (s.cryptoRelevance < 0.4) return { decision: 'IGNORE', reason: `low crypto relevance (${s.cryptoRelevance})` };
  if (s.duplicateProbability >= DUPLICATE_THRESHOLD) {
    return { decision: 'IGNORE', reason: `duplicates something already posted (${s.duplicateProbability})` };
  }
  if (s.confidence < opts.minConfidence) {
    return { decision: 'IGNORE', reason: `confidence ${s.confidence} < ${opts.minConfidence}` };
  }
  if (s.sourceReliability < RELIABLE_SOURCE_THRESHOLD && opts.confirmations < 1) {
    return { decision: 'WAIT_FOR_CONFIRMATION', reason: `source reliability ${s.sourceReliability} needs an independent confirmation` };
  }
  return {
    decision: 'POST',
    reason: opts.confirmations > 0 ? `confidence ${s.confidence}, ${opts.confirmations} confirmation(s)` : `confidence ${s.confidence}`,
  };
}

/** Same story reported by an independent domain? */
export function isConfirmation(
  a: { title: string; url: string },
  b: { title: string; url: string },
): boolean {
  const da = domainOf(a.url);
  const db = domainOf(b.url);
  if (!da || !db || da === db) return false;
  const ka = keywords(a.title);
  const kb = keywords(b.title);
  let shared = 0;
  for (const w of ka) if (kb.has(w)) shared++;
  return shared >= 3 && jaccard(ka, kb) >= 0.3;
}
