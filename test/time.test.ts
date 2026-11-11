/**
 * Time module tests. Every case uses a FixedClock, so they're deterministic.
 * Test names carry the edge-case IDs from the design notes (T1, T2, ...).
 *
 * Reference "now" for most cases: Wednesday 11 Nov 2026, 10:00 IST.
 */
import { describe, expect, it } from "vitest";
import {
  type AnchorLookup,
  FixedClock,
  buildTimeContext,
  dayOf,
  decide,
  daysToInstants,
  memoryFilterOf,
  readTime,
  searchWindowOf,
} from "../src/time";

const noAnchors: AnchorLookup = {
  lastVisit: () => null,
  findTurnAbout: () => null,
  previousAnswerTs: () => null,
};

function ctxAt(iso: string, tz = "Asia/Kolkata", locale = "en-IN") {
  return buildTimeContext(new FixedClock(iso), { browserTz: tz, locale });
}

async function read(text: string, ctx = ctxAt("2026-11-11T10:00:00+05:30"), anchors = noAnchors) {
  return readTime(text, ctx, { anchors });
}

const days = (r: { candidates: { days?: { from: string; to: string } }[] }) => r.candidates.map((c) => c.days);

describe("explicit dates", () => {
  it("T3: a date without a year in a past-tense question is the most recent one", async () => {
    const [r] = await read("What did I ask you on 3 November? Is your answer still correct today?");
    expect(r!.candidates[0]!.days).toEqual({ from: "2026-11-03", to: "2026-11-03" });
    expect(r!.target).not.toBe("world");
  });

  it("T15: in 'what did I ask on 3 Nov, is it still correct today', only 3 Nov is about memory", async () => {
    const readings = await read("What did I ask you on 3 November? Is your answer still correct today?");
    expect(readings.map((r) => [r.text, r.target])).toEqual([
      ["3 November", "both"],
      ["today", "world"],
    ]);
  });

  it("T15: a date about the world isn't a memory filter", async () => {
    const [r] = await read("What did Salesforce announce on 3 November?");
    expect(r!.target).toBe("world");
  });

  it("T3: a date later in the year than today means last year when asking about the past", async () => {
    const [r] = await read("What did I ask on 20 November?");
    expect(r!.candidates[0]!.days!.from).toBe("2025-11-20");
  });

  it("T3: the same date in a future-tense sentence means this year", async () => {
    const [r] = await read("Will HubSpot change pricing on 20 November?");
    expect(r!.candidates[0]!.days!.from).toBe("2026-11-20");
  });

  it("T4: 3/11 follows the locale, with the other order as a fallback", async () => {
    const [inIndia] = await read("what did we discuss on 3/11");
    expect(days(inIndia!)[0]!.from).toBe("2026-11-03");
    expect(days(inIndia!)[1]!.from).toBe("2026-03-11");

    const [inUs] = await read("what did we discuss on 3/11", ctxAt("2026-11-11T10:00:00-05:00", "America/New_York", "en-US"));
    expect(days(inUs!)[0]!.from).toBe("2026-03-11");
  });

  it("T4: an impossible order is not offered", async () => {
    const [r] = await read("what did we discuss on 25/10");
    expect(r!.candidates).toHaveLength(1);
    expect(r!.candidates[0]!.days!.from).toBe("2026-10-25");
  });

  it("version numbers are not dates", async () => {
    expect(await read("Does Neon support Python 3.11 and Postgres 17.2?")).toEqual([]);
  });

  it("T13: Monday.com is a product, not a Monday", async () => {
    expect(await read("Is Monday.com cheaper than HubSpot for 20 seats?")).toEqual([]);
  });

  it("T14: no time words, no readings", async () => {
    expect(await read("Which Postgres host has the best free tier?")).toEqual([]);
  });
});

describe("weekdays", () => {
  it("T2: 'last Tuesday' on a Wednesday offers yesterday first, then the week before", async () => {
    const [r] = await read("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    expect(days(r!).map((d) => d!.from)).toEqual(["2026-11-10", "2026-11-03"]);
    expect(r!.target).toBe("both");
  });

  it("T2: 'since then' runs from the date mentioned earlier to now", async () => {
    const readings = await read("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    const since = readings.find((r) => r.text.toLowerCase() === "since then")!;
    expect(since.candidates[0]!.days).toEqual({ from: "2026-11-10", to: "2026-11-11" });
  });

  it("T1: 'on Monday' said on a Monday could be today or a week ago", async () => {
    const monday = ctxAt("2026-11-09T18:00:00+05:30");
    const [r] = await read("On Monday we shortlisted 5 CRM tools", monday);
    expect(days(r!).map((d) => d!.from)).toEqual(["2026-11-02", "2026-11-09"]);
  });

  it("the CRM example: Monday plus a bare trailing 'since'", async () => {
    const readings = await read(
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    );
    expect(readings[0]!.candidates[0]!.days!.from).toBe("2026-11-09");
    expect(readings[0]!.target).toBe("both");
    const since = readings.at(-1)!;
    expect(since.candidates[0]!.days).toEqual({ from: "2026-11-09", to: "2026-11-11" });
  });

  it("plural weekdays and short words are ignored", async () => {
    expect(await read("I usually sat with the team on Mondays")).toEqual([]);
  });
});

describe("periods", () => {
  it("T5: 'last week' is the previous calendar week, with the rolling week as an alternative", async () => {
    const [r] = await read("what did we talk about last week?", ctxAt("2026-11-11T10:00:00+00:00", "Europe/London", "en-GB"));
    expect(days(r!)[0]).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(days(r!)[1]).toEqual({ from: "2026-11-04", to: "2026-11-10" });
  });

  it("T5: week start comes from locale data, not a guess (CLDR puts India on Sunday)", async () => {
    const [r] = await read("what did we talk about last week?");
    expect(days(r!)[0]).toEqual({ from: "2026-11-01", to: "2026-11-07" });
  });

  it("T5: in the US the week starts on Sunday", async () => {
    const [r] = await read("what did we talk about last week?", ctxAt("2026-11-11T10:00:00-05:00", "America/New_York", "en-US"));
    expect(days(r!)[0]).toEqual({ from: "2026-11-01", to: "2026-11-07" });
  });

  it("quarters resolve to whole quarters", async () => {
    const [r] = await read("any big launches in Q3?");
    expect(days(r!)[0]).toEqual({ from: "2026-07-01", to: "2026-09-30" });
  });

  it("T10: fiscal year follows the locale (India starts in April)", async () => {
    const [r] = await read("revenue this fiscal year");
    expect(days(r!)[0]).toEqual({ from: "2026-04-01", to: "2027-03-31" });
  });

  it("T6: vague references are low confidence", async () => {
    const [r] = await read("you mentioned a Postgres host the other day");
    expect(r!.candidates[0]!.confidence).toBeLessThan(0.5);
  });

  it("T9: 'since Monday' is a range up to today", async () => {
    const [r] = await read("has HubSpot changed pricing since Monday?");
    expect(r!.candidates[0]!.days).toEqual({ from: "2026-11-09", to: "2026-11-11" });
  });
});

describe("clocks and zones", () => {
  it("T18: just after midnight, 'yesterday' might mean the day before", async () => {
    const lateNight = ctxAt("2026-11-11T00:30:00+05:30");
    const [r] = await read("what did I ask yesterday?", lateNight);
    expect(days(r!).map((d) => d!.from)).toEqual(["2026-11-10", "2026-11-09"]);
  });

  it("T21: a daylight-saving day is 25 hours long, not 24", () => {
    // US clocks went back on Sunday 1 Nov 2026.
    const [start, end] = daysToInstants("2026-11-01", "2026-11-01", "America/New_York");
    expect((end - start) / 3_600_000).toBe(25);
  });

  it("T22: 45-minute offsets land on the right calendar day", () => {
    // 18:30 UTC is 00:15 the next day in Kathmandu (+05:45).
    expect(dayOf(Date.parse("2026-11-10T18:30:00Z"), "Asia/Kathmandu")).toBe("2026-11-11");
    expect(dayOf(Date.parse("2026-11-10T18:30:00Z"), "Asia/Kolkata")).toBe("2026-11-11");
    expect(dayOf(Date.parse("2026-11-10T18:15:00Z"), "Asia/Kolkata")).toBe("2026-11-10");
  });

  it("T24: an invalid browser zone falls back to the last known one, then UTC", () => {
    const clock = new FixedClock("2026-11-11T10:00:00Z");
    expect(buildTimeContext(clock, { browserTz: "Mars/Olympus", lastSeenTz: "Europe/London" }).tz).toBe("Europe/London");
    expect(buildTimeContext(clock, { browserTz: undefined }).tz).toBe("UTC");
  });

  it("T25: a declared zone wins over the browser", () => {
    const ctx = buildTimeContext(new FixedClock("2026-11-11T10:00:00Z"), { browserTz: "Asia/Kolkata", declaredTz: "Europe/London" });
    expect(ctx.tz).toBe("Europe/London");
    expect(ctx.tzSource).toBe("declared");
  });
});

describe("memory anchors", () => {
  it("T7: 'since I asked about Postgres' starts at that turn", async () => {
    const asked = Date.parse("2026-11-04T15:00:00+05:30");
    const anchors: AnchorLookup = {
      ...noAnchors,
      findTurnAbout: (topic) => (topic.toLowerCase().includes("postgres") ? { ts: asked, localDay: "2026-11-04", preview: "" } : null),
    };
    const [r] = await read("has anything changed since I asked about Postgres hosting?", undefined, anchors);
    expect(r!.candidates[0]!.start).toBe(asked);
    expect(r!.candidates[0]!.days!.from).toBe("2026-11-04");
  });
});

describe("policy", () => {
  it("memory settles an ambiguous weekday", async () => {
    const readings = await read("Last Tuesday I asked you about Postgres hosting");
    // Pretend the Postgres conversation happened on 3 Nov, not 10 Nov.
    const [resolved] = decide(readings, (span) => (span.days?.from === "2026-11-03" ? 2 : 0));
    expect(resolved!.chosen.days!.from).toBe("2026-11-03");
    expect(resolved!.decision).toBe("use-and-state");
  });

  it("T2: 'since then' follows memory's choice of Tuesday, not the first guess", async () => {
    const readings = await read("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    const resolved = decide(readings, (span) => (span.days?.from === "2026-11-03" ? 2 : 0));
    const since = resolved.find((r) => r.reading.text.toLowerCase() === "since then")!;
    expect(since.chosen.days).toEqual({ from: "2026-11-03", to: "2026-11-11" });
    expect(searchWindowOf(resolved, ctxAt("2026-11-11T10:00:00+05:30"))!.since).toBe("2026-11-02");
  });

  it("both readings with conversations means cover both", async () => {
    const readings = await read("Last Tuesday I asked you about Postgres hosting");
    const [resolved] = decide(readings, () => 1);
    expect(resolved!.decision).toBe("answer-both");
    expect(resolved!.filterSpans).toHaveLength(2);
  });

  it("adapters: memory gets the day, search gets a window widened by a day", async () => {
    const resolved = decide(await read("On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?"));
    const mem = memoryFilterOf(resolved)!;
    expect(mem.dayRanges[0]).toEqual({ from: "2026-11-09", to: "2026-11-09" });
    const win = searchWindowOf(resolved, ctxAt("2026-11-11T10:00:00+05:30"))!;
    expect(win.since).toBe("2026-11-08");
    expect(win.until).toBeUndefined();
  });
});
