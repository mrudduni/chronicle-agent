/**
 * Adapters: the one resolved-time shape, translated for each consumer.
 *
 *   memory  -> which days / instants to filter past turns on
 *   search  -> since/until dates for the search API (widened by a day)
 *   prompt  -> plain lines the model reads ("'last Tuesday' = Tue 3 Nov 2026, 8 days ago")
 *   ui      -> chips the user sees and can check
 *
 * Swapping search providers or changing how memory filters only touches the
 * matching adapter.
 */
import { DateTime } from "luxon";
import type { ResolvedTime } from "./policy";
import type { TimeContext } from "./types";
import { ageOfDay, shiftDay } from "./zone";

export interface MemoryTimeFilter {
  /** Inclusive calendar-day ranges, matched against each message's own local day. */
  dayRanges: Array<{ from: string; to: string }>;
  /** Sub-day ranges, matched against ts_utc. */
  instantRanges: Array<{ start: number; end: number }>;
  /** Vague ranges: boost matching turns, exclude nothing. */
  softDayRanges: Array<{ from: string; to: string }>;
  /** Text of the expressions, so retrieval can strip them from the keyword query. */
  expressions: Array<{ index: number; length: number }>;
}

export function memoryFilterOf(resolved: ResolvedTime[]): MemoryTimeFilter | null {
  const forMemory = resolved.filter((r) => r.reading.target !== "world");
  if (forMemory.length === 0) return null;
  const f: MemoryTimeFilter = { dayRanges: [], instantRanges: [], softDayRanges: [], expressions: [] };
  for (const r of forMemory) {
    f.expressions.push({ index: r.reading.index, length: r.reading.length });
    for (const s of r.filterSpans) {
      if (r.soft) {
        if (s.days) f.softDayRanges.push(s.days);
      } else if (s.granularity === "hour") {
        f.instantRanges.push({ start: s.start, end: s.end });
      } else if (s.days) {
        f.dayRanges.push(s.days);
      }
    }
  }
  return f;
}

export interface SearchWindow {
  since?: string; // YYYY-MM-DD
  until?: string;
  label: string;
}

/**
 * The date window for "what changed since..." searches. Providers filter by
 * publish date, which is date-only and usually UTC, so a day of slack on each
 * side stops edge-of-window results from being dropped.
 */
export function searchWindowOf(resolved: ResolvedTime[], ctx: TimeContext): SearchWindow | null {
  const forWorld = resolved.filter((r) => r.reading.target !== "memory" && !r.soft && r.chosen.days);
  if (forWorld.length === 0) return null;
  const from = forWorld.map((r) => r.chosen.days!.from).sort()[0]!;
  const to = forWorld.map((r) => r.chosen.days!.to).sort().at(-1)!;
  const today = ctx.now.toISODate()!;
  return {
    since: from === "1970-01-01" ? undefined : shiftDay(from, -1),
    until: to >= today ? undefined : shiftDay(to, 1),
    label: forWorld.map((r) => r.chosen.label).join(", "),
  };
}

/** Lines for the model's context block. Absolute dates, weekday and age, all precomputed. */
export function promptLinesOf(resolved: ResolvedTime[], ctx: TimeContext): string[] {
  const today = ctx.now.toISODate()!;
  return resolved.map((r) => {
    const s = r.chosen;
    const age = s.days ? (s.days.from === s.days.to ? ageOfDay(s.days.from, today) : `${ageOfDay(s.days.from, today)} to ${ageOfDay(s.days.to, today)}`) : "";
    const parts = [`"${r.reading.text}" = ${s.label}${age ? ` (${age})` : ""}`, `about: ${describeTarget(r.reading.target)}`];
    if (r.decision === "use-and-state") parts.push(`assumption to mention briefly: ${r.reason || "inferred"}`);
    if (r.decision === "answer-both") parts.push(`ambiguous: ${r.reason}; cover both`);
    if (r.decision === "ask") parts.push("too vague: ask the user which time they mean, in one short question");
    if (r.soft) parts.push("vague, treat as approximate");
    return `- ${parts.join("; ")}`;
  });
}

function describeTarget(t: string) {
  return t === "memory" ? "our past conversation" : t === "world" ? "events in the world" : "our past conversation and what changed since";
}

export interface TimeChip {
  expression: string;
  interpretation: string;
  decision: string;
  note?: string;
  alternatives: string[];
}

export function uiChipsOf(resolved: ResolvedTime[], ctx: TimeContext): TimeChip[] {
  return resolved.map((r) => ({
    expression: r.reading.text,
    interpretation: `${r.chosen.label}${r.chosen.days && r.chosen.days.from === r.chosen.days.to ? ` (${ageOfDay(r.chosen.days.from, ctx.now.toISODate()!)})` : ""}`,
    decision: r.decision,
    note: r.reason || undefined,
    alternatives: r.alternatives.map((a) => a.label),
  }));
}

/** "Wednesday 11 November 2026, 3:40 pm (Asia/Kolkata)" for the context header. */
export function describeNow(ctx: TimeContext): string {
  return `${ctx.now.toFormat("cccc d LLLL yyyy, h:mm a")} (${ctx.tz})`;
}

export function isoDate(ms: number, tz: string) {
  return DateTime.fromMillis(ms, { zone: tz }).toISODate()!;
}
