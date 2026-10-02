import 'dotenv/config';
import { z } from 'zod';
import { HARD_LIMITS } from './limits';

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

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: flag(false),

  X_CLIENT_ID: optStr,
  X_CLIENT_SECRET: optStr,
  X_ACCESS_TOKEN: optStr,
  X_REFRESH_TOKEN: optStr,

  LLM_PROVIDER: optStr,
  LLM_API_KEY: optStr,
  LLM_MODEL: optStr,

  NEWS_API_KEY: optStr,
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
    db: { url: e.DATABASE_URL, ssl: e.DATABASE_SSL },
    x: {
      clientId: e.X_CLIENT_ID,
      clientSecret: e.X_CLIENT_SECRET,
      accessToken: e.X_ACCESS_TOKEN,
      refreshToken: e.X_REFRESH_TOKEN,
    },
    llm: { provider: e.LLM_PROVIDER, apiKey: e.LLM_API_KEY, model: e.LLM_MODEL },
    news: { apiKey: e.NEWS_API_KEY },
  } as const;
}

export const config = load();
export type Config = typeof config;
