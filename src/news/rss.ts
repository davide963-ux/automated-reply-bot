import { decodeEntities, stripHtml } from '../lib/text';

export interface FeedItem {
  title: string;
  url: string;
  summary: string;
  publishedAt: Date | null;
}

const MAX_ITEMS = 60;

function unwrap(raw: string): string {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (cdata ? (cdata[1] ?? '') : raw).trim();
}

function tag(block: string, name: string): string | undefined {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const m = block.match(re);
  return m?.[1] !== undefined ? unwrap(m[1]) : undefined;
}

function atomLink(block: string): string | undefined {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((m) => m[1] ?? '');
  const alt = links.find((a) => !/rel=["'](?!alternate)/i.test(a)) ?? links[0];
  return alt?.match(/href=["']([^"']+)["']/i)?.[1];
}

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(decodeEntities(s).trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Only absolute http(s) URLs are accepted; everything else is dropped. */
function cleanUrl(u: string | undefined): string | null {
  if (!u) return null;
  const t = decodeEntities(unwrap(u)).trim();
  try {
    const url = new URL(t);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Drop tracking params so the same article is recognised twice.
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(k)) url.searchParams.delete(k);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** Minimal RSS 2.0 / Atom parser. Tolerant: malformed items are skipped, never thrown. */
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const isAtom = /<feed\b/i.test(xml) && !/<rss\b/i.test(xml);
  const blockRe = isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi;

  for (const m of xml.matchAll(blockRe)) {
    if (items.length >= MAX_ITEMS) break;
    const block = m[0];
    const title = stripHtml(tag(block, 'title') ?? '');
    const url = cleanUrl(isAtom ? atomLink(block) : (tag(block, 'link') ?? tag(block, 'guid')));
    if (!title || !url) continue;
    const summaryRaw = isAtom
      ? (tag(block, 'summary') ?? tag(block, 'content'))
      : (tag(block, 'description') ?? tag(block, 'content:encoded'));
    items.push({
      title,
      url,
      summary: stripHtml(summaryRaw ?? '').slice(0, 1200),
      publishedAt: parseDate(isAtom ? (tag(block, 'published') ?? tag(block, 'updated')) : (tag(block, 'pubDate') ?? tag(block, 'dc:date'))),
    });
  }
  return items;
}
