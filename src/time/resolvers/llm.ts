/**
 * LLM fallback for time references the rules don't cover: moving holidays
 * ("since Diwali"), personal events ("before my trip"), non-English phrasing.
 *
 * The time module only defines the contract. The implementation lives in
 * src/llm so this module never imports the Anthropic SDK; tests can pass a
 * fake. Whatever the model returns is checked here before it becomes a span.
 * The model proposes; code verifies.
 */
import { DateTime } from "luxon";
import type { TemporalSpan, TimeContext } from "../types";
import { daySpan } from "./base";

export interface LlmTimeGuess {
  text: string;
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  confidence: number;
  note: string;
}

export interface LlmTimeFallback {
  guess(message: string, ctx: TimeContext): Promise<LlmTimeGuess[]>;
}

/** Turn model guesses into spans, dropping anything malformed or implausible. */
export function validateGuesses(guesses: LlmTimeGuess[], message: string, ctx: TimeContext) {
  const out: Array<{ index: number; length: number; text: string; span: TemporalSpan }> = [];
  for (const g of guesses) {
    const from = DateTime.fromISO(g.from, { zone: ctx.tz });
    const to = DateTime.fromISO(g.to, { zone: ctx.tz });
    if (!from.isValid || !to.isValid || to < from) continue;
    // Anything more than 20 years away is a hallucination, not a reading.
    if (Math.abs(from.year - ctx.now.year) > 20) continue;
    const index = message.toLowerCase().indexOf(g.text.toLowerCase());
    if (index === -1) continue; // the model must quote the user's words exactly
    out.push({
      index,
      length: g.text.length,
      text: message.substr(index, g.text.length),
      span: daySpan(from.toISODate()!, to.toISODate()!, ctx, {
        // Never fully trust it: cap below the rule-based resolvers.
        confidence: Math.min(Math.max(g.confidence, 0), 0.7),
        resolver: "llm",
        note: g.note,
      }),
    });
  }
  return out;
}
