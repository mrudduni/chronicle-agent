/**
 * Topics: the subject axis of memory, next to the day axis.
 *
 * People remember conversations by date ("last Tuesday") and by subject ("the
 * CRM thing"). Day digests serve the first, topics the second. A topic also
 * tracks open items, decisions the user hasn't made yet ("pick one of the five
 * shortlisted CRMs"). Those are the open loops worth following up on.
 */
import { z } from "zod";
import { type Db, parseJson } from "../../db";
import type { WorkerLlm } from "../../llm/types";
import type { MemoryStore } from "../store";
import { isTrivial } from "./claims";
import type { Indexer } from "./indexer";

export const TOPIC_VERSION = 1;

const TopicOut = z.object({
  skip: z.boolean().describe("true for small talk with nothing worth remembering"),
  topic_id: z.number().nullable().describe("id of the existing topic this turn continues, or null for a new topic"),
  label: z.string().describe("3 to 6 words, e.g. 'CRM shortlist for sales team'"),
  summary: z.string().describe("the topic so far, at most 80 words"),
  open_items: z.array(z.string()).describe("decisions or follow-ups still open, short phrases"),
  entities: z.array(z.string()),
});

const SYSTEM = `You file a chat turn under a topic, so the assistant can later recall conversations by subject.
Reuse an existing topic when the turn clearly continues it; otherwise start a new one.
Keep the summary factual and specific: names, numbers, shortlists, conclusions.
Open items are things the user still has to decide or do, or questions left unanswered. Drop items the turn resolved.`;

export async function deriveTopic(db: Db, store: MemoryStore, worker: WorkerLlm, indexer: Indexer, turnId: number) {
  const q = store.message(turnId);
  const a = store.replyTo(turnId);
  if (!q || !a || a.status !== "complete" || isTrivial(q.content, a.content)) return;

  const recent = db
    .prepare("SELECT id, label, summary, open_items_json FROM topics WHERE user_id = ? ORDER BY updated_at DESC LIMIT 15")
    .all(q.user_id) as Array<{ id: number; label: string; summary: string; open_items_json: string }>;

  const out = await worker.json(TopicOut, {
    system: SYSTEM,
    maxTokens: 800,
    user: [
      `Existing topics:\n${recent.map((t) => `#${t.id} ${t.label}: ${t.summary} | open: ${parseJson<string[]>(t.open_items_json, []).join("; ") || "none"}`).join("\n") || "(none)"}`,
      `User: ${q.content.slice(0, 2000)}`,
      `Assistant: ${a.content.slice(0, 3000)}`,
    ].join("\n\n"),
  });
  if (out.skip) return;

  const existing = out.topic_id != null ? recent.find((t) => t.id === out.topic_id) : undefined;
  let topicId: number;
  if (existing) {
    const row = db.prepare("SELECT turn_ids_json FROM topics WHERE id = ?").get(existing.id) as { turn_ids_json: string };
    const turns = new Set(parseJson<number[]>(row.turn_ids_json, []));
    turns.add(turnId);
    db.prepare(
      "UPDATE topics SET label = ?, summary = ?, open_items_json = ?, entities_json = ?, turn_ids_json = ?, updated_at = ? WHERE id = ?",
    ).run(out.label, out.summary, JSON.stringify(out.open_items), JSON.stringify(out.entities), JSON.stringify([...turns]), a.ts_utc, existing.id);
    topicId = existing.id;
  } else {
    const res = db
      .prepare(
        "INSERT INTO topics (user_id, label, summary, entities_json, open_items_json, turn_ids_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(q.user_id, out.label, out.summary, JSON.stringify(out.entities), JSON.stringify(out.open_items), JSON.stringify([turnId]), a.ts_utc);
    topicId = Number(res.lastInsertRowid);
  }

  await indexer.indexDoc("topic", String(topicId), q.user_id, q.local_day, `${out.label}. ${out.summary}`);
}
