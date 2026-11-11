/**
 * The time pipeline: message in, TemporalReadings out.
 *
 *   gate -> mask -> resolvers (cheapest first) -> drop overlaps
 *        -> compose ranges ("since X", "before X", "between X and Y", "since then")
 *        -> classify target (memory / world / both)
 *        -> LLM fallback, only if nothing resolved and the message needs it
 *
 * Typical cost is well under a millisecond; most messages stop at the gate.
 */
import { DateTime } from "luxon";
import { hasTimeCue, maskEntities, needsLlmFallback, sentenceAt, targetOf, tenseOf } from "./cues";
import { anchorResolver } from "./resolvers/anchor";
import type { AnchorLookup, RawReading, ResolverInput, TemporalResolver } from "./resolvers/base";
import { calendarResolver } from "./resolvers/calendar";
import { explicitResolver } from "./resolvers/explicit";
import { type LlmTimeFallback, validateGuesses } from "./resolvers/llm";
import type { TemporalReading, TemporalSpan, TimeContext } from "./types";
import { shiftDay } from "./zone";

/** Order matters only for overlaps: earlier resolvers win ties. */
export const DEFAULT_RESOLVERS: TemporalResolver[] = [anchorResolver, calendarResolver, explicitResolver];

export interface PipelineDeps {
  anchors: AnchorLookup;
  /** Names of known entities, so "Monday.com" isn't read as a Monday. */
  entityNames?: string[];
  llm?: LlmTimeFallback;
  resolvers?: TemporalResolver[];
  /** Upper bound on the LLM fallback; past this we go without it. */
  llmTimeoutMs?: number;
}

export async function readTime(text: string, ctx: TimeContext, deps: PipelineDeps): Promise<TemporalReading[]> {
  if (!hasTimeCue(text)) return [];

  const input: ResolverInput = {
    text,
    masked: maskEntities(text, deps.entityNames),
    ctx,
    tense: tenseOf(text),
  };

  let raw: RawReading[] = [];
  for (const r of deps.resolvers ?? DEFAULT_RESOLVERS) raw.push(...r.resolve(input, deps.anchors));
  raw = dropOverlaps(raw);
  raw = composeRanges(raw, input, deps.anchors);

  if (raw.length === 0 && deps.llm && needsLlmFallback(text)) {
    raw = await llmFallback(text, ctx, deps.llm, deps.llmTimeoutMs ?? 2500);
  }

  return raw
    .sort((a, b) => a.index - b.index)
    .map((r) => ({ ...r, target: targetOf(sentenceAt(text, r.index), text) }));
}

/** When two readings overlap, keep the longer one ("last Tuesday" beats "Tuesday"). */
function dropOverlaps(readings: RawReading[]): RawReading[] {
  const sorted = [...readings].sort((a, b) => b.length - a.length || a.index - b.index);
  const kept: RawReading[] = [];
  for (const r of sorted) {
    const overlaps = kept.some((k) => r.index < k.index + k.length && k.index < r.index + r.length);
    if (!overlaps) kept.push(r);
  }
  return kept.sort((a, b) => a.index - b.index);
}

/**
 * Turn point readings into ranges based on the words around them:
 *   "since Monday"            -> Monday .. now
 *   "after 3 Nov"             -> end of 3 Nov .. now
 *   "before Friday"           -> .. start of Friday
 *   "between Monday and Wed"  -> Monday .. end of Wednesday
 *   "since then" / "since?"   -> the previous reading (or previous answer) .. now
 */
function composeRanges(readings: RawReading[], input: ResolverInput, anchors: AnchorLookup): RawReading[] {
  const { masked, ctx } = input;
  const todayIso = ctx.now.toISODate()!;
  const out: RawReading[] = [];

  for (let i = 0; i < readings.length; i++) {
    const r = readings[i]!;
    const next = readings[i + 1];
    const before = masked.slice(Math.max(0, r.index - 16), r.index).toLowerCase();

    // between X and Y
    if (next && /\b(?:between|from)\s+(?:the\s+)?$/.test(before)) {
      const gap = masked.slice(r.index + r.length, next.index);
      if (/^\s*(?:and|to|until|till|-|–)\s*(?:the\s+)?$/i.test(gap)) {
        const a = r.candidates[0]!;
        const b = next.candidates[0]!;
        out.push({
          index: r.index,
          length: next.index + next.length - r.index,
          text: input.text.slice(r.index, next.index + next.length),
          candidates: [
            {
              ...a,
              end: b.end,
              days: a.days && b.days ? { from: a.days.from, to: b.days.to } : undefined,
              granularity: "day",
              label: `${a.label} to ${b.label}`,
              confidence: Math.min(a.confidence, b.confidence),
            },
          ],
        });
        i++;
        continue;
      }
    }

    const sinceM = /\b(since|after|from)\s+(?:the\s+|on\s+)?$/.exec(before);
    const untilM = /\b(until|till|before|by)\s+(?:the\s+)?$/.exec(before);
    if (sinceM) {
      const word = sinceM[1]!;
      out.push(extend(r, sinceM, (c) => ({
        ...c,
        start: word === "after" ? c.end : c.start,
        end: ctx.nowMs,
        days: c.days ? { from: word === "after" ? shiftDay(c.days.to, 1) : c.days.from, to: todayIso } : undefined,
        granularity: "day",
        label: `${word} ${c.label}`,
      })));
    } else if (untilM) {
      const word = untilM[1]!;
      out.push(extend(r, untilM, (c) => ({
        ...c,
        start: 0,
        end: word === "before" ? c.start : c.end,
        days: c.days ? { from: "1970-01-01", to: word === "before" ? shiftDay(c.days.from, -1) : c.days.to } : undefined,
        granularity: "day",
        label: `${word} ${c.label}`,
      })));
    } else {
      out.push(r);
    }
  }

  // "since then" and a bare trailing "since" ("...shipped anything big since?")
  for (const m of input.text.matchAll(/\bsince\s+then\b|\bsince(?=\s*[?.!]|\s*$)/gi)) {
    const index = m.index!;
    const previous = [...out].reverse().find((r) => r.index < index);
    const sinceSpan = (start: number, fromDay: string | null, label: string, confidence: number): TemporalSpan => ({
      start,
      end: ctx.nowMs,
      days: fromDay ? { from: fromDay, to: todayIso } : undefined,
      granularity: "day",
      frame: { kind: "experienced" },
      confidence,
      resolver: "compose",
      label: `since ${label}`,
    });
    if (previous) {
      // One candidate per reading of the earlier date, so this follows
      // whichever one the policy (or memory) picks for it.
      const candidates = previous.candidates.map((c) => sinceSpan(c.start, c.days?.from ?? null, c.label, c.confidence));
      out.push({ index, length: m[0].length, text: m[0], candidates, follows: previous.index });
      continue;
    }
    const start = anchors.previousAnswerTs();
    if (start == null) continue;
    const dt = DateTime.fromMillis(start, { zone: ctx.tz });
    out.push({
      index,
      length: m[0].length,
      text: m[0],
      candidates: [sinceSpan(start, dt.toISODate(), `my previous answer (${dt.toFormat("ccc d LLL")})`, 0.75)],
    });
  }

  return out;
}

function extend(r: RawReading, prefix: RegExpExecArray, map: (c: TemporalSpan) => TemporalSpan): RawReading {
  const word = prefix[0];
  return {
    index: r.index - word.length,
    length: r.length + word.length,
    text: word + r.text,
    candidates: r.candidates.map(map),
  };
}

async function llmFallback(text: string, ctx: TimeContext, llm: LlmTimeFallback, timeoutMs: number): Promise<RawReading[]> {
  try {
    const guesses = await Promise.race([
      llm.guess(text, ctx),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return validateGuesses(guesses, text, ctx).map((g) => ({
      index: g.index,
      length: g.length,
      text: g.text,
      candidates: [g.span],
    }));
  } catch {
    // A slow or failed fallback must never block the answer.
    return [];
  }
}
