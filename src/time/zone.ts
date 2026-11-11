/**
 * Timezone and calendar helpers. Pure functions, no I/O.
 *
 * Rules this file exists to enforce:
 *  - Never read the server's local zone. Every computation names its zone.
 *  - Never add 86_400_000 ms to get "tomorrow". Daylight-saving days are 23
 *    or 25 hours long; Luxon's calendar maths handles that.
 *  - Zones are IANA names ("Asia/Kolkata"), never fixed offsets, so +05:30,
 *    +05:45 and DST all come out right.
 */
import { DateTime, IANAZone } from "luxon";

export function isValidZone(tz: string | undefined | null): tz is string {
  return !!tz && IANAZone.isValidZone(tz);
}

/** Calendar day (YYYY-MM-DD) of an instant, as seen on a clock set to `tz`. */
export function dayOf(ms: number, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz }).toISODate()!;
}

/** Offset from UTC in minutes for an instant in a zone (+330 for IST). */
export function offsetMinutes(ms: number, tz: string): number {
  return DateTime.fromMillis(ms, { zone: tz }).offset;
}

/** [start, end) instants for an inclusive range of calendar days in a zone. */
export function daysToInstants(from: string, to: string, tz: string): [number, number] {
  const start = DateTime.fromISO(from, { zone: tz }).startOf("day");
  const end = DateTime.fromISO(to, { zone: tz }).startOf("day").plus({ days: 1 });
  return [start.toMillis(), end.toMillis()];
}

/** Shift a YYYY-MM-DD string by whole days, calendar-safe. */
export function shiftDay(day: string, days: number): string {
  return DateTime.fromISO(day, { zone: "UTC" }).plus({ days }).toISODate()!;
}

/** "Tue 3 Nov 2026" */
export function formatDay(day: string): string {
  return DateTime.fromISO(day, { zone: "UTC" }).toFormat("ccc d LLL yyyy");
}

/** "Tue 3 Nov 2026, 9:14 pm IST" in the given zone. */
export function formatInstant(ms: number, tz: string): string {
  const dt = DateTime.fromMillis(ms, { zone: tz });
  return `${dt.toFormat("ccc d LLL yyyy, h:mm a").replace("AM", "am").replace("PM", "pm")} ${zoneAbbrev(dt)}`;
}

function zoneAbbrev(dt: DateTime): string {
  // Luxon gives "GMT+5:30" for zones without a common abbreviation; that's
  // still unambiguous, so it's fine to show.
  return dt.toFormat("ZZZZ");
}

/**
 * Human age of a past day relative to today, computed here so the model never
 * has to subtract dates (it gets that wrong surprisingly often).
 */
export function ageOfDay(day: string, today: string): string {
  const d = DateTime.fromISO(day, { zone: "UTC" });
  const t = DateTime.fromISO(today, { zone: "UTC" });
  const diff = Math.round(t.diff(d, "days").days);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff === -1) return "tomorrow";
  if (diff < 0) return `in ${-diff} days`;
  if (diff < 14) return `${diff} days ago`;
  if (diff < 60) return `${Math.round(diff / 7)} weeks ago`;
  if (diff < 730) return `${Math.round(diff / 30.4)} months ago`;
  return `${Math.round(diff / 365)} years ago`;
}

/** First day of the week for a locale: 7 (Sunday) or 1 (Monday). */
export function weekStartFor(locale: string): 1 | 7 {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info) return info.firstDay === 7 ? 7 : 1;
  } catch {
    // fall through to the region heuristic
  }
  const region = locale.split("-")[1]?.toUpperCase();
  return region && ["US", "CA", "JP", "BR", "MX", "PH", "IL", "KR", "TW"].includes(region) ? 7 : 1;
}

/** Whether "3/11" means 3 November in this locale (true) or March 11 (false). */
export function isDayFirst(locale: string): boolean {
  try {
    const parts = new Intl.DateTimeFormat(locale, { day: "numeric", month: "numeric" }).formatToParts(
      new Date(Date.UTC(2026, 10, 3)),
    );
    const order = parts.filter((p) => p.type === "day" || p.type === "month").map((p) => p.type);
    return order[0] === "day";
  } catch {
    return true;
  }
}
