/**
 * Calendar resolver: periods rather than days.
 *
 *   "last week", "this month", "past year", "Q3", "last quarter"
 *   "this weekend", "earlier this week", "this fiscal year"
 *   "Christmas", "New Year", "Black Friday"
 *
 * "Last week" is the classic trap: the previous calendar week, or the last
 * seven days? Both are returned, calendar week first, and memory picks the
 * one that has the conversation in it. Week start (Monday or Sunday) comes
 * from the user's locale.
 */
import { DateTime } from "luxon";
import type { TimeContext } from "../types";
import { type RawReading, type TemporalResolver, daySpan, iso, matchAll, today } from "./base";

const NAME = "calendar";

export const calendarResolver: TemporalResolver = {
  name: NAME,
  resolve({ masked: t, text, ctx, tense }) {
    const out: RawReading[] = [];
    const push = (m: RegExpExecArray, candidates: RawReading["candidates"]) => {
      if (candidates.length) out.push({ index: m.index, length: m[0].length, text: text.substr(m.index, m[0].length), candidates });
    };

    for (const m of matchAll(/\b(earlier\s+this|last|this|past|previous|next)\s+(week|month|year|quarter)\b/i, t)) {
      push(m, period(m[1]!.toLowerCase().replace(/\s+/g, " "), m[2]!.toLowerCase() as PeriodUnit, ctx));
    }
    for (const m of matchAll(/\b(?:(this|last|next)\s+)?weekend\b/i, t)) {
      push(m, [weekend((m[1] ?? "").toLowerCase(), ctx, tense)]);
    }
    for (const m of matchAll(/\bq([1-4])(?:\s+(\d{4}))?\b/i, t)) {
      push(m, [quarter(+m[1]!, m[2] ? +m[2] : undefined, ctx, tense)]);
    }
    for (const m of matchAll(/\b(this|last|next)\s+(?:fy|fiscal(?:\s+year)?)\b/i, t)) {
      push(m, [fiscalYear(m[1]!.toLowerCase(), ctx)]);
    }
    for (const m of matchAll(/\b(christmas|new year(?:'s)?(?:\s+day)?|black friday)\b/i, t)) {
      push(m, [holiday(m[1]!.toLowerCase(), ctx, tense)]);
    }
    return out;
  },
};

type PeriodUnit = "week" | "month" | "year" | "quarter";

function startOfWeek(d: DateTime, ctx: TimeContext) {
  return d.minus({ days: (d.weekday - ctx.weekStartsOn + 7) % 7 }).startOf("day");
}

function period(which: string, unit: PeriodUnit, ctx: TimeContext) {
  const t = today(ctx);
  const span = (from: DateTime, to: DateTime, confidence: number, label: string, note?: string) =>
    daySpan(iso(from), iso(to), ctx, { granularity: unit, confidence, resolver: NAME, label, note });

  const startOf = (d: DateTime) => (unit === "week" ? startOfWeek(d, ctx) : d.startOf(unit));
  const endOf = (d: DateTime) => (unit === "week" ? startOfWeek(d, ctx).plus({ days: 6 }) : d.endOf(unit).startOf("day"));
  const step = { [`${unit}s`]: 1 } as Record<string, number>;

  switch (which) {
    case "this":
      return [span(startOf(t), endOf(t), 0.9, `this ${unit}`)];
    case "earlier this":
      return [span(startOf(t), t, 0.85, `earlier this ${unit}`)];
    case "next": {
      const n = t.plus(step);
      return [span(startOf(n), endOf(n), 0.85, `next ${unit}`)];
    }
    case "past": {
      // "the past week" is a rolling window ending today.
      const from = t.minus(step).plus({ days: 1 });
      return [span(from, t, 0.85, `the past ${unit}`)];
    }
    default: {
      // last / previous: the previous calendar period, with the rolling window as a fallback reading.
      const p = t.minus(step);
      const calendar = span(startOf(p), endOf(p), 0.7, `last ${unit} (${startOf(p).toFormat("d LLL")} to ${endOf(p).toFormat("d LLL")})`);
      const rolling = span(t.minus(step), t.minus({ days: 1 }), 0.3, `the ${unit} before today`, `rolling ${unit} instead of calendar ${unit}`);
      return [calendar, rolling];
    }
  }
}

function weekend(which: string, ctx: TimeContext, tense: string) {
  const t = today(ctx);
  // Saturday of the current week (Luxon: 6 = Saturday).
  const sat = t.minus({ days: (t.weekday - 6 + 7) % 7 });
  const isWeekendNow = t.weekday >= 6;
  let start: DateTime;
  if (which === "next") start = isWeekendNow ? sat.plus({ days: 7 }) : t.plus({ days: (6 - t.weekday + 7) % 7 });
  else if (which === "last") start = isWeekendNow ? sat.minus({ days: 7 }) : sat;
  else if (tense === "future" && !isWeekendNow) start = t.plus({ days: (6 - t.weekday + 7) % 7 });
  else start = sat;
  const end = start.plus({ days: 1 });
  return daySpan(iso(start), iso(end), ctx, { granularity: "day", confidence: 0.8, resolver: NAME, label: `the weekend of ${start.toFormat("d LLL")}` });
}

function quarter(q: number, year: number | undefined, ctx: TimeContext, tense: string) {
  let y = year ?? ctx.now.year;
  const currentQ = Math.ceil(ctx.now.month / 3);
  if (!year && tense !== "future" && q > currentQ) y -= 1;
  const from = DateTime.fromObject({ year: y, month: (q - 1) * 3 + 1, day: 1 }, { zone: ctx.tz });
  const to = from.plus({ months: 3 }).minus({ days: 1 });
  return daySpan(iso(from), iso(to), ctx, { granularity: "quarter", confidence: year ? 0.95 : 0.85, resolver: NAME, label: `Q${q} ${y}` });
}

/**
 * Fiscal years differ by country (India and Japan start in April, Australia
 * in July). We go by locale region and always say which one we assumed.
 */
function fiscalYear(which: string, ctx: TimeContext) {
  const region = ctx.locale.split("-")[1]?.toUpperCase() ?? "";
  const startMonth = ["IN", "JP", "GB", "NZ", "HK"].includes(region) ? 4 : region === "AU" ? 7 : 1;
  const now = ctx.now;
  let startYear = now.month >= startMonth ? now.year : now.year - 1;
  if (which === "last") startYear -= 1;
  if (which === "next") startYear += 1;
  const from = DateTime.fromObject({ year: startYear, month: startMonth, day: 1 }, { zone: ctx.tz });
  const to = from.plus({ years: 1 }).minus({ days: 1 });
  return daySpan(iso(from), iso(to), ctx, {
    granularity: "year",
    confidence: 0.6,
    resolver: NAME,
    label: `FY ${from.toFormat("LLL yyyy")} to ${to.toFormat("LLL yyyy")}`,
    note: startMonth === 1 ? "assumed the calendar year" : `assumed a fiscal year starting in ${from.toFormat("LLLL")} (${region})`,
  });
}

function holiday(name: string, ctx: TimeContext, tense: string) {
  const dateIn = (year: number) => {
    if (name.startsWith("christmas")) return DateTime.fromObject({ year, month: 12, day: 25 }, { zone: ctx.tz });
    if (name.startsWith("new year")) return DateTime.fromObject({ year, month: 1, day: 1 }, { zone: ctx.tz });
    // Black Friday: the day after the fourth Thursday of November.
    const nov1 = DateTime.fromObject({ year, month: 11, day: 1 }, { zone: ctx.tz });
    const firstThu = nov1.plus({ days: (4 - nov1.weekday + 7) % 7 });
    return firstThu.plus({ days: 22 });
  };
  const t = today(ctx);
  let d = dateIn(t.year);
  if (tense === "future" && d < t) d = dateIn(t.year + 1);
  if (tense !== "future" && d > t) d = dateIn(t.year - 1);
  return daySpan(iso(d), iso(d), ctx, { confidence: 0.85, resolver: NAME });
}
