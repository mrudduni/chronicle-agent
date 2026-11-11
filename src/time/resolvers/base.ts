/**
 * The plug-in contract for time resolvers, plus small helpers they share.
 *
 * A resolver looks at a message and returns the time expressions it
 * understood, each with one or more candidate spans. Resolvers don't decide
 * between candidates; that's the ambiguity policy's job (policy.ts), which
 * can ask memory which candidate actually has a matching conversation.
 */
import { DateTime } from "luxon";
import type { Tense } from "../cues";
import type { Granularity, TemporalSpan, TimeContext } from "../types";
import { daysToInstants, formatDay } from "../zone";

export interface ResolverInput {
  /** Original message. */
  text: string;
  /** Same length as text, with entity names and domains blanked out. */
  masked: string;
  ctx: TimeContext;
  tense: Tense;
}

/** A found expression, before target classification and range composition. */
export interface RawReading {
  index: number;
  length: number;
  text: string;
  candidates: TemporalSpan[];
}

/**
 * Lets a resolver look things up in conversation memory without depending on
 * the memory module. Memory implements this; time only knows the interface.
 */
export interface AnchorLookup {
  /** When the user last talked to the agent before this visit. */
  lastVisit(beforeMs: number): number | null;
  /** The most relevant past turn about a topic ("Postgres hosting"). */
  findTurnAbout(topic: string, beforeMs: number): { ts: number; localDay: string; preview: string } | null;
  /** The previous assistant answer in the current thread (for a bare "since then"). */
  previousAnswerTs(): number | null;
}

export interface TemporalResolver {
  name: string;
  resolve(input: ResolverInput, anchors: AnchorLookup): RawReading[];
}

// ---------------------------------------------------------------- helpers

/** A span covering whole calendar days in the user's current zone. */
export function daySpan(
  from: string,
  to: string,
  ctx: TimeContext,
  opts: { granularity?: Granularity; confidence: number; resolver: string; label?: string; note?: string },
): TemporalSpan {
  const [start, end] = daysToInstants(from, to, ctx.tz);
  return {
    start,
    end,
    days: { from, to },
    granularity: opts.granularity ?? "day",
    frame: { kind: "experienced" },
    confidence: opts.confidence,
    resolver: opts.resolver,
    label: opts.label ?? (from === to ? formatDay(from) : `${formatDay(from)} to ${formatDay(to)}`),
    note: opts.note,
  };
}

/** A span with sub-day precision ("this morning"). */
export function instantSpan(
  start: DateTime,
  end: DateTime,
  opts: { confidence: number; resolver: string; label: string; note?: string },
): TemporalSpan {
  return {
    start: start.toMillis(),
    end: end.toMillis(),
    // Still record the days touched, so day-level memory filters work too.
    days: { from: start.toISODate()!, to: end.minus({ milliseconds: 1 }).toISODate()! },
    granularity: "hour",
    frame: { kind: "experienced" },
    confidence: opts.confidence,
    resolver: opts.resolver,
    label: opts.label,
    note: opts.note,
  };
}

export function today(ctx: TimeContext): DateTime {
  return ctx.now.startOf("day");
}

export function iso(dt: DateTime): string {
  return dt.toISODate()!;
}

/** Run a global regex over text and yield matches with their offsets. */
export function* matchAll(re: RegExp, text: string): Generator<RegExpExecArray> {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    yield m;
    if (m[0].length === 0) g.lastIndex++;
  }
}
