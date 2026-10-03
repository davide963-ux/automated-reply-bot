import { config } from '../config/env';
import { createProviderClient, withBudget, type LlmClient } from '../llm/client';
import { defaultFetchText, type FetchText } from '../news/collector';
import { createXClient } from '../x/client';
import type { XApi } from '../x/types';

export interface Flags {
  /** true: never call X to publish, only log "WOULD POST" */
  dryRun: boolean;
  /** false: everything that passes the safety gate waits in the approval queue */
  autonomous: boolean;
}

/**
 * Everything the engine touches from the outside, injectable so the whole
 * pipeline can be tested end-to-end with fakes (no network, no real X, no real LLM).
 */
export interface Deps {
  accountId: string;
  x: XApi;
  llm: LlmClient;
  fetchText: FetchText;
  flags: Flags;
  now: () => Date;
  random: () => number;
}

export function createDeps(accountId: string): Deps {
  return {
    accountId,
    x: createXClient(accountId),
    llm: withBudget(createProviderClient(), accountId),
    fetchText: defaultFetchText,
    flags: { dryRun: config.flags.dryRun, autonomous: config.flags.autonomousMode },
    now: () => new Date(),
    random: Math.random,
  };
}
