import { createHash } from 'crypto';

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

const STOPWORDS = new Set(
  ('a an and are as at be but by for from has have in into is it its of on or that the their this to was were will with ' +
    'says say said after over new more than about up out how why what who not no can could may might just also amid ' +
    'now today report reports reported').split(' '),
);

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function safeCodePoint(n: number): string {
  try {
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}

export function stripHtml(s: string): string {
  return decodeEntities(
    s
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lowercased, URL-free, punctuation-free, single-spaced form used for hashing/similarity. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(URL_RE, ' ')
    .replace(/[^\p{L}\p{N}$%.\s]/gu, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function contentHash(text: string): string {
  return createHash('sha256').update(normalize(text)).digest('hex');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function words(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean);
}

/** Content words (no stopwords, length > 2). */
export function keywords(text: string): Set<string> {
  return new Set(words(text).filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

export function shingles(text: string, n = 3): Set<string> {
  const w = words(text);
  if (w.length <= n) return new Set(w.length ? [w.join(' ')] : []);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Similarity of two texts in [0,1]: max of word-shingle and keyword overlap. */
export function similarity(a: string, b: string): number {
  return Math.max(jaccard(shingles(a), shingles(b)), jaccard(keywords(a), keywords(b)));
}

/**
 * Approximation of X's weighted length: every URL counts 23, characters
 * outside the BMP (emoji) count 2, everything else 1.
 */
export function tweetLength(text: string): number {
  let t = text;
  let urls = 0;
  t = t.replace(URL_RE, () => {
    urls++;
    return '';
  });
  let n = 0;
  for (const ch of t) n += (ch.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
  return n + urls * 23;
}

/** Normalised numeric tokens: "$1.5B" -> "1.5b", "100,000" -> "100000", "12%" -> "12%". */
export function extractNumbers(text: string): string[] {
  const out: string[] = [];
  // A unit suffix needs a word boundary after it, but "%" is not a word character, so it is handled apart.
  const re = /\$?\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(%|(?:thousand|million|billion|trillion|bn|mm|k|m|b|t)\b))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const num = (m[1] ?? '').replace(/,/g, '');
    if (!num) continue;
    out.push(canonicalNumber(num, m[2] ?? ''));
  }
  return out;
}

const SUFFIX: Record<string, string> = {
  k: 'k', thousand: 'k', m: 'm', mm: 'm', million: 'm', b: 'b', bn: 'b', billion: 'b', t: 't', trillion: 't', '%': '%', '': '',
};

function canonicalNumber(num: string, suffix: string): string {
  const s = SUFFIX[suffix.toLowerCase()] ?? '';
  const trimmed = num.includes('.') ? num.replace(/0+$/, '').replace(/\.$/, '') : num;
  return trimmed + s;
}

export function extractTickers(text: string): string[] {
  return [...text.matchAll(/(?<![\w$])\$([A-Za-z][A-Za-z0-9]{1,9})\b/g)].map((m) => (m[1] ?? '').toUpperCase());
}

export function extractUrls(text: string): string[] {
  return text.match(URL_RE) ?? [];
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}
