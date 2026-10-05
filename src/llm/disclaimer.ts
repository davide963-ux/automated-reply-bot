import { tweetLength } from '../lib/text';

/**
 * Politics / health replies must open with "IMO," and close with a "double-check, I'm not a ..." line.
 * The model is told to do it; this module ENFORCES it, so a slip can never reach X.
 */
export type SensitiveDomain = 'health' | 'politics';

export const DISCLAIMER: Record<SensitiveDomain, string> = {
  health: "Double-check this, I'm not a doctor.",
  politics: "Double-check this, I'm not a politician.",
};

export const HEALTH_RE =
  /\b(doctor|symptom|symptoms|medicine|medication|medical|vaccine|vaccines|disease|cancer|diabetes|diagnos\w*|dosage|dose|pills?|drugs?|therapy|therapist|depress\w*|anxiety|pregnan\w*|infection|virus|illness|surgery|injury|allerg\w*|cholesterol|blood pressure|diet|supplement\w*)\b/i;
const POLITICS_RE =
  /\b(trump|biden|harris|election|elections|democrat\w*|republican\w*|vote|voting|congress|senate|parliament|president|prime minister|gaza|ukraine|israel|russia|palestin\w*|immigration|abortion|left-wing|right-wing|liberal|conservative|politic\w*|government policy)\b/i;

/** Backstop for when the model labelled a sensitive topic as "general". */
export function sensitiveDomain(...texts: string[]): SensitiveDomain | null {
  const all = texts.join(' \n ');
  if (HEALTH_RE.test(all)) return 'health';
  if (POLITICS_RE.test(all)) return 'politics';
  return null;
}

/** Returns the text with the IMO opener and the disclaimer guaranteed, or null when that no longer fits in a tweet. */
export function ensureDisclaimer(text: string, domain: SensitiveDomain, maxLen = 280): string | null {
  let t = text.trim();
  if (!/^imo\b/i.test(t)) t = `IMO, ${t}`;
  if (!/double[- ]?check/i.test(t) || !/not a (doctor|politician|medical|expert)/i.test(t)) t = `${t} ${DISCLAIMER[domain]}`;
  return tweetLength(t) <= maxLen ? t : null;
}
