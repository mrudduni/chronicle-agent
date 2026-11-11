/**
 * Loads the demo history into the database under its own user, "demo".
 *
 * Demo data never mixes with the person's own memory: everything is keyed by
 * user id, and the UI switches between the two. Seeding goes through the same
 * path as a real turn (append to the log, then afterTurn), so the background
 * jobs build the demo's claims, digests, topics and indexes exactly as they
 * would for real conversations. Indexing needs no key; the LLM jobs run as
 * soon as one is set.
 *
 * Reseeding wipes the demo user first, so the dates move to line up with
 * today ("On Monday..." keeps meaning the right Monday).
 */
import { DateTime } from "luxon";
import type { App } from "../app";
import { tx } from "../db";
import { isValidZone } from "../time";
import { buildDemoScript } from "./script";

export const DEMO_USER = "demo";

export interface DemoState {
  loaded: boolean;
  /** Local day the demo was seeded for; dates in it are relative to this day. */
  seededFor: string | null;
  suggestions: string[];
}

export function demoState(app: App): DemoState {
  const row = app.db
    .prepare("SELECT payload_json FROM events WHERE user_id = ? AND kind = 'demo-seeded' ORDER BY id DESC LIMIT 1")
    .get(DEMO_USER) as { payload_json: string } | undefined;
  if (!row) return { loaded: false, seededFor: null, suggestions: [] };
  const p = JSON.parse(row.payload_json) as { day: string; suggestions: string[] };
  return { loaded: true, seededFor: p.day, suggestions: p.suggestions };
}

export function seedDemo(app: App, tzIn: string | undefined): DemoState {
  const tz = tzIn && isValidZone(tzIn) ? tzIn : "UTC";
  const now = DateTime.fromMillis(app.clock.now(), { zone: tz });
  const script = buildDemoScript(now);

  clearUser(app, DEMO_USER);
  const turnIds: number[] = [];

  tx(app.db, () => {
    for (const thread of script.threads) {
      const first = thread.turns[0]!;
      const t = app.store.createThread(DEMO_USER, first.at.toMillis(), titleOf(first.question));
      for (const turn of thread.turns) {
        const q = app.store.appendMessage({
          threadId: t.id,
          userId: DEMO_USER,
          role: "user",
          content: turn.question,
          tsUtc: turn.at.toMillis(),
          tz,
          tzSource: "browser",
        });
        // Result ids run S1, S2, ... across the turn's searches, matching the citations in the answer.
        let n = 0;
        for (const s of turn.searches) {
          app.store.appendSearch({
            turnId: q.id,
            userId: DEMO_USER,
            provider: "demo",
            query: s.query,
            params: { query: s.query, mode: s.mode },
            results: s.results.map((r) => ({ ...r, id: `S${++n}` })),
            tsUtc: turn.at.plus({ seconds: 5 }).toMillis(),
          });
        }
        app.store.appendMessage({
          threadId: t.id,
          userId: DEMO_USER,
          role: "assistant",
          content: turn.answer,
          tsUtc: turn.at.plus({ seconds: 40 }).toMillis(),
          tz,
          tzSource: "browser",
          replyTo: q.id,
        });
        turnIds.push(q.id);
      }
    }
    app.store.user(DEMO_USER);
    app.store.setLastSeenTz(DEMO_USER, tz);
    app.store.appendEvent(DEMO_USER, "demo-seeded", { day: now.toISODate(), suggestions: script.suggestions }, app.clock.now());
  });

  // Same as after a real turn: index now, claims / topics / digests in the background.
  for (const id of turnIds) app.derivation.afterTurn(id);
  return demoState(app);
}

/**
 * Remove every trace of one user, including derived rows and their queued
 * jobs. The jobs matter: message ids can be reused after a delete, and a
 * leftover "done" job for a reused id would stop the new turn being indexed.
 */
export function clearUser(app: App, userId: string) {
  const { db } = app;
  const turnIds = (db.prepare("SELECT id FROM messages WHERE user_id = ? AND role = 'user'").all(userId) as Array<{ id: number }>).map((r) => String(r.id));
  tx(db, () => {
    for (const id of turnIds) {
      db.prepare("DELETE FROM jobs WHERE owner_id = ? OR owner_id LIKE ?").run(id, `${id}@%`);
      db.prepare("DELETE FROM traces WHERE turn_id = ?").run(Number(id));
    }
    db.prepare("DELETE FROM jobs WHERE kind = 'digest' AND owner_id LIKE ?").run(`${userId}|%`);
    for (const table of ["fts", "embeddings", "claims", "entities", "day_digests", "topics", "searches", "messages", "threads", "events"]) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
    }
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  });
}

function titleOf(text: string) {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
