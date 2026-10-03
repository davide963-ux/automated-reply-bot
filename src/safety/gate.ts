import { query } from '../db/client';
import type { LlmClient } from '../llm/client';
import { judgeContent } from '../llm/content';
import { logger } from '../lib/logger';
import {
  checkAdvice, checkDuplicate, checkFacts, checkLength, checkSpam, maxRisk, riskFloor,
  type RiskLevel,
} from './rules';

const log = logger.child({ module: 'safety' });

export type GateStage = 'length' | 'factuality' | 'duplicate' | 'spam' | 'risk' | 'judge_error' | 'passed';

export interface SafetyReport {
  ok: boolean;
  stage: GateStage;
  reason: string;
  riskLevel: RiskLevel;
  /** MEDIUM risk: never auto-publish, always goes to the approval queue. */
  forceApproval: boolean;
  /** true when the failure is transient (LLM down): the source item should be retried later. */
  retryable: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

/** Texts of everything we published or queued in the last 7 days (posts AND replies). */
export async function loadRecentTexts(accountId: string, days = 7): Promise<string[]> {
  const { rows } = await query<{ content: string }>(
    `select content from posts
      where account_id = $1 and status not in ('REJECTED','FAILED') and created_at > now() - make_interval(days => $2)
     union all
     select content from replies
      where account_id = $1 and status not in ('REJECTED','FAILED') and created_at > now() - make_interval(days => $2)`,
    [accountId, days],
  );
  return rows.map((r) => r.content);
}

export interface GateInput {
  kind: 'post' | 'reply';
  text: string;
  /** Material the text must be grounded in: news title+summary, or parent tweet + conversation. */
  material: string;
  recentTexts: string[];
  /** Extra text (e.g. the parent tweet) to scan for risk signals. */
  riskContext?: string[];
}

/**
 * The safety gate. Order (cheap and deterministic first, LLM last):
 *   length -> factuality(numbers/tickers) -> duplicate -> spam -> advice/risk floor -> LLM judge
 * Anything that fails stops here and the item is never published.
 * If the LLM judge is unavailable the gate FAILS CLOSED (retryable).
 */
export async function runSafetyGate(llm: LlmClient, input: GateInput): Promise<SafetyReport> {
  const checks: SafetyReport['checks'] = [];
  const stop = (stage: GateStage, reason: string, extra: Partial<SafetyReport> = {}): SafetyReport => ({
    ok: false, stage, reason, riskLevel: 'LOW', forceApproval: false, retryable: false, checks, ...extra,
  });
  const record = (name: string, r: { ok: boolean; detail: string }) => {
    checks.push({ name, ok: r.ok, detail: r.detail });
    return r;
  };

  let r = record('length', checkLength(input.text));
  if (!r.ok) return stop('length', r.detail);

  r = record('facts', checkFacts(input.text, input.material));
  if (!r.ok) return stop('factuality', r.detail);

  r = record('duplicate', checkDuplicate(input.text, input.recentTexts, input.kind === 'reply' ? 0.7 : 0.6));
  if (!r.ok) return stop('duplicate', r.detail);

  r = record('spam', checkSpam(input.text, input.kind));
  if (!r.ok) return stop('spam', r.detail);

  r = record('advice', checkAdvice(input.text));
  if (!r.ok) return stop('risk', r.detail, { riskLevel: 'HIGH' });

  const floor = riskFloor(input.text, input.material, ...(input.riskContext ?? []));
  record('risk_floor', { ok: floor.level !== 'HIGH', detail: `${floor.level} ${floor.reasons.join(', ')}`.trim() });
  if (floor.level === 'HIGH') return stop('risk', `high-risk content: ${floor.reasons.join(', ')}`, { riskLevel: 'HIGH' });

  // LLM audit: grounded in the material? any risk the regexes cannot see?
  let judged;
  try {
    judged = await judgeContent(llm, { kind: input.kind, text: input.text, material: input.material });
  } catch (err) {
    log.warn('judge failed, failing closed', { err });
    record('judge', { ok: false, detail: 'judge unavailable' });
    return stop('judge_error', 'LLM judge unavailable (failing closed)', { retryable: true });
  }
  record('judge_supported', { ok: judged.supported, detail: judged.unsupportedClaims.join('; ') || 'supported' });
  if (!judged.supported) return stop('factuality', `unsupported claims: ${judged.unsupportedClaims.join('; ') || 'judge said unsupported'}`);

  const risk = maxRisk(floor.level, judged.risk);
  record('judge_risk', { ok: risk !== 'HIGH', detail: `${judged.risk} ${judged.riskReasons.join('; ')}`.trim() });
  if (risk === 'HIGH') return stop('risk', `high-risk content: ${judged.riskReasons.join('; ') || 'judge said HIGH'}`, { riskLevel: 'HIGH' });

  return {
    ok: true,
    stage: 'passed',
    reason: risk === 'MEDIUM' ? `passed, MEDIUM risk -> approval required (${[...floor.reasons, ...judged.riskReasons].join('; ')})` : 'passed',
    riskLevel: risk,
    forceApproval: risk === 'MEDIUM',
    retryable: false,
    checks,
  };
}
