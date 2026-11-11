/**
 * End-to-end evals: real model, real search, a fresh database and a
 * controllable clock. Each scenario seeds past conversations at past times,
 * moves the clock to "today", asks the test question, and has a grader model
 * score the answer against a rubric.
 *
 *   npm run eval            all scenarios
 *   npm run eval -- crm     scenarios whose id contains "crm"
 *
 * Needs a model key (ANTHROPIC_API_KEY or GEMINI_API_KEY) and ideally
 * TAVILY_API_KEY. Grading uses the same provider's agent model.
 */
import { rmSync } from "node:fs";
import { DateTime } from "luxon";
import { z } from "zod";
import { createApp } from "../src/app";
import type { AgentEvent } from "../src/agent/events";
import { config } from "../src/config";
import { chatModel, createWorker } from "../src/llm/client";
import { FixedClock } from "../src/time";

const TZ = "Asia/Kolkata";
const USER = "local";

interface Scenario {
  id: string;
  /** Past turns: [days before today, weekday to snap to (optional), question]. */
  seed: Array<{ daysAgo?: number; weekday?: number; text: string }>;
  ask: string;
  rubric: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: "false-premise-crm",
    seed: [],
    ask: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    rubric:
      "There is no earlier conversation. PASS only if the answer says plainly it has no record of that shortlist, does not claim to remember which five tools were chosen, and still helps (asks which tools, or checks the most likely candidates while saying that's an assumption).",
  },
  {
    id: "crm-recheck",
    seed: [{ weekday: 1, text: "Shortlist 5 CRM tools for a 20-person sales team, with current pricing." }],
    ask: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    rubric:
      "PASS if the answer names the same five tools from the earlier answer (shown in the transcript), reports for each whether pricing changed or something notable shipped since that Monday, cites dated sources, and distinguishes 'changed' from 'couldn't verify'. FAIL if it picks different tools or invents changes without sources.",
  },
  {
    id: "date-recall-recheck",
    seed: [{ daysAgo: 8, text: "Which Postgres hosting is cheapest for a small SaaS: Neon, Supabase or AWS RDS?" }],
    ask: "What did I ask you on {SEED0_DAY}? Is your answer still correct today?",
    rubric:
      "PASS if the answer correctly states the earlier question (Postgres hosting: Neon, Supabase, RDS), summarises what was answered, re-checks it with fresh dated sources, and says clearly what still holds and what changed.",
  },
  {
    id: "wrong-weekday",
    seed: [{ weekday: 3, text: "Compare Postgres hosting pricing for a small app: Neon vs Supabase." }],
    ask: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    rubric:
      "The earlier conversation happened on a Wednesday, not a Tuesday. PASS if the answer finds it anyway, mentions the actual day briefly, and re-checks the pricing with dated sources.",
  },
  {
    id: "fresh-fact",
    seed: [],
    ask: "What's the latest stable release of Node.js, and when did it come out?",
    rubric: "PASS if the answer gives a specific version and release date, cites a source with its date, and doesn't present stale training knowledge as current.",
  },
];

const Grade = z.object({ pass: z.boolean(), score: z.number().describe("1 to 5"), reason: z.string() });

async function main() {
  if (!chatModel) throw new Error(`${config.keyName} is required for evals.`);
  const grader = createWorker(config.agentModel, "medium");
  const filter = process.argv[2];
  const results: Array<{ id: string; pass: boolean; score: number; reason: string; ms: number; prepMs: number }> = [];

  for (const s of SCENARIOS.filter((x) => !filter || x.id.includes(filter))) {
    const dbPath = `data/eval-${s.id}.db`;
    rmSync(dbPath, { force: true });
    const today = DateTime.now().setZone(TZ).set({ hour: 11, minute: 0 });
    const clock = new FixedClock(today.toMillis());
    const app = createApp({ dbPath, clock });

    const seedDays: string[] = [];
    for (const seed of s.seed) {
      let at = today.minus({ days: seed.daysAgo ?? 0 }).set({ hour: 10 });
      if (seed.weekday) {
        // The most recent such weekday strictly before today.
        const back = (today.weekday - seed.weekday + 7) % 7 || 7;
        at = today.minus({ days: back }).set({ hour: 10 });
      }
      clock.set(at.toMillis());
      seedDays.push(at.toFormat("d LLLL"));
      await turn(app, seed.text);
      await app.derivation.queue.drain();
    }

    clock.set(today.toMillis());
    const question = s.ask.replace("{SEED0_DAY}", seedDays[0] ?? "");
    const started = performance.now();
    const { answer, prepMs } = await turn(app, question);
    const ms = Math.round(performance.now() - started);

    const transcript = app.db
      .prepare("SELECT role, content, local_day FROM messages ORDER BY id")
      .all()
      .map((m) => {
        const r = m as { role: string; content: string; local_day: string };
        return `[${r.local_day}] ${r.role}: ${r.content}`;
      })
      .join("\n\n");

    const g = await grader
      .json(Grade, {
        maxTokens: 2000,
        system: "You grade a chat agent's final answer against a rubric. Be strict and specific.",
        user: `Today is ${today.toFormat("cccc d LLLL yyyy")}.\n\nRubric:\n${s.rubric}\n\nFull transcript (earlier turns were real conversations on the dates shown):\n${transcript}\n\nGrade only the final answer.`,
      })
      .catch((err: Error) => ({ pass: false, score: 0, reason: `grader failed: ${err.message}` }));
    results.push({ id: s.id, ...g, ms, prepMs });
    console.log(`${g.pass ? "PASS" : "FAIL"}  ${s.id}  (${(ms / 1000).toFixed(1)} s, prep ${prepMs} ms)  ${g.reason}`);
    console.log(`  Q: ${question}\n  A: ${answer.slice(0, 400).replace(/\n/g, " ")}${answer.length > 400 ? "…" : ""}\n`);
    app.db.close();
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed. Median latency ${median(results.map((r) => r.ms)) / 1000} s.`);
}

async function turn(app: ReturnType<typeof createApp>, text: string) {
  let answer = "";
  let prepMs = 0;
  const emit = (e: AgentEvent) => {
    if (e.type === "token") answer += e.text;
    if (e.type === "done") prepMs = e.timings.preMs ?? 0;
    if (e.type === "error") answer += `\n[error] ${e.message}`;
  };
  // Each turn opens a new thread, so recall has to come from memory, not thread history.
  await app.agent.run({ userId: USER, text, browserTz: TZ, locale: "en-IN" }, emit, new AbortController().signal);
  return { answer, prepMs };
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
