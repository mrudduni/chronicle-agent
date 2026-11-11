/**
 * Demo data: it loads without a key, stays apart from the user's own memory,
 * and the suggested questions actually find the demo conversations.
 *
 * "Today" is Thursday 12 Nov 2026 in India, so the demo puts the CRM
 * shortlist on Mon 9 Nov, Postgres hosting on Tue 3 Nov (the Tuesday before
 * last) and email tools on Tue 27 Oct.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { DEMO_USER, demoState, seedDemo } from "../src/demo/seed";
import { HashEmbedder } from "../src/embed";
import type { WorkerLlm } from "../src/llm/types";
import { FixedClock } from "../src/time";

const IST = "Asia/Kolkata";
// The LLM jobs return empty results; recall in these checks comes from the keyword and vector indexes.
const idleWorker: WorkerLlm = {
  async json(_schema, args) {
    if (args.system.startsWith("You build a ledger")) return { claims: [] } as never;
    if (args.system.includes("diary")) return { summary: "", entities: [] } as never;
    return { skip: true, topic_id: null, label: "", summary: "", open_items: [], entities: [] } as never;
  },
};

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  app = createApp({ dbPath: ":memory:", clock: new FixedClock("2026-11-12T10:00:00+05:30"), embedder: new HashEmbedder(), worker: idleWorker });
  seedDemo(app, IST);
  await app.derivation.queue.drain();
});

const ask = (text: string) => app.agent.prepare({ userId: DEMO_USER, text, browserTz: IST, locale: "en-IN" });

describe("demo data", () => {
  it("loads three threads on the expected days, without touching the user's own memory", () => {
    expect(app.store.listThreads(DEMO_USER)).toHaveLength(3);
    expect(app.store.listThreads("local")).toHaveLength(0);
    const days = app.db.prepare("SELECT DISTINCT local_day FROM messages WHERE user_id = ? ORDER BY local_day").all(DEMO_USER) as Array<{ local_day: string }>;
    expect(days.map((d) => d.local_day)).toEqual(["2026-10-27", "2026-11-03", "2026-11-09"]);
    expect(demoState(app)).toMatchObject({ loaded: true, seededFor: "2026-11-12" });
  });

  it("'last Tuesday' finds the Postgres conversation on the Tuesday before last", async () => {
    const prep = await ask("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    expect(prep.resolved[0]!.chosen.days!.from).toBe("2026-11-03");
    const pg = prep.pack.turns.find((t) => t.question.includes("Compare Postgres"))!;
    expect(pg).toBeDefined();
    // Old citations can't collide with this turn's S-ids.
    expect(pg.answer).not.toMatch(/\[S\d/);
    expect(pg.answer).toContain("(source: neon.com)");
  });

  it("'on Monday' finds the CRM shortlist", async () => {
    const prep = await ask("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?");
    expect(prep.pack.turns.map((t) => t.question)[0]).toMatch(/CRM tools/);
  });

  it("the suggested date question recalls the email conversation", async () => {
    const question = demoState(app).suggestions.find((s) => s.startsWith("What did I ask you on"))!;
    expect(question).toContain("27 October");
    const prep = await ask(question);
    expect(prep.pack.turns.map((t) => t.localDay)).toEqual(["2026-10-27"]);
  });

  it("reloading replaces the demo instead of piling up copies", async () => {
    seedDemo(app, IST);
    await app.derivation.queue.drain();
    expect(app.store.listThreads(DEMO_USER)).toHaveLength(3);
    const indexed = app.db.prepare("SELECT COUNT(*) AS n FROM fts WHERE user_id = ? AND owner_type = 'turn'").get(DEMO_USER) as { n: number };
    expect(indexed.n).toBe(5);
  });
});
