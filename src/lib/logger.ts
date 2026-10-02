/**
 * Minimal structured JSON logger with secret redaction.
 *  - values of any env var whose NAME looks secret are scrubbed from every line
 *  - object keys that look secret are replaced with [REDACTED]
 * No config import here, so it can be used before config validation fails.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_RE = /(secret|token|password|passwd|api[_-]?key|authorization|database_url|bearer)/i;
const MAX_DEPTH = 6;

function secretValues(): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 6 && SECRET_KEY_RE.test(k)) out.push(v);
  }
  // longest first so a secret that contains another is fully replaced
  return out.sort((a, b) => b.length - a.length);
}

function scrubString(s: string, secrets: string[]): string {
  let r = s;
  for (const secret of secrets) {
    if (r.includes(secret)) r = r.split(secret).join('[REDACTED]');
  }
  return r;
}

export function redact(value: unknown, secrets: string[] = secretValues(), depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value, secrets);
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[MaxDepth]';

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message, secrets),
      stack: value.stack ? scrubString(value.stack, secrets) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : redact(v, secrets, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function threshold(): number {
  const l = (process.env.LOG_LEVEL ?? 'info') as Level;
  return ORDER[l] ?? ORDER.info;
}

function make(bindings: Record<string, unknown>): Logger {
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < threshold()) return;
    const line = redact({ ts: new Date().toISOString(), level, msg, ...bindings, ...fields });
    const text = JSON.stringify(line);
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(text + '\n');
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (b) => make({ ...bindings, ...b }),
  };
}

export const logger = make({});
