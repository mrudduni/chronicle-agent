/**
 * Explicit resolver: dates and relative day words people actually type.
 *
 *   "3 November", "Nov 3rd 2026", "2026-11-03", "3/11"
 *   "yesterday", "this morning", "tonight", "3 days ago"
 *   "Monday", "last Tuesday", "this past Friday"
 *   "recently", "the other day"  (low confidence: ranking hints, not filters)
 *
 * Why hand-written rules and not a date-parsing library: general parsers
 * default to the *next* Monday or the *nearest* 20 November, which is wrong for
 * questions about the past, and their output needed correcting anyway. These
 * rules are short, each one is tested, and the ambiguous cases deliberately
 * return several candidates instead of guessing.
 */
import { DateTime } from "luxon";
import { MONTH, WEEKDAY } from "../cues";
import type { TimeContext } from "../types";
import {
  type RawReading,
  type ResolverInput,
  type TemporalResolver,
  daySpan,
  instantSpan,
  iso,
  matchAll,
  today,
} from "./base";

const NAME = "explicit";

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const WEEKDAYS: Record<string, number> = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
};
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, "a couple of": 2, couple: 2, "a few": 3, few: 3, several: 4,
};

const monthNum = (s: string) => MONTHS[s.slice(0, 3).toLowerCase()]!;
const weekdayNum = (s: string) => WEEKDAYS[s.slice(0, 3).toLowerCase()]!;

export const explicitResolver: TemporalResolver = {
  name: NAME,
  resolve(input) {
    const out: RawReading[] = [];
    const push = (m: RegExpExecArray, candidates: RawReading["candidates"]) => {
      if (candidates.length) out.push({ index: m.index, length: m[0].length, text: input.text.substr(m.index, m[0].length), candidates });
    };
    const { masked: t, ctx, tense } = input;

    // 2026-11-03
    for (const m of matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/, t)) {
      const d = DateTime.fromObject({ year: +m[1]!, month: +m[2]!, day: +m[3]! }, { zone: ctx.tz });
      if (d.isValid) push(m, [daySpan(iso(d), iso(d), ctx, { confidence: 0.98, resolver: NAME })]);
    }

    // 3/11, 3/11/2026, 03.11.2026. A dot needs a year, or "Python 3.11" becomes a date.
    for (const m of matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b|\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/, t)) {
      const a = +(m[1] ?? m[4])!;
      const b = +(m[2] ?? m[5])!;
      const yRaw = m[3] ?? m[6];
      const year = yRaw ? (yRaw.length === 2 ? 2000 + +yRaw : +yRaw) : undefined;
      push(m, numericDate(a, b, year, ctx, tense));
    }

    // "3 November", "3rd of Nov 2026", "November 3", "Nov 3rd, 2026"
    const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH})\\b(?:,?\\s+(\\d{4}))?`, "i");
    const monthDay = new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "i");
    for (const m of matchAll(dayMonth, t)) push(m, namedDate(+m[1]!, monthNum(m[2]!), m[3] ? +m[3] : undefined, ctx, tense));
    for (const m of matchAll(monthDay, t)) push(m, namedDate(+m[2]!, monthNum(m[1]!), m[3] ? +m[3] : undefined, ctx, tense));

    // "in October", "last October", "October 2026". A bare month needs a
    // preposition or a year, otherwise "may" and "march" (verbs) would match.
    const monthAlone = new RegExp(
      `\\b(?:(in|during|since|last|this|from|until|before|after|early|late|mid)\\s+)(${MONTH})\\b(?:\\s+(\\d{4}))?|\\b(${MONTH})\\s+(\\d{4})\\b`,
      "i",
    );
    for (const m of matchAll(monthAlone, t)) {
      const month = monthNum((m[2] ?? m[4])!);
      const year = m[3] ?? m[5];
      push(m, [monthSpan(month, year ? +year : undefined, (m[1] ?? "").toLowerCase(), ctx, tense)]);
    }

    // Relative day words.
    for (const m of matchAll(/\b(?:the\s+)?day before yesterday\b/i, t)) {
      const d = today(ctx).minus({ days: 2 });
      push(m, [daySpan(iso(d), iso(d), ctx, { confidence: 0.95, resolver: NAME })]);
    }
    for (const m of matchAll(/\b(?<!before\s)yesterday\b/i, t)) push(m, yesterday(ctx));
    for (const m of matchAll(/\b(?:earlier\s+)?today\b/i, t)) push(m, todaySpans(ctx));
    for (const m of matchAll(/\btomorrow\b/i, t)) {
      const d = today(ctx).plus({ days: 1 });
      push(m, [daySpan(iso(d), iso(d), ctx, { confidence: 0.95, resolver: NAME })]);
    }
    for (const m of matchAll(/\b(this\s+(?:morning|afternoon|evening)|tonight|last\s+night)\b/i, t)) {
      push(m, [partOfDay(m[1]!.toLowerCase(), ctx)]);
    }

    // "3 days ago", "two weeks ago", "a few days ago"
    const agoRe = new RegExp(
      `\\b(\\d+|${Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join("|")})\\s+(day|week|month|year)s?\\s+ago\\b`,
      "i",
    );
    for (const m of matchAll(agoRe, t)) push(m, [ago(m[1]!.toLowerCase(), m[2]!.toLowerCase() as Unit, ctx)]);

    // Weekdays: "Monday", "on Monday", "last Tuesday", "this past Friday"
    const weekdayRe = new RegExp(`\\b(?:(last|this past|past|previous|this|next|on)\\s+)?(${WEEKDAY})\\b`, "i");
    for (const m of matchAll(weekdayRe, t)) {
      push(m, weekday(weekdayNum(m[2]!), (m[1] ?? "").toLowerCase(), ctx, tense));
    }

    // Vague references. Low confidence, so retrieval treats them as a nudge
    // towards recent turns rather than a hard date filter.
    for (const m of matchAll(/\b(recently|lately|the other day|a while (?:ago|back))\b/i, t)) {
      push(m, [vague(m[1]!.toLowerCase(), ctx)]);
    }

    return out;
  },
};

// ------------------------------------------------------------------ rules

/**
 * Year for a date written without one. Past-tense questions mean the most
 * recent occurrence ("what did I ask on 20 November" asked on 11 Nov 2026 is
 * 20 Nov 2025); future-tense ones mean the next.
 */
function inferYear(month: number, day: number, ctx: TimeContext, tense: string): { year: number; note?: string } {
  const thisYear = ctx.now.year;
  const candidate = DateTime.fromObject({ year: thisYear, month, day }, { zone: ctx.tz });
  const todayStart = today(ctx);
  if (tense === "future") {
    return candidate < todayStart ? { year: thisYear + 1, note: "future tense, so the next one" } : { year: thisYear };
  }
  if (candidate > todayStart) {
    return { year: thisYear - 1, note: "no year given and it hasn't happened yet this year, so last year's" };
  }
  return { year: thisYear };
}

function namedDate(day: number, month: number, year: number | undefined, ctx: TimeContext, tense: string) {
  const y = year ? { year } : inferYear(month, day, ctx, tense);
  const d = DateTime.fromObject({ year: y.year, month, day }, { zone: ctx.tz });
  if (!d.isValid) return [];
  return [daySpan(iso(d), iso(d), ctx, { confidence: year ? 0.98 : 0.9, resolver: NAME, note: y.note })];
}

/**
 * "3/11": 3 November in most of the world, March 11 in the US. If one number
 * is above 12 the order is obvious. Otherwise return both, locale order
 * first, and let memory or the user settle it.
 */
function numericDate(a: number, b: number, year: number | undefined, ctx: TimeContext, tense: string) {
  const orders: Array<{ day: number; month: number; conf: number; note?: string }> = [];
  if (a > 12 && b <= 12) orders.push({ day: a, month: b, conf: 0.95 });
  else if (b > 12 && a <= 12) orders.push({ day: b, month: a, conf: 0.95 });
  else if (a <= 12 && b <= 12) {
    const dayFirst = { day: a, month: b };
    const monthFirst = { day: b, month: a };
    const [first, second] = ctx.dayFirst ? [dayFirst, monthFirst] : [monthFirst, dayFirst];
    orders.push({ ...first, conf: 0.7, note: `read as ${ctx.dayFirst ? "day/month" : "month/day"} for ${ctx.locale}` });
    if (a !== b) orders.push({ ...second, conf: 0.3, note: "the other day/month order" });
  }
  return orders.flatMap((o) =>
    namedDate(o.day, o.month, year, ctx, tense).map((s) => ({ ...s, confidence: o.conf, note: o.note ?? s.note })),
  );
}

function monthSpan(month: number, year: number | undefined, prefix: string, ctx: TimeContext, tense: string) {
  const now = ctx.now;
  let y = year ?? now.year;
  if (!year) {
    if (prefix === "this") y = now.year;
    // "last October" in November means this year's October; "last November" means a year ago.
    else if (prefix === "last") y = month < now.month ? now.year : now.year - 1;
    else if (tense === "future") y = month < now.month ? now.year + 1 : now.year;
    else y = month > now.month ? now.year - 1 : now.year;
  }
  const first = DateTime.fromObject({ year: y, month, day: 1 }, { zone: ctx.tz });
  const last = first.endOf("month");
  return daySpan(iso(first), iso(last), ctx, {
    granularity: "month",
    confidence: year ? 0.95 : 0.8,
    resolver: NAME,
    label: first.toFormat("LLLL yyyy"),
  });
}

/**
 * Late at night "yesterday" is genuinely ambiguous: at 00:30 someone who
 * hasn't slept may mean the day before the one that just ended. Offer both
 * and let memory decide.
 */
function yesterday(ctx: TimeContext) {
  const d = today(ctx).minus({ days: 1 });
  const spans = [daySpan(iso(d), iso(d), ctx, { confidence: 0.9, resolver: NAME })];
  if (ctx.now.hour < 4) {
    const e = d.minus({ days: 1 });
    spans[0]!.confidence = 0.65;
    spans.push(daySpan(iso(e), iso(e), ctx, { confidence: 0.35, resolver: NAME, note: "just after midnight, so possibly the day before" }));
  }
  return spans;
}

function todaySpans(ctx: TimeContext) {
  const d = today(ctx);
  const spans = [daySpan(iso(d), iso(d), ctx, { confidence: 0.95, resolver: NAME })];
  if (ctx.now.hour < 4) {
    const prev = d.minus({ days: 1 });
    spans[0]!.confidence = 0.6;
    spans.push(daySpan(iso(prev), iso(prev), ctx, { confidence: 0.4, resolver: NAME, note: "just after midnight, so possibly the day that just ended" }));
  }
  return spans;
}

function partOfDay(what: string, ctx: TimeContext) {
  const d = today(ctx);
  const at = (base: DateTime, h: number) => base.set({ hour: h, minute: 0, second: 0, millisecond: 0 });
  switch (what.replace(/\s+/g, " ")) {
    case "this morning":
      return instantSpan(at(d, 5), at(d, 12), { confidence: 0.85, resolver: NAME, label: `this morning (${d.toFormat("ccc d LLL")})` });
    case "this afternoon":
      return instantSpan(at(d, 12), at(d, 17), { confidence: 0.85, resolver: NAME, label: `this afternoon (${d.toFormat("ccc d LLL")})` });
    case "this evening":
      return instantSpan(at(d, 17), at(d, 23), { confidence: 0.85, resolver: NAME, label: `this evening (${d.toFormat("ccc d LLL")})` });
    case "tonight":
      return instantSpan(at(d, 17), at(d.plus({ days: 1 }), 4), { confidence: 0.85, resolver: NAME, label: `tonight (${d.toFormat("ccc d LLL")})` });
    default: {
      const y = d.minus({ days: 1 });
      return instantSpan(at(y, 17), at(d, 4), { confidence: 0.85, resolver: NAME, label: `last night (${y.toFormat("ccc d LLL")})` });
    }
  }
}

type Unit = "day" | "week" | "month" | "year";

/**
 * "N units ago". Exact for days; the bigger the unit, the looser people are,
 * so the window widens and confidence drops.
 */
function ago(qty: string, unit: Unit, ctx: TimeContext) {
  const vagueQty = ["a few", "few", "several", "a couple of", "couple"].includes(qty);
  const n = /^\d+$/.test(qty) ? +qty : NUMBER_WORDS[qty] ?? 1;
  const center = today(ctx).minus({ [`${unit}s`]: n });
  const slack = { day: vagueQty ? 2 : 0, week: 2, month: 10, year: 45 }[unit];
  const conf = { day: vagueQty ? 0.45 : 0.9, week: 0.6, month: 0.5, year: 0.4 }[unit];
  const from = center.minus({ days: slack });
  const to = DateTime.min(center.plus({ days: slack }), today(ctx));
  return daySpan(iso(from), iso(to), ctx, {
    confidence: conf,
    resolver: NAME,
    label: slack ? `around ${center.toFormat("ccc d LLL yyyy")}` : undefined,
  });
}

/**
 * Weekday references. The tricky cases are the whole reason this is
 * hand-written:
 *  - "on Monday" said on a Monday: today, or a week ago?
 *  - "last Tuesday" said on a Wednesday: yesterday, or the Tuesday of the
 *    previous week? English speakers genuinely disagree.
 * Both return two candidates; memory usually knows which one has the
 * conversation in it.
 */
function weekday(target: number, modifier: string, ctx: TimeContext, tense: string) {
  const t = today(ctx);
  const back = (t.weekday - target + 7) % 7; // days back to the most recent such weekday (0 = today)
  const mostRecentPast = t.minus({ days: back || 7 });
  const weekStart = t.minus({ days: (t.weekday - ctx.weekStartsOn + 7) % 7 });
  const inPrevWeek = weekStart.minus({ days: 7 }).plus({ days: (target - ctx.weekStartsOn + 7) % 7 });
  const inThisWeek = weekStart.plus({ days: (target - ctx.weekStartsOn + 7) % 7 });
  const upcoming = t.plus({ days: (target - t.weekday + 7) % 7 || 7 });

  const span = (d: DateTime, confidence: number, note?: string) =>
    daySpan(iso(d), iso(d), ctx, { confidence, resolver: NAME, note });

  switch (modifier) {
    case "last":
    case "previous":
      if (iso(mostRecentPast) === iso(inPrevWeek)) return [span(mostRecentPast, 0.9)];
      return [
        span(mostRecentPast, 0.6, "the most recent one"),
        span(inPrevWeek, 0.4, "the one in the previous calendar week"),
      ];
    case "past":
    case "this past":
      return [span(mostRecentPast, 0.9)];
    case "this":
      if (tense !== "future" && inThisWeek > t) return [span(mostRecentPast, 0.7, "this week's hasn't happened yet")];
      return [span(inThisWeek, 0.8)];
    case "next":
      if (iso(upcoming) === iso(inThisWeek.plus({ days: 7 }))) return [span(upcoming, 0.85)];
      return [span(upcoming, 0.6, "the next one"), span(inThisWeek.plus({ days: 7 }), 0.4, "the one in next calendar week")];
    default:
      if (tense === "future") return [span(back === 0 ? t : upcoming, 0.85)];
      if (back === 0) {
        return [span(t.minus({ days: 7 }), 0.55, "a week ago"), span(t, 0.45, "today")];
      }
      return [span(mostRecentPast, 0.9)];
  }
}

function vague(what: string, ctx: TimeContext) {
  const t = today(ctx);
  const range = (fromDays: number, toDays: number, conf: number, label: string) =>
    daySpan(iso(t.minus({ days: fromDays })), iso(t.minus({ days: toDays })), ctx, { confidence: conf, resolver: NAME, label });
  if (what === "the other day") return range(6, 1, 0.4, "a few days ago");
  if (what.startsWith("a while")) return range(60, 7, 0.25, "a while ago");
  return range(14, 0, 0.3, "in the last two weeks");
}
