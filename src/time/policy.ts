/**
 * Ambiguity policy: one candidate per expression, plus what to tell the user.
 *
 * Decisions:
 *   use            confident; just use it, don't mention it
 *   use-and-state  probably right; use it and say which date was assumed
 *   answer-both    two readings both have matching conversations; cover both
 *   ask            too unsure to proceed; ask one short question
 *
 * The scorer comes from memory: "how many past turns in this span match the
 * topic?". That's how "last Tuesday" gets settled by which Tuesday the user
 * actually asked about Postgres, instead of by a grammar rule.
 */
import type { TemporalReading, TemporalSpan } from "./types";

export type Decision = "use" | "use-and-state" | "answer-both" | "ask";

export interface ResolvedTime {
  reading: TemporalReading;
  chosen: TemporalSpan;
  /** Spans memory should filter on. Usually [chosen]; several for answer-both. */
  filterSpans: TemporalSpan[];
  alternatives: TemporalSpan[];
  decision: Decision;
  reason: string;
  /** Vague readings nudge ranking but never exclude anything. */
  soft: boolean;
}

/** Returns how many relevant past turns fall inside a span. */
export type SpanScorer = (span: TemporalSpan) => number;

export function decide(readings: TemporalReading[], scorer?: SpanScorer): ResolvedTime[] {
  const resolved: ResolvedTime[] = [];
  for (const reading of readings.filter((r) => r.candidates.length > 0)) {
    const parent = reading.follows != null ? resolved.find((r) => r.reading.index === reading.follows) : undefined;
    resolved.push(parent ? followParent(reading, parent) : decideOne(reading, scorer));
  }
  return resolved;
}

/**
 * "since then" takes the same choice as the date it refers back to: its
 * candidates line up one-to-one with that reading's. When the parent covers
 * several dates (answer-both), this runs from the earliest of them.
 */
function followParent(reading: TemporalReading, parent: ResolvedTime): ResolvedTime {
  const at = (span: TemporalSpan) => reading.candidates[parent.reading.candidates.indexOf(span)];
  const spans = parent.filterSpans.map(at).filter((s): s is TemporalSpan => !!s);
  const chosen = spans.reduce((a, b) => (b.start < a.start ? b : a), at(parent.chosen) ?? reading.candidates[0]!);
  return {
    reading,
    chosen,
    filterSpans: [chosen],
    alternatives: reading.candidates.filter((c) => c !== chosen),
    // The parent already says which date was assumed; no need to state it twice.
    decision: parent.decision === "ask" ? "ask" : "use",
    reason: `runs from ${parent.chosen.label}`,
    soft: parent.soft,
  };
}

function decideOne(reading: TemporalReading, scorer?: SpanScorer): ResolvedTime {
  const cands = [...reading.candidates].sort((a, b) => b.confidence - a.confidence);
  const top = cands[0]!;
  const base = { reading, alternatives: cands.slice(1) };

  if (cands.length === 1) {
    const soft = top.confidence < 0.5;
    return {
      ...base,
      chosen: top,
      filterSpans: [top],
      decision: top.confidence >= 0.85 ? "use" : top.confidence < 0.3 && reading.target !== "world" ? "ask" : "use-and-state",
      reason: top.note ?? (soft ? "vague, so only used to prefer recent conversations" : ""),
      soft,
    };
  }

  // Several readings. If this is about our conversation, let memory decide.
  if (reading.target !== "world" && scorer) {
    const scored = cands.map((span) => ({ span, hits: scorer(span) }));
    const withHits = scored.filter((s) => s.hits > 0);
    if (withHits.length === 1) {
      const chosen = withHits[0]!.span;
      return {
        ...base,
        chosen,
        filterSpans: [chosen],
        alternatives: cands.filter((c) => c !== chosen),
        decision: "use-and-state",
        reason: `"${reading.text}" could mean more than one date; ${chosen.label} is when the matching conversation happened`,
        soft: false,
      };
    }
    if (withHits.length > 1) {
      return {
        ...base,
        chosen: withHits[0]!.span,
        filterSpans: withHits.map((s) => s.span),
        decision: "answer-both",
        reason: `"${reading.text}" could mean ${withHits.map((s) => s.span.label).join(" or ")}, and there are conversations on both`,
        soft: false,
      };
    }
  }

  return {
    ...base,
    chosen: top,
    filterSpans: [top],
    decision: "use-and-state",
    reason: `took "${reading.text}" as ${top.label}${cands[1] ? `; it could also mean ${cands[1].label}` : ""}`,
    soft: top.confidence < 0.5,
  };
}
