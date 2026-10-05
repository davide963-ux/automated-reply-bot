import type { CustomRule } from '../config/settings';

/**
 * Owner-defined rules (Rules tab). Pure functions.
 * Phrases are matched case-insensitively as literal text (never as a regex: a pasted pattern cannot hang the
 * function), with word boundaries when the phrase starts/ends with a letter or digit.
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function phraseRegex(phrase: string): RegExp {
  const p = phrase.trim();
  const start = /^\w/.test(p) ? '\\b' : '';
  const end = /\w$/.test(p) ? '\\b' : '';
  return new RegExp(`${start}${escapeRe(p)}${end}`, 'i');
}

export type RuleTarget = 'post' | 'reply';
const applies = (r: CustomRule, target: RuleTarget) => r.target === 'both' || r.target === target;

/** First rule of `kind` for `target` whose phrase occurs in any of `texts`. */
export function findCustomMatch(rules: CustomRule[] | undefined, kind: CustomRule['kind'], target: RuleTarget, ...texts: string[]): CustomRule | undefined {
  const hay = texts.join('\n');
  return (rules ?? []).find((r) => r.kind === kind && applies(r, target) && phraseRegex(r.text).test(hay));
}

/** Plain-language instructions to add to the model prompt (they can never override the HARD RULES). */
export function instructionsFor(rules: CustomRule[] | undefined, target: RuleTarget): string[] {
  return (rules ?? []).filter((r) => r.kind === 'instruction' && applies(r, target)).map((r) => r.text.replace(/\s+/g, ' ').trim());
}
