/**
 * Shared vocabulary of the time module.
 *
 * Everything outside src/time depends on these types only, never on how a
 * span was produced. That's what lets resolvers be added or swapped without
 * touching memory, search or prompting.
 */
import type { DateTime } from "luxon";

export type Granularity = "hour" | "day" | "week" | "month" | "quarter" | "year";

/**
 * Which clock to read a past moment by.
 *  - experienced: the zone the user's clock was set to at the time (default).
 *    A question asked at 00:30 in Mumbai stays "4 Nov" even after they fly to SF.
 *  - current: the zone the user is in now.
 *  - zone: an explicit zone the user named ("3 Nov, London time").
 */
export type Frame =
  | { kind: "experienced" }
  | { kind: "current" }
  | { kind: "zone"; tz: string };

/**
 * What a time expression is about.
 *  - memory: our past conversation ("what did I ask on 3 Nov")
 *  - world:  events out there ("what did Salesforce announce on 3 Nov")
 *  - both:   "has pricing changed since I asked on Monday" — the conversation
 *            tells us what to check, the world tells us what changed.
 */
export type Target = "memory" | "world" | "both";

/** A resolved interval. Always absolute; nothing downstream does date maths. */
export interface TemporalSpan {
  /** Inclusive start, UTC epoch ms, computed in the user's current zone. */
  start: number;
  /** Exclusive end, UTC epoch ms. */
  end: number;
  /**
   * Calendar days covered (inclusive), for day-or-coarser spans. Memory is
   * matched on these against each message's own local day, which is how the
   * "experienced" frame works without converting anything.
   */
  days?: { from: string; to: string };
  granularity: Granularity;
  frame: Frame;
  /** 0..1. Below ~0.5 a span only nudges ranking; it never filters. */
  confidence: number;
  /** Which resolver produced it, for traces and the UI. */
  resolver: string;
  /** Human label, e.g. "Tue 3 Nov 2026". */
  label: string;
  /** Why this reading, e.g. "past tense, so the most recent 3 November". */
  note?: string;
}

/** One time expression found in a message, with its candidate meanings. */
export interface TemporalReading {
  /** The expression as the user typed it. */
  text: string;
  /** Character offsets in the original message, so retrieval can strip it from the keyword query. */
  index: number;
  length: number;
  target: Target;
  /** Best first. More than one means the expression is ambiguous. */
  candidates: TemporalSpan[];
}

export type TzSource = "browser" | "declared" | "fallback";

/**
 * Everything time-related about one request, built once when it arrives.
 * `now` is frozen at that moment, so a request that runs past midnight
 * doesn't change its mind about what "today" is halfway through.
 */
export interface TimeContext {
  nowMs: number;
  now: DateTime; // nowMs in the current zone
  tz: string;
  tzSource: TzSource;
  locale: string;
  /** 1 = Monday, 7 = Sunday (Luxon weekday numbering). */
  weekStartsOn: 1 | 7;
  /** True when day/month order is "3/11 = 3 November" for this locale. */
  dayFirst: boolean;
  /** Set when the clock is frozen by config (demos, evals). */
  frozen: boolean;
  /** The zone seen on the previous visit, if it differs from tz. */
  previousTz?: string;
}
