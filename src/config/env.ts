import 'dotenv/config';
import { z } from 'zod';
import { HARD_LIMITS } from './limits';

/**
 * Where the database connection string comes from, in order:
 *   1. DATABASE_URL            (explicit)
 *   2. POSTGRES_URL
 *   3. <prefix>_DATABASE_URL   (Vercel database integrations add a prefix, e.g. "storage_DATABASE_URL")
 *   4. <prefix>_POSTGRES_URL
 * Variants that are not what the app needs are ignored: UNPOOLED / NON_POOLING (direct connections,
 * bad for serverless), NO_SSL, PRISMA. Values must look like a postgres URL. Returns the variable NAME
 * too, so the dashboard can show which one is used (never the value).
 */
export function findDatabaseUrl(env: NodeJS.ProcessEnv = process.env): { name: string; value: string } | undefined {
  const usable = (k: string) => {
    const v = env[k]?.trim();
    return v && /^postgres(ql)?:\/\//i.test(v) ? v : undefined;
  };
  for (const k of ['DATABASE_URL', 'POSTGRES_URL']) {
    const v = usable(k);
    if (v) return { name: k, value: v };
  }
  const rank = (k: string) => (/DATABASE_URL$/i.test(k) ? 0 : 1);
  const candidates = Object.keys(env)
    .filter((k) => /(^|_)(DATABASE|POSTGRES)_URL$/i.test(k) && !/UNPOOLED|NON_POOLING|NO_SSL|PRISMA/i.test(k) && usable(k))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const name = candidates[0];
  return name ? { name, value: usable(name)! } : undefined;
}

const emptyToUndef = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const optStr = z.preprocess(emptyToUndef, z.string().optional());

/** "true"/"false" flag with an explicit default. */
const flag = (def: boolean) =>
  z
    .preprocess(emptyToUndef, z.enum(['true', 'false']).default(def ? 'true' : 'false'))
    .transform((v) => v === 'true');

const num = (def: number, min: number, max: number) =>
  z.preprocess(emptyToUndef, z.coerce.number().min(min).max(max).default(def));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Safety switches: defaults are the SAFE values.
  DRY_RUN: flag(true),
  AUTONOMOUS_MODE: flag(false),

  X_ACCOUNT_HANDLE: z.preprocess(emptyToUndef, z.string().default('unconfigured')),
  ACCOUNT_TIMEZONE: z.preprocess(emptyToUndef, z.string().default('UTC')),

  MAX_POSTS_PER_DAY: num(HARD_LIMITS.postsPerDay, 0, HARD_LIMITS.postsPerDay),
  MAX_REPLIES_PER_DAY: num(HARD_LIMITS.repliesPerDay, 0, HARD_LIMITS.repliesPerDay),
  MAX_TOTAL_PER_DAY: num(HARD_LIMITS.totalPerDay, 0, HARD_LIMITS.totalPerDay),

  MAX_X_DAILY_SPEND: num(5, 0, 100000),
  MAX_LLM_DAILY_SPEND: num(5, 0, 100000),

  // Falls back to what Vercel's database integrations inject (see findDatabaseUrl).
  DATABASE_URL: z.preprocess(
    (v) => emptyToUndef(v) ?? findDatabaseUrl()?.value,
    z.string().min(1, 'DATABASE_URL is required (or a Vercel database integration such as storage_DATABASE_URL)'),
  ),
  DATABASE_SSL: flag(false),
  DB_POOL_MAX: num(10, 1, 50),

  X_CLIENT_ID: optStr,
  X_CLIENT_SECRET: optStr,
  X_ACCESS_TOKEN: optStr,
  X_REFRESH_TOKEN: optStr,
  X_REDIRECT_URI: z.preprocess(
    emptyToUndef,
    z.string().url().default(
      // On Vercel, VERCEL_PROJECT_PRODUCTION_URL is the production host (no scheme).
      process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/x-callback`
        : 'http://127.0.0.1:3000/callback',
    ),
  ),
  X_API_BASE: z.preprocess(emptyToUndef, z.string().url().default('https://api.x.com')),
  X_COST_PER_READ: num(0.005, 0, 10),
  X_COST_PER_WRITE: num(0.01, 0, 10),
  TOKEN_ENCRYPTION_KEY: optStr,

  LLM_PROVIDER: optStr,
  LLM_API_KEY: optStr,
  LLM_MODEL: optStr,
  LLM_BASE_URL: optStr,
  // Anthropic only. Default: "low" for current reasoning-capable Claude models (fast and cheap for short posts),
  // nothing for older models. "none" never sends it. Others: medium | high | xhigh | max.
  LLM_EFFORT: z.preprocess(emptyToUndef, z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).optional()),
  LLM_PRICE_IN_PER_MTOK: num(3, 0, 1000),
  LLM_PRICE_OUT_PER_MTOK: num(15, 0, 1000),

  NEWS_API_KEY: optStr,

  // Runtime
  TICK_INTERVAL_SECONDS: num(60, 10, 3600),
  PORT: num(3000, 1, 65535),
  AUTO_MIGRATE: flag(false),
  DASHBOARD_TOKEN: z.preprocess(
    emptyToUndef,
    z.string().min(16, 'DASHBOARD_TOKEN must be at least 16 characters').optional(),
  ),
  CRON_SECRET: z.preprocess(
    emptyToUndef,
    z.string().min(16, 'CRON_SECRET must be at least 16 characters').optional(),
  ),
});

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    // Do not print values: they may be secrets.
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  if (!isValidTimezone(e.ACCOUNT_TIMEZONE)) {
    throw new Error(`Invalid environment configuration:\n  - ACCOUNT_TIMEZONE: "${e.ACCOUNT_TIMEZONE}" is not a valid IANA timezone`);
  }

  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    accountHandle: e.X_ACCOUNT_HANDLE,
    timezone: e.ACCOUNT_TIMEZONE,
    flags: { dryRun: e.DRY_RUN, autonomousMode: e.AUTONOMOUS_MODE },
    limits: {
      maxPostsPerDay: e.MAX_POSTS_PER_DAY,
      maxRepliesPerDay: e.MAX_REPLIES_PER_DAY,
      maxTotalPerDay: e.MAX_TOTAL_PER_DAY,
    },
    budget: { maxXDailySpend: e.MAX_X_DAILY_SPEND, maxLlmDailySpend: e.MAX_LLM_DAILY_SPEND },
    db: {
      url: e.DATABASE_URL,
      ssl: e.DATABASE_SSL,
      poolMax: e.DB_POOL_MAX,
      // Name only (never the value): which variable the connection string came from.
      urlSource: process.env.DATABASE_URL?.trim() ? 'DATABASE_URL' : (findDatabaseUrl()?.name ?? 'DATABASE_URL'),
    },
    x: {
      clientId: e.X_CLIENT_ID,
      clientSecret: e.X_CLIENT_SECRET,
      accessToken: e.X_ACCESS_TOKEN,
      refreshToken: e.X_REFRESH_TOKEN,
      redirectUri: e.X_REDIRECT_URI,
      apiBase: e.X_API_BASE.replace(/\/+$/, ''),
      costPerRead: e.X_COST_PER_READ,
      costPerWrite: e.X_COST_PER_WRITE,
      tokenEncryptionKey: e.TOKEN_ENCRYPTION_KEY,
    },
    llm: {
      provider: e.LLM_PROVIDER,
      apiKey: e.LLM_API_KEY,
      model: e.LLM_MODEL,
      baseUrl: e.LLM_BASE_URL,
      effort: e.LLM_EFFORT,
      priceInPerMTok: e.LLM_PRICE_IN_PER_MTOK,
      priceOutPerMTok: e.LLM_PRICE_OUT_PER_MTOK,
    },
    news: { apiKey: e.NEWS_API_KEY },
    runtime: {
      tickIntervalSeconds: e.TICK_INTERVAL_SECONDS,
      port: e.PORT,
      autoMigrate: e.AUTO_MIGRATE,
      dashboardToken: e.DASHBOARD_TOKEN,
      cronSecret: e.CRON_SECRET,
    },
  } as const;
}

export const config = load();
export type Config = typeof config;
