/**
 * Memory-anchored resolver: times defined by events in our conversation
 * rather than by the calendar.
 *
 *   "since we last talked"           -> from the user's previous visit to now
 *   "since I asked about Postgres"   -> from that turn to now
 *   "when we discussed CRMs"         -> the day of that turn
 *   "before I asked about pricing"   -> up to that turn
 *
 * People refer to time this way all the time, and no calendar parser can
 * handle it. The lookup is keyword-only and one level deep (an anchor never
 * resolves another anchor), so it can't recurse and stays in the
 * low-millisecond range.
 */
import { DateTime } from "luxon";
import { formatInstant } from "../zone";
import { type RawReading, type TemporalResolver, daySpan, matchAll } from "./base";

const NAME = "anchor";

const LAST_VISIT =
  /\bsince\s+(?:we\s+|i\s+)?last\s+(?:talked|spoke|chatted|met)\b|\bsince\s+(?:our|the)\s+last\s+(?:chat|conversation|session|time)\b|\bsince\s+last\s+time\b/i;

const ABOUT =
  /\b(since|after|before|when)\s+(?:i|we)\s+(?:first\s+|last\s+)?(?:asked(?:\s+you)?|talked|spoke|chatted|discussed|looked(?:\s+(?:into|at))?|compared|researched)\s+(?:about\s+|into\s+|at\s+)?(.{3,60}?)(?=[?.!,;]|\s+(?:and|has|have|had|is|are|was|were|did|do|does|then)\b|$)/i;

export const anchorResolver: TemporalResolver = {
  name: NAME,
  resolve({ text, ctx }, anchors) {
    const out: RawReading[] = [];

    for (const m of matchAll(LAST_VISIT, text)) {
      const ts = anchors.lastVisit(ctx.nowMs);
      if (ts == null) continue;
      const start = DateTime.fromMillis(ts, { zone: ctx.tz });
      out.push({
        index: m.index,
        length: m[0].length,
        text: m[0],
        candidates: [
          {
            start: ts,
            end: ctx.nowMs,
            days: { from: start.toISODate()!, to: ctx.now.toISODate()! },
            granularity: "hour",
            frame: { kind: "experienced" },
            confidence: 0.9,
            resolver: NAME,
            label: `since your last visit (${formatInstant(ts, ctx.tz)})`,
          },
        ],
      });
    }

    for (const m of matchAll(ABOUT, text)) {
      const relation = m[1]!.toLowerCase();
      const topic = m[2]!.trim();
      const hit = anchors.findTurnAbout(topic, ctx.nowMs);
      if (!hit) continue;
      const when = formatInstant(hit.ts, ctx.tz);
      let span;
      if (relation === "when") {
        span = daySpan(hit.localDay, hit.localDay, ctx, { confidence: 0.8, resolver: NAME, note: `when you asked about ${topic}` });
      } else if (relation === "before") {
        span = {
          ...daySpan("1970-01-01", hit.localDay, ctx, { confidence: 0.75, resolver: NAME }),
          end: hit.ts,
          label: `before you asked about ${topic} (${when})`,
        };
      } else {
        span = {
          ...daySpan(hit.localDay, ctx.now.toISODate()!, ctx, { confidence: 0.8, resolver: NAME }),
          start: hit.ts,
          end: ctx.nowMs,
          label: `since you asked about ${topic} (${when})`,
        };
      }
      out.push({ index: m.index, length: m[0].length, text: m[0], candidates: [span] });
    }

    return out;
  },
};
