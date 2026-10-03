/** fetch with a hard timeout. Throws HttpTimeoutError on timeout, never hangs. */
export class HttpTimeoutError extends Error {
  constructor(url: string, ms: number) {
    super(`request timed out after ${ms}ms: ${safeUrl(url)}`);
    this.name = 'HttpTimeoutError';
  }
}

/** Strip query strings from URLs before they reach logs/errors (tokens often live there). */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) throw new HttpTimeoutError(url, timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Read at most maxBytes of a response body as text (guards against huge feeds). */
export async function readTextLimited(res: Response, maxBytes = 3_000_000): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, maxBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`response larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
