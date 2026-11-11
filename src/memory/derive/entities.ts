/**
 * Entities: the things claims are about ("HubSpot", "Neon").
 *
 * Matching is on a normalised key, so "HubSpot", "Hubspot" and "hub-spot"
 * collapse into one entity (M6). The type is part of the key, so "Neon" the
 * database and "neon" the gas stay separate (M7). Alias resolution beyond
 * spelling ("Postgres" vs "PostgreSQL") is done by the claim extractor: it's
 * shown the existing canonical names and told to reuse them.
 */
import { type Db, parseJson } from "../../db";

export function normEntity(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.(com|io|ai|dev|app|co)\b/g, "") // "Monday.com" and "Monday" are the same CRM
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function upsertEntity(db: Db, userId: string, name: string, type: string): number {
  const norm = normEntity(name);
  const existing = db
    .prepare("SELECT id, canonical, aliases_json FROM entities WHERE user_id = ? AND norm = ? AND type = ?")
    .get(userId, norm, type) as { id: number; canonical: string; aliases_json: string } | undefined;
  if (existing) {
    if (existing.canonical !== name) {
      const aliases = new Set(parseJson<string[]>(existing.aliases_json, []));
      if (!aliases.has(name)) {
        aliases.add(name);
        db.prepare("UPDATE entities SET aliases_json = ? WHERE id = ?").run(JSON.stringify([...aliases]), existing.id);
      }
    }
    return existing.id;
  }
  const res = db
    .prepare("INSERT INTO entities (user_id, canonical, norm, type) VALUES (?, ?, ?, ?)")
    .run(userId, name, norm, type);
  return Number(res.lastInsertRowid);
}

/** Canonical names plus aliases, for masking ("Monday.com") and for the extractor prompt. */
export function knownEntityNames(db: Db, userId: string, limit = 200): string[] {
  const rows = db
    .prepare("SELECT canonical, aliases_json FROM entities WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .all(userId, limit) as Array<{ canonical: string; aliases_json: string }>;
  return rows.flatMap((r) => [r.canonical, ...parseJson<string[]>(r.aliases_json, [])]);
}

/** Entity ids whose names appear in a piece of text (used to boost retrieval). */
export function entitiesMentioned(db: Db, userId: string, text: string): number[] {
  const hay = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  const rows = db.prepare("SELECT id, canonical, aliases_json FROM entities WHERE user_id = ?").all(userId) as Array<{
    id: number;
    canonical: string;
    aliases_json: string;
  }>;
  const hits: number[] = [];
  for (const r of rows) {
    const names = [r.canonical, ...parseJson<string[]>(r.aliases_json, [])];
    const found = names.some((n) => {
      const needle = n.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      return needle.length >= 2 && hay.includes(` ${needle} `);
    });
    if (found) hits.push(r.id);
  }
  return hits;
}
