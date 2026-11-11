/**
 * Builds the TimeContext for one request.
 *
 * Which zone to use, in order of trust:
 *   1. declared: the user told us ("I'm in London now", or the UI timezone chip)
 *   2. browser:  Intl.DateTimeFormat().resolvedOptions().timeZone from the client
 *   3. fallback: the last zone we saw for this user, then UTC
 *
 * We never use location or IP. The question is what the user's *clock* says,
 * because that's the calendar they think in. If they travel and their laptop
 * updates its zone, the browser reports the new one; if it doesn't, their
 * dates haven't changed either.
 */
import { DateTime } from "luxon";
import type { Clock } from "./clock";
import type { TimeContext, TzSource } from "./types";
import { isDayFirst, isValidZone, weekStartFor } from "./zone";

export interface ZoneHints {
  browserTz?: string | null;
  declaredTz?: string | null;
  lastSeenTz?: string | null;
  locale?: string | null;
}

export function buildTimeContext(clock: Clock, hints: ZoneHints): TimeContext {
  let tz: string;
  let tzSource: TzSource;

  if (isValidZone(hints.declaredTz)) {
    tz = hints.declaredTz;
    tzSource = "declared";
  } else if (isValidZone(hints.browserTz)) {
    tz = hints.browserTz;
    tzSource = "browser";
  } else if (isValidZone(hints.lastSeenTz)) {
    tz = hints.lastSeenTz;
    tzSource = "fallback";
  } else {
    tz = "UTC";
    tzSource = "fallback";
  }

  const locale = normaliseLocale(hints.locale);
  const nowMs = clock.now();

  return {
    nowMs,
    now: DateTime.fromMillis(nowMs, { zone: tz }),
    tz,
    tzSource,
    locale,
    weekStartsOn: weekStartFor(locale),
    dayFirst: isDayFirst(locale),
    frozen: clock.frozen,
    previousTz: hints.lastSeenTz && hints.lastSeenTz !== tz ? hints.lastSeenTz : undefined,
  };
}

function normaliseLocale(locale?: string | null): string {
  if (!locale) return "en-GB";
  try {
    return new Intl.Locale(locale).toString();
  } catch {
    return "en-GB";
  }
}
