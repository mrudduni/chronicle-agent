/**
 * Memory, write side: the append-only conversation log.
 *
 * This is the source of truth. Everything in memory/derive can be deleted and
 * rebuilt from what this file writes. Rows are never edited, with one
 * exception: "forget this" erases content, because privacy beats purity.
 *
 * Timestamps come from the server clock. The client contributes only its
 * timezone, so a laptop with a wrong clock can't corrupt the history (M10).
 */
import { randomUUID } from "node:crypto";
import { type Db, parseJson, tx } from "../db";
import { dayOf, offsetMinutes } from "../time";
import type { TzSource } from "../time";

export interface MessageRow {
  id: number;
  thread_id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  ts_utc: number;
  tz: string;
  utc_offset_min: number;
  tz_source: TzSource;
  local_day: string;
  status: "complete" | "partial" | "forgotten";
  reply_to: number | null;
}

export interface ThreadRow {
  id: string;
  user_id: string;
  title: string | null;
  created_at: number;
}

export interface NewMessage {
  threadId: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  tsUtc: number;
  tz: string;
  tzSource: TzSource;
  replyTo?: number;
  status?: "complete" | "partial";
}

export class MemoryStore {
  constructor(readonly db: Db) {}

  // ------------------------------------------------------------ users

  user(userId: string): { declaredTz: string | null; lastSeenTz: string | null } {
    this.db.prepare("INSERT OR IGNORE INTO users (id) VALUES (?)").run(userId);
    const row = this.db.prepare("SELECT declared_tz, last_seen_tz FROM users WHERE id = ?").get(userId) as {
      declared_tz: string | null;
      last_seen_tz: string | null;
    };
    return { declaredTz: row.declared_tz, lastSeenTz: row.last_seen_tz };
  }

  setLastSeenTz(userId: string, tz: string) {
    this.db.prepare("UPDATE users SET last_seen_tz = ? WHERE id = ?").run(tz, userId);
  }

  /** The user said which zone to use. `null` clears it and goes back to the browser's. */
  declareTz(userId: string, tz: string | null, at: number) {
    this.user(userId);
    tx(this.db, () => {
      this.db.prepare("UPDATE users SET declared_tz = ? WHERE id = ?").run(tz, userId);
      this.appendEvent(userId, "declare_tz", { tz }, at);
    });
  }

  // ---------------------------------------------------------- threads

  createThread(userId: string, at: number, title?: string): ThreadRow {
    const row: ThreadRow = { id: randomUUID(), user_id: userId, title: title ?? null, created_at: at };
    this.db.prepare("INSERT INTO threads (id, user_id, title, created_at) VALUES (?, ?, ?, ?)").run(row.id, row.user_id, row.title, row.created_at);
    return row;
  }

  thread(id: string): ThreadRow | undefined {
    return this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
  }

  setThreadTitle(id: string, title: string) {
    this.db.prepare("UPDATE threads SET title = ? WHERE id = ? AND title IS NULL").run(title, id);
  }

  /** Threads, newest activity first, for the sidebar. */
  listThreads(userId: string) {
    return this.db
      .prepare(
        `SELECT t.id, t.title, t.created_at,
                MAX(m.ts_utc) AS last_at,
                (SELECT content FROM messages WHERE thread_id = t.id AND role = 'user' ORDER BY id LIMIT 1) AS first_question
           FROM threads t LEFT JOIN messages m ON m.thread_id = t.id
          WHERE t.user_id = ?
          GROUP BY t.id
          ORDER BY COALESCE(MAX(m.ts_utc), t.created_at) DESC`,
      )
      .all(userId) as Array<{ id: string; title: string | null; created_at: number; last_at: number | null; first_question: string | null }>;
  }

  // --------------------------------------------------------- messages

  appendMessage(m: NewMessage): MessageRow {
    const localDay = dayOf(m.tsUtc, m.tz);
    const offset = offsetMinutes(m.tsUtc, m.tz);
    const res = this.db
      .prepare(
        `INSERT INTO messages (thread_id, user_id, role, content, ts_utc, tz, utc_offset_min, tz_source, local_day, status, reply_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.threadId, m.userId, m.role, m.content, m.tsUtc, m.tz, offset, m.tzSource, localDay, m.status ?? "complete", m.replyTo ?? null);
    return this.message(Number(res.lastInsertRowid))!;
  }

  message(id: number): MessageRow | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
  }

  /** The assistant reply to a user message, if there is one. */
  replyTo(userMessageId: number): MessageRow | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE reply_to = ? ORDER BY id DESC LIMIT 1").get(userMessageId) as MessageRow | undefined;
  }

  threadMessages(threadId: string, limit = 200): MessageRow[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE thread_id = ? AND status != 'forgotten' ORDER BY id DESC LIMIT ?")
      .all(threadId, limit) as unknown as MessageRow[];
    return rows.reverse();
  }

  /**
   * When the previous visit ended: the latest message before a gap of more
   * than 30 minutes, looking back from `beforeMs`. Used for "since we last talked".
   */
  lastVisit(userId: string, beforeMs: number): number | null {
    const rows = this.db
      .prepare("SELECT ts_utc FROM messages WHERE user_id = ? AND ts_utc < ? ORDER BY ts_utc DESC LIMIT 400")
      .all(userId, beforeMs) as Array<{ ts_utc: number }>;
    const GAP = 30 * 60 * 1000;
    let prev = beforeMs;
    for (const r of rows) {
      if (prev - r.ts_utc > GAP) return r.ts_utc;
      prev = r.ts_utc;
    }
    return null;
  }

  /**
   * Which zones the user's clock was in, and when. A record of what the clock
   * said, not of where the person was: we never track location.
   */
  zoneTimeline(userId: string, sinceMs: number): Array<{ tz: string; from: number; to: number }> {
    const rows = this.db
      .prepare("SELECT tz, ts_utc FROM messages WHERE user_id = ? AND role = 'user' AND ts_utc >= ? ORDER BY ts_utc")
      .all(userId, sinceMs) as Array<{ tz: string; ts_utc: number }>;
    const out: Array<{ tz: string; from: number; to: number }> = [];
    for (const r of rows) {
      const last = out.at(-1);
      if (last && last.tz === r.tz) last.to = r.ts_utc;
      else out.push({ tz: r.tz, from: r.ts_utc, to: r.ts_utc });
    }
    return out;
  }

  hasAnyHistory(userId: string, excludeThreadId?: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM messages WHERE user_id = ? AND status = 'complete' AND thread_id != ? LIMIT 1")
      .get(userId, excludeThreadId ?? "") as { x: number } | undefined;
    return !!row;
  }

  // --------------------------------------------------------- evidence

  appendSearch(s: { turnId: number; userId: string; provider: string; query: string; params: unknown; results: unknown; tsUtc: number }) {
    this.db
      .prepare("INSERT INTO searches (turn_id, user_id, provider, query, params_json, results_json, ts_utc) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(s.turnId, s.userId, s.provider, s.query, JSON.stringify(s.params), JSON.stringify(s.results), s.tsUtc);
  }

  searchesForTurn(turnId: number) {
    const rows = this.db.prepare("SELECT * FROM searches WHERE turn_id = ? ORDER BY id").all(turnId) as Array<{
      id: number;
      query: string;
      params_json: string;
      results_json: string;
      provider: string;
      ts_utc: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      query: r.query,
      provider: r.provider,
      ts: r.ts_utc,
      params: parseJson<{ mode?: string; since?: string }>(r.params_json, {}),
      results: parseJson<unknown[]>(r.results_json, []),
    }));
  }

  appendEvent(userId: string, kind: string, payload: unknown, at: number) {
    this.db.prepare("INSERT INTO events (user_id, kind, payload_json, ts_utc) VALUES (?, ?, ?, ?)").run(userId, kind, JSON.stringify(payload), at);
  }

  // ----------------------------------------------------------- forget

  /**
   * Erase a turn: the question, the answer, and everything derived from them.
   * The day's digest is dropped so it gets rebuilt without this turn (M12).
   */
  forgetTurn(userId: string, turnId: number, at: number) {
    const q = this.message(turnId);
    if (!q || q.user_id !== userId) return false;
    const reply = this.replyTo(turnId);
    const ids = [turnId, ...(reply ? [reply.id] : [])];
    tx(this.db, () => {
      for (const id of ids) {
        this.db.prepare("UPDATE messages SET content = '', status = 'forgotten' WHERE id = ?").run(id);
      }
      this.db.prepare("DELETE FROM searches WHERE turn_id = ?").run(turnId);
      this.db.prepare("DELETE FROM claims WHERE turn_id = ?").run(turnId);
      this.db.prepare("DELETE FROM fts WHERE owner_type = 'turn' AND owner_id = ?").run(String(turnId));
      this.db.prepare("DELETE FROM embeddings WHERE owner_type = 'turn' AND owner_id = ?").run(String(turnId));
      this.db.prepare("DELETE FROM day_digests WHERE user_id = ? AND local_day = ?").run(userId, q.local_day);
      this.db.prepare("DELETE FROM fts WHERE owner_type = 'digest' AND owner_id = ?").run(`${userId}|${q.local_day}`);
      // Topic summaries may quote the forgotten turn. Drop them; later turns
      // rebuild topics, and every turn stays findable on its own meanwhile.
      const topics = this.db
        .prepare("SELECT id FROM topics WHERE user_id = ? AND EXISTS (SELECT 1 FROM json_each(topics.turn_ids_json) WHERE value = ?)")
        .all(userId, turnId) as Array<{ id: number }>;
      for (const t of topics) {
        this.db.prepare("DELETE FROM topics WHERE id = ?").run(t.id);
        this.db.prepare("DELETE FROM fts WHERE owner_type = 'topic' AND owner_id = ?").run(String(t.id));
        this.db.prepare("DELETE FROM embeddings WHERE owner_type = 'topic' AND owner_id = ?").run(String(t.id));
      }
      this.appendEvent(userId, "forget", { turnId }, at);
    });
    return true;
  }
}
