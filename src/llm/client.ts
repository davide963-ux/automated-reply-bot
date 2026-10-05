import { z } from 'zod';
import { config } from '../config/env';
import { fetchWithTimeout, safeUrl } from '../lib/http';
import { logger } from '../lib/logger';
import { isBudgetExceeded, recordUsage } from '../services/rateLimit';

const log = logger.child({ module: 'llm' });

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  /** For logs and usage accounting only. */
  purpose: string;
  /** Epoch ms after which the caller (a serverless function) will be killed: the HTTP call is cut short before it. */
  deadlineMs?: number;
}

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmUnavailableError extends Error {
  constructor(reason: string) {
    super(`LLM unavailable: ${reason}`);
    this.name = 'LlmUnavailableError';
  }
}

const MAX_CALL_MS = 60_000;
const MIN_CALL_MS = 4_000;

/** HTTP timeout for one LLM call: 60 s, but never past the caller's deadline (so a slow model cannot cause a 504). */
export function callTimeoutMs(req: Pick<LlmRequest, 'deadlineMs'>, now = Date.now()): number {
  if (req.deadlineMs === undefined) return MAX_CALL_MS;
  const left = req.deadlineMs - now;
  if (left < MIN_CALL_MS) throw new LlmUnavailableError('tick time budget used up, will retry on the next tick');
  return Math.min(MAX_CALL_MS, left - 2_000);
}

/** Every call made through the returned client inherits `deadlineMs`. */
export function withDeadline(inner: LlmClient, deadlineMs: number): LlmClient {
  return { complete: (req) => inner.complete({ ...req, deadlineMs: req.deadlineMs ?? deadlineMs }) };
}

/** Claude models that reason by default and accept `output_config.effort` (generation 4.6 and later). */
const REASONING_CLAUDE = /^claude-(opus|sonnet|fable|mythos)-(4-[6-9]|[5-9])/;

/**
 * Request body for the Anthropic Messages API (pure, so it is unit tested).
 *  - NO `temperature`/`top_p`: current Claude models reject non-default sampling values with a 400.
 *  - Reasoning models think before answering and those tokens count against max_tokens, so they get headroom
 *    (unused headroom costs nothing) and run at low effort by default: short posts do not need deep reasoning,
 *    and a tick makes several sequential calls under a serverless time limit.
 */
export function anthropicBody(model: string, req: LlmRequest, effortSetting?: string): Record<string, unknown> {
  const reasoning = REASONING_CLAUDE.test(model);
  const effort = effortSetting === 'none' ? undefined : (effortSetting ?? (reasoning ? 'low' : undefined));
  return {
    model,
    max_tokens: req.maxTokens + (reasoning ? 3000 : 0),
    ...(effort ? { output_config: { effort } } : {}),
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
  };
}

/** Chat-completions URL. Accepts a bare host, a ".../v1" base (what most providers document), or the full path. */
export function openaiUrl(baseUrl?: string): string {
  const base = (baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/(v1|openai|v1beta\/openai)$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** Headroom for reasoning tokens: many current chat models reason first and those tokens count against the limit. */
const OPENAI_HEADROOM = 2500;

export function openaiBody(
  model: string,
  req: LlmRequest,
  opts: { effort?: string; sendTemperature: boolean },
): Record<string, unknown> {
  return {
    model,
    max_tokens: req.maxTokens + OPENAI_HEADROOM,
    ...(opts.sendTemperature && req.temperature !== undefined ? { temperature: req.temperature } : {}),
    // Opt-in only (LLM_EFFORT): not every OpenAI-compatible server knows this field.
    ...(opts.effort === 'low' || opts.effort === 'medium' || opts.effort === 'high' ? { reasoning_effort: opts.effort } : {}),
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
  };
}

const openaiReplySchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional() }), finish_reason: z.string().nullable().optional() })).min(1),
  usage: z
    .object({ prompt_tokens: z.number(), completion_tokens: z.number(), total_tokens: z.number().optional() })
    .optional(),
});

export function parseOpenAiReply(json: unknown): LlmResponse {
  const data = openaiReplySchema.parse(json);
  const choice = data.choices[0]!;
  if (choice.finish_reason === 'content_filter') throw new LlmUnavailableError('the provider filtered this request (content_filter)');
  if (choice.finish_reason === 'length') {
    throw new LlmUnavailableError('the response was cut off (token limit, often spent on reasoning): set LLM_EFFORT=low or use a non-reasoning model');
  }
  const input = data.usage?.prompt_tokens ?? 0;
  // Providers disagree on whether reasoning tokens are inside completion_tokens; total - prompt covers both
  // (it can only over-estimate the cost, which is the safe direction for a spend cap).
  const output = Math.max(data.usage?.completion_tokens ?? 0, (data.usage?.total_tokens ?? 0) - input);
  return { text: choice.message.content ?? '', inputTokens: input, outputTokens: output };
}

function errorDetail(j: unknown): string | undefined {
  const e = (j as { error?: unknown } | null)?.error;
  const msg = typeof e === 'string' ? e : (e as { message?: string } | undefined)?.message;
  return msg ? String(msg).slice(0, 200) : undefined;
}

/** Raw provider call. Supported: "anthropic" and any OpenAI-compatible chat API ("openai"). */
export function createProviderClient(): LlmClient {
  const { provider, apiKey, model, baseUrl } = config.llm;
  if (!provider || !apiKey || !model) {
    return {
      complete: async () => {
        throw new LlmUnavailableError('LLM_PROVIDER, LLM_API_KEY and LLM_MODEL must all be set');
      },
    };
  }

  if (provider === 'anthropic') {
    const url = `${(baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`;
    const schema = z.object({
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
      stop_reason: z.string().nullable().optional(),
      usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
    });
    return {
      async complete(req) {
        const res = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify(anthropicBody(model, req, config.llm.effort)),
          },
          callTimeoutMs(req),
        );
        if (!res.ok) {
          // The API's error message names the problem (bad model id, no credit, bad key) and never echoes the key.
          const detail = await res.json().then((j) => (j as { error?: { message?: string } } | null)?.error?.message, () => undefined);
          throw new LlmUnavailableError(`HTTP ${res.status} from ${safeUrl(url)}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`);
        }
        const data = schema.parse(await res.json());
        if (data.stop_reason === 'refusal') throw new LlmUnavailableError('the model declined this request (safety refusal)');
        if (data.stop_reason === 'max_tokens') throw new LlmUnavailableError('the response was cut off (max_tokens): raise the limit or lower LLM_EFFORT');
        return {
          text: data.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''),
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
        };
      },
    };
  }

  if (provider === 'openai') {
    const url = openaiUrl(baseUrl);
    return {
      async complete(req) {
        const res = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(openaiBody(model, req, { effort: config.llm.effort, sendTemperature: config.llm.sendTemperature })),
          },
          callTimeoutMs(req),
        );
        if (!res.ok) {
          // Error shapes differ: {"error":{"message":..}} (OpenAI) or {"error":"..."} (xAI). Neither echoes the key.
          const detail = await res.json().then((j) => errorDetail(j), () => undefined);
          throw new LlmUnavailableError(`HTTP ${res.status} from ${safeUrl(url)}${detail ? `: ${detail}` : ''}`);
        }
        return parseOpenAiReply(await res.json());
      },
    };
  }

  return {
    complete: async () => {
      throw new LlmUnavailableError(`unsupported LLM_PROVIDER "${provider}" (use "anthropic" or "openai")`);
    },
  };
}

/**
 * Budget-aware wrapper: refuses when the daily LLM spend cap is reached
 * (fail closed) and records every request + estimated cost.
 */
export function withBudget(inner: LlmClient, accountId: string): LlmClient {
  return {
    async complete(req) {
      if (await isBudgetExceeded(accountId, 'llm')) {
        throw new LlmUnavailableError('daily LLM budget reached');
      }
      const res = await inner.complete(req);
      const cost =
        (res.inputTokens / 1_000_000) * config.llm.priceInPerMTok + (res.outputTokens / 1_000_000) * config.llm.priceOutPerMTok;
      await recordUsage(accountId, 'llm_requests', 1, cost);
      log.debug('llm call', { purpose: req.purpose, inputTokens: res.inputTokens, outputTokens: res.outputTokens, cost });
      return res;
    },
  };
}

/** Pull the first JSON object out of a model reply (tolerates prose and code fences) and validate it. */
export function parseJsonReply<T>(text: string, schema: z.ZodType<T>): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in LLM reply');
  return schema.parse(JSON.parse(text.slice(start, end + 1)));
}
