import { z } from 'zod';
import { query } from '../db/client';
import { HARD_LIMITS } from './limits';
import type { ActiveWindow } from '../lib/time';

/**
 * Runtime settings live in the `settings` table (editable from the dashboard).
 * Every field has a safe default, and the daily limits are clamped to the hard
 * caps here AND inside the database (slot_limit()), so they can only be lowered.
 */
export interface Settings {
  botStatus: 'RUNNING' | 'PAUSED';
  collectWhilePaused: boolean;
  maxPostsPerDay: number;
  maxRepliesPerDay: number;
  maxTotalPerDay: number;
  professionalRatio: number;
  minConfidence: number;
  personality: string;
  activeHours: ActiveWindow[];
  minGapMinutes: number;
  minReplyGapMinutes: number;
  trackedAccounts: string[];
  trackedKeywords: string[];
  breakingThreshold: number;
  maxBotRepliesPerConversation: number;
  maxRepliesPerUserPerDay: number;
  replyEnabled: boolean;
  /** 'crypto': reply only to crypto talk. 'general': any everyday topic (politics, tragedies, advice etc. stay off). */
  replyScope: 'crypto' | 'general';
  searchEnabled: boolean;
  newsMaxAgeHours: number;
  includeSourceLink: boolean;
  approvalTtlHours: number;
  customRules: CustomRule[];
  /** ids of switchable built-in rules the owner turned off (see builtinCatalog) */
  disabledBuiltinRules: string[];
}

export const CUSTOM_RULE_KINDS = ['block_output', 'skip_input', 'require_approval', 'instruction'] as const;

/** Owner rule from the Rules tab. For instruction rules `text` is a sentence; otherwise it is a phrase. */
export interface CustomRule {
  id: string;
  kind: (typeof CUSTOM_RULE_KINDS)[number];
  /** post = posts and news stories, reply = replies and tweets, both = either */
  target: 'post' | 'reply' | 'both';
  text: string;
}

export const customRuleSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{8}$/),
    kind: z.enum(CUSTOM_RULE_KINDS),
    target: z.enum(['post', 'reply', 'both']),
    text: z.string().trim().min(2).max(300),
  })
  .refine((r) => r.kind === 'instruction' || r.text.length <= 100, { message: 'a phrase can be at most 100 characters' });

const win = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

/** key -> validator. This is also the WHITELIST of keys the dashboard may write. */
export const SETTING_SCHEMAS = {
  bot_status: z.enum(['RUNNING', 'PAUSED']),
  collect_while_paused: z.boolean(),
  max_posts_per_day: z.number().int().min(0).max(HARD_LIMITS.postsPerDay),
  max_replies_per_day: z.number().int().min(0).max(HARD_LIMITS.repliesPerDay),
  max_total_per_day: z.number().int().min(0).max(HARD_LIMITS.totalPerDay),
  professional_ratio: z.number().min(0).max(1),
  min_confidence: z.number().min(0).max(1),
  personality: z.string().min(3).max(400),
  active_hours: z.array(win).max(6),
  min_gap_minutes: z.number().int().min(0).max(1440),
  min_reply_gap_minutes: z.number().int().min(0).max(1440),
  tracked_accounts: z.array(z.string().regex(/^@?[A-Za-z0-9_]{1,15}$/)).max(50),
  tracked_keywords: z.array(z.string().min(2).max(60)).max(50),
  breaking_threshold: z.number().min(0).max(1),
  max_bot_replies_per_conversation: z.number().int().min(1).max(10),
  max_replies_per_user_per_day: z.number().int().min(1).max(10),
  reply_enabled: z.boolean(),
  reply_scope: z.enum(['crypto', 'general']),
  search_enabled: z.boolean(),
  news_max_age_hours: z.number().int().min(1).max(72),
  include_source_link: z.boolean(),
  approval_ttl_hours: z.number().int().min(1).max(168),
  custom_rules: z.array(customRuleSchema).max(100),
  disabled_builtin_rules: z.array(z.string().max(40)).max(50),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;

export async function loadSettings(): Promise<Settings> {
  const { rows } = await query<{ key: string; value: unknown }>('select key, value from settings');
  const raw = new Map(rows.map((r) => [r.key, r.value]));

  // Parse each key with its schema; an invalid stored value falls back to the safe default.
  const pick = <K extends SettingKey>(key: K, def: z.infer<(typeof SETTING_SCHEMAS)[K]>): z.infer<(typeof SETTING_SCHEMAS)[K]> => {
    const parsed = (SETTING_SCHEMAS[key] as z.ZodType).safeParse(raw.get(key));
    return parsed.success ? (parsed.data as z.infer<(typeof SETTING_SCHEMAS)[K]>) : def;
  };

  return {
    botStatus: pick('bot_status', 'PAUSED'),
    collectWhilePaused: pick('collect_while_paused', true),
    maxPostsPerDay: Math.min(pick('max_posts_per_day', HARD_LIMITS.postsPerDay), HARD_LIMITS.postsPerDay),
    maxRepliesPerDay: Math.min(pick('max_replies_per_day', HARD_LIMITS.repliesPerDay), HARD_LIMITS.repliesPerDay),
    maxTotalPerDay: Math.min(pick('max_total_per_day', HARD_LIMITS.totalPerDay), HARD_LIMITS.totalPerDay),
    professionalRatio: pick('professional_ratio', 0.5),
    minConfidence: pick('min_confidence', 0.6),
    personality: pick('personality', 'crypto-native, concise, slightly sarcastic'),
    activeHours: pick('active_hours', [{ start: '08:00', end: '23:00' }]),
    minGapMinutes: pick('min_gap_minutes', 90),
    minReplyGapMinutes: pick('min_reply_gap_minutes', 10),
    trackedAccounts: pick('tracked_accounts', []).map((a) => a.replace(/^@/, '')),
    trackedKeywords: pick('tracked_keywords', []),
    breakingThreshold: pick('breaking_threshold', 0.85),
    maxBotRepliesPerConversation: pick('max_bot_replies_per_conversation', 3),
    maxRepliesPerUserPerDay: pick('max_replies_per_user_per_day', 2),
    replyEnabled: pick('reply_enabled', true),
    replyScope: pick('reply_scope', 'crypto'),
    searchEnabled: pick('search_enabled', false),
    newsMaxAgeHours: pick('news_max_age_hours', 12),
    includeSourceLink: pick('include_source_link', false),
    approvalTtlHours: pick('approval_ttl_hours', 12),
    customRules: pick('custom_rules', []),
    disabledBuiltinRules: pick('disabled_builtin_rules', []),
  };
}

/** Validated write. Throws on unknown keys or invalid values (used by the dashboard). */
export async function writeSetting(key: string, value: unknown): Promise<void> {
  if (!Object.prototype.hasOwnProperty.call(SETTING_SCHEMAS, key)) {
    throw new Error(`unknown setting: ${key}`);
  }
  const parsed = (SETTING_SCHEMAS[key as SettingKey] as z.ZodType).safeParse(value);
  if (!parsed.success) throw new Error(`invalid value for ${key}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  await query(
    `insert into settings (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(parsed.data)],
  );
}
