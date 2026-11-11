/**
 * Day digests: a short note per calendar day of what was discussed.
 *
 * These are for navigation ("what did we talk about last week?"), never for
 * facts: summaries lose detail, so re-checks always go back to the raw turns
 * and the claim ledger. A digest points at its turns by id.
 *
 * Built incrementally after each turn: the previous digest plus the new
 * turns. `built_through_msg_id` records how far it got, so a stale digest is
 * easy to spot, and retrieval reads raw turns for that day meanwhile (R9).
 */
import { z } from "zod";
import { type Db, parseJson } from "../../db";
import type { WorkerLlm } from "../../llm/types";
import { formatDay } from "../../time";
import type { MessageRow, MemoryStore } from "../store";
import type { Indexer } from "./indexer";

export const DIGEST_VERSION = 1;

const DigestOut = z.object({
  summary: z.string(),
  entities: z.array(z.string()),
});

const SYSTEM = `You keep a diary of a user's conversations with an assistant, one short entry per day.
Write notes the assistant can use later to recall what happened: what the user asked about, the concrete names involved (products, companies, places), any decisions or shortlists, and anything left open.
At most 90 words. Plain sentences, no headings. No dates, the entry already has one.
If a previous entry is given, merge the new conversation into it rather than starting over.`;

export async function deriveDigest(db: Db, store: MemoryStore, worker: WorkerLlm, indexer: Indexer, userId: string, day: string) {
  const prev = db.prepare("SELECT * FROM day_digests WHERE user_id = ? AND local_day = ?").get(userId, day) as
    | { summary: string; turn_ids_json: string; built_through_msg_id: number; version: number }
    | undefined;
  const sameVersion = prev?.version === DIGEST_VERSION;
  const after = sameVersion ? prev!.built_through_msg_id : 0;

  const rows = db
    .prepare(
      `SELECT * FROM messages
        WHERE user_id = ? AND local_day = ? AND id > ? AND status = 'complete'
        ORDER BY id`,
    )
    .all(userId, day, after) as unknown as MessageRow[];
  if (rows.length === 0) return;

  const transcript = rows.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 1500)}`).join("\n\n");
  const out = await worker.json(DigestOut, {
    system: SYSTEM,
    maxTokens: 600,
    user: `${sameVersion && prev ? `Previous entry:\n${prev.summary}\n\n` : ""}Conversation on ${formatDay(day)}:\n${transcript}`,
  });

  const turnIds = new Set<number>(sameVersion ? parseJson<number[]>(prev!.turn_ids_json, []) : []);
  for (const m of rows) if (m.role === "user") turnIds.add(m.id);
  const builtThrough = rows.at(-1)!.id;

  db.prepare(
    `INSERT INTO day_digests (user_id, local_day, summary, entities_json, turn_ids_json, built_through_msg_id, version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, local_day) DO UPDATE SET
       summary = excluded.summary, entities_json = excluded.entities_json, turn_ids_json = excluded.turn_ids_json,
       built_through_msg_id = excluded.built_through_msg_id, version = excluded.version, updated_at = excluded.updated_at`,
  ).run(userId, day, out.summary, JSON.stringify(out.entities), JSON.stringify([...turnIds]), builtThrough, DIGEST_VERSION, Date.now());

  await indexer.indexDoc("digest", `${userId}|${day}`, userId, day, `${formatDay(day)}: ${out.summary}`);
}

/** Is the digest behind the log? Retrieval uses this to decide whether to trust it. */
export function digestIsStale(db: Db, userId: string, day: string): boolean {
  const d = db.prepare("SELECT built_through_msg_id, version FROM day_digests WHERE user_id = ? AND local_day = ?").get(userId, day) as
    | { built_through_msg_id: number; version: number }
    | undefined;
  if (!d || d.version !== DIGEST_VERSION) return true;
  const last = db.prepare("SELECT MAX(id) AS id FROM messages WHERE user_id = ? AND local_day = ? AND status = 'complete'").get(userId, day) as {
    id: number | null;
  };
  return (last.id ?? 0) > d.built_through_msg_id;
}
