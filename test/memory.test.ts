/**
 * Memory and recall tests: the whole PRE stage (time + memory + context
 * block) with no model and no network. A scripted fake worker stands in for
 * the claim extractor, and a hashing embedder stands in for the real model.
 *
 * Test names carry the edge-case IDs (M#, R#) from the design notes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { HashEmbedder } from "../src/embed";
import type { WorkerLlm } from "../src/llm/types";
import { redact } from "../src/memory/redact";
import { ftsQuery } from "../src/memory/retrieve/query";
import { FixedClock } from "../src/time";

const USER = "local";
const IST = "Asia/Kolkata";

/** Worker that returns canned claims for answers mentioning HubSpot, and nothing else. */
const fakeWorker: WorkerLlm = {
  async json(_schema, args) {
    if (args.system.startsWith("You build a ledger")) {
      if (!args.user.includes("HubSpot Starter")) return { claims: [] } as never;
      return {
        claims: [
          {
            said_by: "assistant", entity: "HubSpot", entity_type: "product", attribute: "price", value: "$20",
            unit: null, plan: "Starter", billing_period: "monthly", region: null, currency: "USD", seats: null,
            quote: "HubSpot Starter is $20 per seat per month [S1].", source_ids: ["S1"],
          },
          {
            // Not in the answer: must be rejected by the quote check (M5).
            said_by: "assistant", entity: "Pipedrive", entity_type: "product", attribute: "price", value: "$99",
            unit: null, plan: null, billing_period: null, region: null, currency: null, seats: null,
            quote: "Pipedrive costs $99.", source_ids: [],
          },
        ],
      } as never;
    }
    if (args.system.includes("diary")) return { summary: "Discussed CRMs.", entities: ["HubSpot"] } as never;
    return { skip: true, topic_id: null, label: "", summary: "", open_items: [], entities: [] } as never;
  },
};

let clock: FixedClock;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  clock = new FixedClock("2026-11-09T11:00:00+05:30"); // Monday
  app = createApp({ dbPath: ":memory:", clock, embedder: new HashEmbedder(), worker: fakeWorker });
});

/** Write a finished turn into the log as if it had happened at `at`. */
async function pastTurn(at: string, question: string, answer: string, tz = IST) {
  clock.set(at);
  const thread = app.store.createThread(USER, clock.now());
  const q = app.store.appendMessage({ threadId: thread.id, userId: USER, role: "user", content: question, tsUtc: clock.now(), tz, tzSource: "browser" });
  app.store.appendSearch({
    turnId: q.id, userId: USER, provider: "test", query: "hubspot pricing", params: {},
    results: [{ id: "S1", title: "HubSpot pricing", url: "https://www.hubspot.com/pricing", content: "", publishedAt: null }],
    tsUtc: clock.now(),
  });
  app.store.appendMessage({ threadId: thread.id, userId: USER, role: "assistant", content: answer, tsUtc: clock.now() + 5000, tz, tzSource: "browser", replyTo: q.id });
  app.derivation.afterTurn(q.id);
  await app.derivation.queue.drain();
  return q.id;
}

const CRM_Q = "Shortlist 5 CRM tools for a 20-person sales team";
const CRM_A = "Here are five: HubSpot, Pipedrive, Salesforce, Zoho, Close. HubSpot Starter is $20 per seat per month [S1].";

describe("store (M)", () => {
  it("stores local_day in the user's zone, not UTC", async () => {
    // 00:30 IST on 4 Nov is still 3 Nov in UTC.
    const id = await pastTurn("2026-11-04T00:30:00+05:30", "late night question", "answer");
    expect(app.store.message(id)!.local_day).toBe("2026-11-04");
  });

  it("M5: claims whose quote isn't in the answer are dropped", async () => {
    const id = await pastTurn("2026-11-09T10:00:00+05:30", CRM_Q, CRM_A);
    const claims = app.db.prepare("SELECT c.value, e.canonical FROM claims c JOIN entities e ON e.id = c.entity_id WHERE turn_id = ?").all(id);
    expect(claims).toEqual([{ value: "$20", canonical: "HubSpot" }]);
  });

  it("M3: claims keep their source", async () => {
    const id = await pastTurn("2026-11-09T10:00:00+05:30", CRM_Q, CRM_A);
    const row = app.db.prepare("SELECT source_url, status FROM claims WHERE turn_id = ?").get(id) as { source_url: string; status: string };
    expect(row).toEqual({ source_url: "https://www.hubspot.com/pricing", status: "sourced" });
  });

  it("M12: forgetting a turn removes it and everything derived from it", async () => {
    const id = await pastTurn("2026-11-09T10:00:00+05:30", CRM_Q, CRM_A);
    app.store.forgetTurn(USER, id, clock.now());
    expect(app.store.message(id)!.content).toBe("");
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE turn_id = ?").get(id)).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM fts WHERE owner_type = 'turn' AND owner_id = ?").get(String(id))).toEqual({ n: 0 });
  });

  it("M13: secrets never reach derived text", () => {
    expect(redact("my key is sk-ant-abcdefghijklmnopqrstuv and pwd: hunter2")).not.toMatch(/abcdefghij|hunter2/);
  });

  it("M1: jobs are idempotent, so catch-up after a crash doesn't duplicate work", async () => {
    const id = await pastTurn("2026-11-09T10:00:00+05:30", CRM_Q, CRM_A);
    app.derivation.catchUp();
    await app.derivation.queue.drain();
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE turn_id = ?").get(id)).toEqual({ n: 1 });
  });
});

describe("recall (R)", () => {
  it("R1: no history at all is said plainly, not invented", async () => {
    clock.set("2026-11-11T10:00:00+05:30");
    const prep = await app.agent.prepare({ userId: USER, text: "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?", browserTz: IST, locale: "en-IN" });
    expect(prep.pack.noHistory).toBe(true);
    expect(prep.contextBlock).toMatch(/No earlier conversations/);
  });

  it("the CRM example: Monday's shortlist is recalled with its claims and a re-check plan", async () => {
    await pastTurn("2026-11-09T10:00:00+05:30", CRM_Q, CRM_A);
    clock.set("2026-11-11T10:00:00+05:30");
    const prep = await app.agent.prepare({
      userId: USER,
      text: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
      browserTz: IST,
      locale: "en-IN",
    });
    expect(prep.pack.turns.map((t) => t.question)).toEqual([CRM_Q]);
    expect(prep.pack.turns[0]!.claims[0]).toMatchObject({ entity: "HubSpot", value: "$20" });
    expect(prep.contextBlock).toContain("Re-check plan");
    expect(prep.contextBlock).toContain("since=2026-11-08");
  });

  it("R3: the wrong weekday still finds the conversation, flagged as nearby", async () => {
    await pastTurn("2026-11-04T15:00:00+05:30", "Compare Postgres hosting: Neon vs Supabase vs RDS", "Neon is cheapest for small apps."); // Wednesday
    await pastTurn("2026-11-10T09:00:00+05:30", "What's a good pasta recipe?", "Try cacio e pepe."); // Tuesday
    clock.set("2026-11-11T10:00:00+05:30");
    const prep = await app.agent.prepare({ userId: USER, text: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", browserTz: IST, locale: "en-IN" });
    const postgres = prep.pack.turns.find((t) => t.question.includes("Postgres"));
    expect(postgres?.reason).toBe("nearby");
    expect(prep.pack.notFound.join(" ")).toMatch(/Nothing about|No conversation/);
  });

  it("T2 via memory: 'last Tuesday' picks the Tuesday that has the conversation", async () => {
    await pastTurn("2026-11-03T15:00:00+05:30", "Compare Postgres hosting: Neon vs Supabase", "Neon is cheapest."); // Tue 3 Nov
    clock.set("2026-11-11T10:00:00+05:30"); // Wed: 'last Tuesday' could be 10 Nov or 3 Nov
    const prep = await app.agent.prepare({ userId: USER, text: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed?", browserTz: IST, locale: "en-IN" });
    const tuesday = prep.resolved.find((r) => r.reading.text.toLowerCase() === "last tuesday")!;
    expect(tuesday.chosen.days!.from).toBe("2026-11-03");
    expect(prep.pack.turns[0]?.reason).toBe("in-span");
  });

  it("R4: 'what did I ask on 3 November' lists every question that day", async () => {
    await pastTurn("2026-11-03T09:00:00+05:30", "Best Postgres host for a side project?", "Neon.");
    await pastTurn("2026-11-03T18:00:00+05:30", "How do I rotate API keys safely?", "Use two keys.");
    await pastTurn("2026-11-05T10:00:00+05:30", "Unrelated later question?", "Sure.");
    clock.set("2026-11-11T10:00:00+05:30");
    const prep = await app.agent.prepare({ userId: USER, text: "What did I ask you on 3 November? Is your answer still correct today?", browserTz: IST, locale: "en-IN" });
    expect(prep.pack.mode).toBe("list");
    expect(prep.pack.turns.map((t) => t.localDay)).toEqual(["2026-11-03", "2026-11-03"]);
  });

  it("experienced frame: a question asked in IST stays on its IST day after the user moves to London", async () => {
    await pastTurn("2026-11-04T00:30:00+05:30", "Late-night question about Neon pricing", "Neon answer.");
    clock.set("2026-11-11T10:00:00+00:00");
    const prep = await app.agent.prepare({ userId: USER, text: "What did I ask on 4 November?", browserTz: "Europe/London", locale: "en-GB" });
    expect(prep.pack.turns).toHaveLength(1);
    expect(prep.contextBlock).toMatch(/clock was on Asia\/Kolkata then/);
  });

  it("R10: turns already in the thread history aren't recalled twice", async () => {
    clock.set("2026-11-10T10:00:00+05:30");
    const first = await app.agent.prepare({ userId: USER, text: "Compare Neon and Supabase pricing", browserTz: IST });
    app.store.appendMessage({ threadId: first.threadId, userId: USER, role: "assistant", content: "Neon vs Supabase...", tsUtc: clock.now(), tz: IST, tzSource: "browser", replyTo: first.userMessage.id });
    app.derivation.afterTurn(first.userMessage.id);
    await app.derivation.queue.drain();
    const second = await app.agent.prepare({ userId: USER, threadId: first.threadId, text: "What did you say about Neon pricing earlier?", browserTz: IST });
    expect(second.pack.turns.find((t) => t.turnId === first.userMessage.id)).toBeUndefined();
  });

  it("R15: user text with FTS syntax can't break the query", () => {
    expect(ftsQuery('what about "NEAR(foo bar)" -x: OR *')).not.toBeNull();
    expect(() =>
      app.retriever.countHits(USER, { start: 0, end: 1, days: { from: "2026-11-01", to: "2026-11-02" }, granularity: "day", frame: { kind: "experienced" }, confidence: 1, resolver: "t", label: "" }, 'x" OR NEAR(', 0),
    ).not.toThrow();
  });

  it("T13 end to end: a known product named after a weekday isn't read as a date", async () => {
    await pastTurn("2026-11-09T10:00:00+05:30", "Is Monday.com good for sales teams?", "Monday.com works for small teams.");
    clock.set("2026-11-11T10:00:00+05:30");
    const prep = await app.agent.prepare({ userId: USER, text: "Is Monday.com cheaper than HubSpot?", browserTz: IST });
    expect(prep.resolved).toHaveLength(0);
  });
});
