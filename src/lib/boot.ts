import type { IncomingMessage, ServerResponse } from 'http';
import { redact } from './logger';

/**
 * Crash-proof loading for serverless entry points.
 *
 * config/env.ts validates the environment the moment it is imported and throws if a
 * variable is missing or malformed. In a serverless function that exception happens
 * while the module loads, before any handler runs, and Vercel can only answer with the
 * opaque "500 FUNCTION_INVOCATION_FAILED". So entry points load the real handler lazily
 * through lazyHandler(): if loading fails, the request gets a readable explanation
 * (variable NAMES and reasons, never values) and the cause goes to the runtime logs.
 *
 * IMPORTANT: this file must not import config/env (that would defeat the purpose).
 */
export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** Lines of an "Invalid environment configuration" error, or a short generic summary. Secrets scrubbed. */
export function summarizeBootError(err: unknown): { kind: 'config' | 'other'; lines: string[] } {
  const raw = String((err as Error)?.message ?? err);
  const clean = String(redact(raw));
  if (/^Invalid environment configuration/.test(clean)) {
    const lines = clean.split('\n').slice(1).map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean).slice(0, 12);
    return { kind: 'config', lines };
  }
  return { kind: 'other', lines: [clean.split('\n')[0]!.slice(0, 300)] };
}

function respond(res: ServerResponse, status: number, wantsJson: boolean, title: string, lines: string[], hint: string): void {
  if (res.headersSent) return;
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (wantsJson) {
    res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: title, details: lines, hint }));
    return;
  }
  res.writeHead(status, {
    ...headers,
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:8vh auto;padding:0 16px">
<h2>${esc(title)}</h2>
<ul>${lines.map((l) => `<li><code>${esc(l)}</code></li>`).join('')}</ul>
<p>${esc(hint)}</p></body>`);
}

export function lazyHandler(load: () => NodeHandler | Promise<NodeHandler>): NodeHandler {
  let ready: NodeHandler | undefined;
  let failure: unknown;
  let failed = false;

  return async (req, res) => {
    const wantsJson = /json/.test(String(req.headers.accept ?? '')) && !/html/.test(String(req.headers.accept ?? ''));

    if (!ready && !failed) {
      try {
        ready = await load();
      } catch (err) {
        failed = true;
        failure = err;
        console.error(JSON.stringify({ level: 'error', msg: 'serverless entry point failed to load', reason: summarizeBootError(err).lines }));
      }
    }

    if (!ready) {
      const s = summarizeBootError(failure);
      return respond(
        res, 500, wantsJson,
        s.kind === 'config' ? 'The app is not configured correctly' : 'The app failed to start',
        s.lines,
        s.kind === 'config'
          ? 'Fix these in Vercel: Settings, Environment Variables. Then Redeploy (changes only apply to new deployments).'
          : 'See the function logs in Vercel (Logs tab) for details.',
      );
    }

    try {
      await ready(req, res);
    } catch (err) {
      // A handler bug or an unexpected database error must not become FUNCTION_INVOCATION_FAILED.
      console.error(JSON.stringify({ level: 'error', msg: 'handler threw', reason: String(redact(String((err as Error)?.message ?? err))).slice(0, 300) }));
      respond(res, 500, wantsJson, 'Internal error', [], 'See the function logs in Vercel (Logs tab).');
    }
  };
}
