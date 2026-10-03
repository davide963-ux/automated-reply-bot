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
      usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
    });
    return {
      async complete(req) {
        const res = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model,
              max_tokens: req.maxTokens,
              temperature: req.temperature ?? 0.7,
              system: req.system,
              messages: [{ role: 'user', content: req.user }],
            }),
          },
          60_000,
        );
        if (!res.ok) throw new LlmUnavailableError(`HTTP ${res.status} from ${safeUrl(url)}`);
        const data = schema.parse(await res.json());
        return {
          text: data.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''),
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
        };
      },
    };
  }

  if (provider === 'openai') {
    const url = `${(baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '')}/v1/chat/completions`;
    const schema = z.object({
      choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
      usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).optional(),
    });
    return {
      async complete(req) {
        const res = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model,
              max_tokens: req.maxTokens,
              temperature: req.temperature ?? 0.7,
              messages: [
                { role: 'system', content: req.system },
                { role: 'user', content: req.user },
              ],
            }),
          },
          60_000,
        );
        if (!res.ok) throw new LlmUnavailableError(`HTTP ${res.status} from ${safeUrl(url)}`);
        const data = schema.parse(await res.json());
        return {
          text: data.choices[0]?.message.content ?? '',
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        };
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
