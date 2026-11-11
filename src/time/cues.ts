/**
 * Cheap text checks that run before (or instead of) the resolvers.
 *
 *  - hasTimeCue:  the gate. Most messages contain no time words, so they skip
 *                 the resolver pipeline entirely.
 *  - maskEntities: blanks out things that look like dates but aren't, such as
 *                 "Monday.com" (which is a CRM, and very likely to come up).
 *  - tenseOf:     past or future, to choose between the most recent
 *                 3 November and the next one.
 *  - targetOf:    is this about our conversation, the world, or both?
 */
import type { Target } from "./types";

// Full weekday names only: "sat", "sun", "wed" and "mar" are ordinary words.
export const WEEKDAY = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues|weds|thurs)";
// Months as they appear next to a day number. Abbreviations are safe here
// because a digit sits right beside them.
export const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
// Months on their own. No "may" (the verb) and no "march" (the verb) unless
// a preposition makes it a date; the resolvers handle that case.
const MONTH_ALONE = "(?:january|february|april|june|july|august|september|october|november|december)";

const CUE = new RegExp(
  [
    `\\b${WEEKDAY}\\b`,
    `\\b${MONTH_ALONE}\\b`,
    `\\b(?:in|since|during|until|last|this|next)\\s+(?:may|march)\\b`,
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b|\\b${MONTH}\\s+\\d{1,2}\\b`,
    "\\b\\d{1,4}[/.-]\\d{1,2}(?:[/.-]\\d{2,4})?\\b",
    "\\b(?:today|tonight|yesterday|tomorrow|ago|since|until|till|earlier|recently|lately|weekend)\\b",
    "\\b(?:last|this|next|past|previous)\\s+(?:week|month|year|quarter|time|night|morning|evening|afternoon)\\b",
    "\\bq[1-4]\\b",
    "\\b(?:fy|fiscal)\\b",
    "\\bthe other day\\b",
    "\\ba while\\b",
    "\\bthis (?:morning|afternoon|evening)\\b",
    "\\b(?:christmas|new year|black friday)\\b",
  ].join("|"),
  "i",
);

export function hasTimeCue(text: string): boolean {
  return CUE.test(text);
}

/**
 * Time references the rule-based resolvers deliberately don't try to parse
 * (holidays with moving dates, personal events, fiscal periods). Only these
 * justify the extra ~300 ms of an LLM call; everything else either resolved
 * or wasn't really a date ("since you mentioned it").
 */
const NEEDS_LLM =
  /\b(?:before|after|during|since)\s+(?:my|our|the)\s+[a-z]+\b|\b(?:diwali|eid|holi|thanksgiving|easter|ramadan|hanukkah|lunar new year|chinese new year|cyber monday|prime day|golden week)\b|\bfiscal\b|\bfy\s?\d{0,4}\b/i;

export function needsLlmFallback(text: string): boolean {
  return NEEDS_LLM.test(text);
}

/**
 * Replace entity names and web domains with underscores of the same length.
 * Keeping the length means character offsets from the resolvers still line up
 * with the original message.
 */
export function maskEntities(text: string, knownNames: string[] = []): string {
  let out = text.replace(/\b[\w-]+\.(?:com|io|ai|dev|app|co|net|org|so|xyz|tech|cloud)\b/gi, blank);
  // Longest names first, so "Monday.com CRM" is masked before "Monday".
  const names = [...new Set(knownNames)]
    .filter((n) => n.length >= 3 && CUE.test(n))
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi"), blank);
  }
  return out;
}

const blank = (m: string) => "_".repeat(m.length);

export function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type Tense = "past" | "future" | "unknown";

/**
 * Deliberately crude. It only has to settle one question: if a date has no
 * year, does the user mean the last one or the next one? "What did I ask on
 * 20 November" (past) vs "remind me on 20 November" (future).
 */
export function tenseOf(text: string): Tense {
  const t = text.toLowerCase();
  if (/\b(will|going to|gonna|upcoming|next|remind|schedule|plan(?:ning)? to|by then|tomorrow)\b/.test(t)) {
    return "future";
  }
  if (
    /\b(did|was|were|had|asked|said|told|talked|discussed|mentioned|shortlisted|picked|chose|compared|ago|last|since|yesterday|earlier|changed|happened)\b/.test(
      t,
    ) ||
    /\b\w{3,}ed\b/.test(t)
  ) {
    return "past";
  }
  return "unknown";
}

// "I asked", "we discussed", "you said", "our chat"...
const MEMORY_CUE =
  /\b(?:i|we)\s+(?:\w+\s+)?(?:asked|said|told|talked|spoke|chatted|discussed|mentioned|shortlisted|picked|chose|compared|looked|decided|went through|wrote|shared)\b|\byou\s+(?:said|told|answered|recommended|suggested|mentioned|found|gave|listed)\b|\b(?:our|that)\s+(?:chat|conversation|discussion|call)\b|\bwhat did (?:i|we)\b|\bremember\b|\blast time\b/i;

const CHANGE_CUE =
  /\b(?:changed?|changes|still (?:correct|true|right|valid|accurate)|any (?:updates?|news|changes)|since|shipped|launched|released|announced|raised|dropped|new)\b/i;

/**
 * Classify what a time expression points at. Only the expression's own
 * sentence decides whether it refers to our conversation. In "What did I ask
 * on 3 November? Is it still correct today?", 3 November is about memory but
 * "today" is about the world; reading "today" as a memory date would recall
 * every question asked today as well. The whole message only decides whether
 * a memory date also bounds a "what changed since" search ("both").
 */
export function targetOf(sentence: string, message: string): Target {
  if (!MEMORY_CUE.test(sentence)) return "world";
  return CHANGE_CUE.test(message) ? "both" : "memory";
}

/** True if the message refers back to a past conversation at all. */
export function refersToPast(message: string): boolean {
  return MEMORY_CUE.test(message);
}

/** The sentence around a character offset (for targetOf). */
export function sentenceAt(text: string, index: number): string {
  const before = text.slice(0, index);
  const after = text.slice(index);
  const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("? "), before.lastIndexOf("! "), before.lastIndexOf("\n"));
  const endMatch = after.search(/[.?!\n]/);
  return text.slice(start + 1, endMatch === -1 ? text.length : index + endMatch + 1).trim();
}
