import { query } from '../db/client';
import { logger } from '../lib/logger';
import { redact } from '../lib/logger';

const log = logger.child({ module: 'events' });

export type BotAction =
  | 'NEWS_FOUND'
  | 'NEWS_REJECTED'
  | 'POST_GENERATED'
  | 'POST_PUBLISHED'
  | 'CONVERSATION_FOUND'
  | 'REPLY_GENERATED'
  | 'REPLY_PUBLISHED'
  | 'CONTENT_REJECTED'
  | 'PUBLISH_BLOCKED'
  | 'BOT_PAUSED'
  | 'BOT_RESUMED'
  | 'ERROR'
  | 'SYSTEM';

export interface BotEvent {
  action: BotAction;
  inputRef?: string;
  decision?: string;
  reason?: string;
  confidence?: number;
  result?: string;
  details?: Record<string, unknown>;
}

/**
 * Explainable decision log: every major decision is written to bot_events
 * AND to the structured log. Secrets are redacted. Never throws: a failing
 * log write must not take the bot down (publishing is gated separately).
 */
export async function logEvent(e: BotEvent): Promise<void> {
  log.info(e.action, { ...e });
  try {
    await query(
      `insert into bot_events (action, input_ref, decision, reason, confidence, result, details)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        e.action,
        e.inputRef ?? null,
        e.decision ?? null,
        e.reason ?? null,
        e.confidence ?? null,
        e.result ?? null,
        JSON.stringify(redact(e.details ?? {})),
      ],
    );
  } catch (err) {
    log.error('failed to persist bot event', { action: e.action, err });
  }
}
