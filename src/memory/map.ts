/**
 * The memory map: a read-only, graph-shaped view of what the agent remembers.
 *
 * This is not a knowledge graph. Nothing new is stored and no model runs; it's
 * a few queries over tables memory already keeps:
 *
 *   conversations  messages (each question with an answer, on its local day)
 *   things         entities, merged by normalised name ("Supabase" the
 *                  company and "Supabase" the product are one node here)
 *   links          claims: "in this conversation I said X about Y"
 *
 * The UI draws it on a timeline (things above, conversations below, by day)
 * and clicking a thing shows everything said about it, in date order, with
 * sources: the "has it changed?" question as a picture.
 */
import type { Db } from "../db";
import { parseJson } from "../db";
import { normEntity } from "./derive/entities";

export interface MapConversation {
  turnId: number;
  threadId: string;
  day: string;
  askedAt: number;
  question: string;
}

export interface MapThing {
  /** Normalised name, the node id. */
  key: string;
  name: string;
  type: string;
  /** How many facts were recorded about it. */
  facts: number;
}

export interface MemoryMap {
  conversations: MapConversation[];
  things: MapThing[];
  links: Array<{ thing: string; turnId: number; facts: number }>;
}

export function memoryMap(db: Db, userId: string): MemoryMap {
  const conversations = (
    db
      .prepare(
        `SELECT q.id AS turnId, q.thread_id AS threadId, q.local_day AS day, q.ts_utc AS askedAt, q.content AS question
           FROM messages q
          WHERE q.user_id = ? AND q.role = 'user' AND q.status = 'complete'
            AND EXISTS (SELECT 1 FROM messages a WHERE a.reply_to = q.id AND a.status = 'complete')
          ORDER BY q.ts_utc`,
      )
      .all(userId) as unknown as MapConversation[]
  ).map((c) => ({ ...c, question: c.question.length > 140 ? `${c.question.slice(0, 137)}...` : c.question }));

  const links = db
    .prepare(
      `SELECT e.norm AS thing, c.turn_id AS turnId, COUNT(*) AS facts
         FROM claims c JOIN entities e ON e.id = c.entity_id
        WHERE c.user_id = ?
        GROUP BY e.norm, c.turn_id`,
    )
    .all(userId) as unknown as MemoryMap["links"];

  // One node per normalised name; the most used spelling and type win.
  const things = db
    .prepare(
      `SELECT e.norm AS key, e.canonical AS name, e.type AS type, COUNT(c.id) AS facts
         FROM entities e JOIN claims c ON c.entity_id = e.id
        WHERE e.user_id = ?
        GROUP BY e.norm, e.canonical, e.type
        ORDER BY facts DESC`,
    )
    .all(userId) as unknown as MapThing[];
  const merged = new Map<string, MapThing>();
  for (const t of things) {
    const seen = merged.get(t.key);
    if (seen) seen.facts += t.facts;
    else merged.set(t.key, { ...t });
  }

  return { conversations, things: [...merged.values()], links };
}

export interface ThingFact {
  claimId: number;
  turnId: number;
  threadId: string;
  day: string;
  observedAt: number;
  attribute: string;
  value: string;
  qualifiers: Record<string, string>;
  quote: string;
  sourceUrl: string | null;
  sourcePublishedAt: string | null;
  status: string;
  /** Set when a later conversation recorded a different value for the same thing. */
  supersededBy: number | null;
}

export interface ThingDetail {
  name: string;
  facts: ThingFact[];
  /** Topics this thing came up in, with what was left open. */
  topics: Array<{ label: string; openItems: string[] }>;
}

/** Everything said about one thing, oldest first. */
export function thingDetail(db: Db, userId: string, key: string): ThingDetail | null {
  const rows = db
    .prepare(
      `SELECT c.id AS claimId, c.turn_id AS turnId, m.thread_id AS threadId, m.local_day AS day, c.observed_at AS observedAt,
              c.attribute, c.value, c.qualifiers_json, c.quote, c.source_url AS sourceUrl,
              c.source_published_at AS sourcePublishedAt, c.status, c.superseded_by AS supersededBy, e.canonical AS name
         FROM claims c
         JOIN entities e ON e.id = c.entity_id
         JOIN messages m ON m.id = c.turn_id
        WHERE c.user_id = ? AND e.norm = ?
        ORDER BY c.observed_at, c.id`,
    )
    .all(userId, key) as Array<Omit<ThingFact, "qualifiers"> & { qualifiers_json: string; name: string }>;
  if (rows.length === 0) return null;

  const name = rows[0]!.name;
  const topics = (
    db.prepare("SELECT label, entities_json, open_items_json FROM topics WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as Array<{
      label: string;
      entities_json: string;
      open_items_json: string;
    }>
  )
    .filter((t) => parseJson<string[]>(t.entities_json, []).some((n) => normEntity(n) === key))
    .map((t) => ({ label: t.label, openItems: parseJson<string[]>(t.open_items_json, []) }));

  return {
    name,
    facts: rows.map(({ qualifiers_json, name: _name, ...r }) => ({ ...r, qualifiers: parseJson<Record<string, string>>(qualifiers_json, {}) })),
    topics,
  };
}
