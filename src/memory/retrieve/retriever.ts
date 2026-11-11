/**
 * Memory, read side: find the past turns that matter for this message.
 *
 * Runs before the model is called, in code. The model has one tool (web
 * search); recall is not a tool it has to remember to use. That saves a round
 * trip and makes recall deterministic.
 *
 * Pipeline:
 *   1. mode     none | light | full | list | browse, from cheap text cues
 *   2. filter   resolved dates become a hard filter on each turn's own local
 *               day; vague dates only boost
 *   3. rank     BM25 + vectors + entity overlap (+ recency for vague dates), RRF
 *   4. fallback nothing on that day? say so, and look ±7 days for the
 *               topic (people misremember days: R1, R3)
 *   5. expand   turn -> answer -> claims; days -> digests; turns -> topics
 *   6. pack     fit a character budget, count what was left out
 *
 * Everything is synchronous SQLite plus a dot product per stored vector.
 * The query vector is computed by the caller in parallel with the time
 * pipeline.
 */
import { type Db, parseJson } from "../../db";
import { type Embedder, dot, fromBlob } from "../../embed";
import { type AnchorLookup, type MemoryTimeFilter, type TemporalSpan, refersToPast, shiftDay } from "../../time";
import { entitiesMentioned } from "../derive/entities";
import { digestIsStale } from "../derive/digest";
import { redact } from "../redact";
import type { MemoryStore, MessageRow } from "../store";
import { contentTerms, ftsQuery, stripRanges } from "./query";
import { rrf, topByScore } from "./rank";

export type RecallMode = "none" | "light" | "full" | "list" | "browse";

export interface RecalledClaim {
  entity: string;
  attribute: string;
  value: string;
  qualifiers: Record<string, string>;
  sourceUrl: string | null;
  sourcePublishedAt: string | null;
  observedAt: number;
  status: "sourced" | "unsourced" | "user";
  /** A later observation of the same fact, if there is one. */
  laterValue?: { value: string; observedAt: number; status: string };
}

export interface RecalledTurn {
  turnId: number;
  threadId: string;
  askedAt: number;
  tz: string;
  localDay: string;
  question: string;
  answer: string;
  answerStatus: "complete" | "partial" | "missing";
  claims: RecalledClaim[];
  /** Why it's here: on the requested day, near it, or just relevant. */
  reason: "in-span" | "nearby" | "relevant";
}

export interface MemoryPack {
  mode: RecallMode;
  /** True when there is no earlier conversation at all (fresh install). */
  noHistory: boolean;
  turns: RecalledTurn[];
  digests: Array<{ day: string; summary: string }>;
  topics: Array<{ label: string; summary: string; openItems: string[] }>;
  /** Explicit "looked, found nothing" notes. The model must not invent past conversations. */
  notFound: string[];
  /** Turns that matched but didn't fit the budget. */
  omitted: number;
}

export interface RetrieveRequest {
  userId: string;
  threadId: string;
  currentTurnId: number;
  text: string;
  filter: MemoryTimeFilter | null;
  /** Human labels of the filter spans, for not-found notes ("Mon 9 Nov 2026"). */
  filterLabels: string[];
  /** Turns already in the prompt as thread history; don't repeat them (R10). */
  excludeTurnIds: Set<number>;
  /** Previous user message in this thread, to give pronouns something to resolve to (R5). */
  previousUserText?: string;
  queryVector: Float32Array | null;
  budgetChars: number;
}

const LIST_RE =
  /\bwhat (?:did|have) (?:i|we) (?:ask|asked|say|said|talk|talked|discuss|discussed|cover|covered)\b|\bwhat (?:were|was) (?:we|i) (?:talking|discussing|asking)\b|\blist (?:what|everything)\b/i;
const BROWSE_RE =
  /\bwhat do you (?:remember|know) about me\b|\b(?:list|show)(?: me)? (?:our|my|all) (?:chats|conversations|threads|history)\b|\bwhat have we (?:talked|discussed|covered)\b/i;

/** Cosine floors for bge-small. Below these, "similar" is usually noise (R7). */
const VEC_RELEVANT = 0.62;
const VEC_STRONG = 0.72;

export class Retriever {
  constructor(
    private readonly db: Db,
    private readonly store: MemoryStore,
    private readonly embedder: Embedder,
  ) {}

  /** Query embedding, or null if the model isn't loaded yet. Never waits for a model download. */
  async embedQuery(text: string): Promise<Float32Array | null> {
    if (!this.embedder.ready()) return null;
    const [v] = await this.embedder.embed([text], "query");
    return v ?? null;
  }

  retrieve(req: RetrieveRequest): MemoryPack {
    const empty: MemoryPack = { mode: "none", noHistory: false, turns: [], digests: [], topics: [], notFound: [], omitted: 0 };
    if (!this.hasHistory(req.userId, req.currentTurnId)) return { ...empty, noHistory: true };

    const hard = !!req.filter && (req.filter.dayRanges.length > 0 || req.filter.instantRanges.length > 0);
    const soft = !!req.filter && req.filter.softDayRanges.length > 0;
    const mode: RecallMode = BROWSE_RE.test(req.text) && !hard
      ? "browse"
      : LIST_RE.test(req.text) && hard
        ? "list"
        : hard || soft || refersToPast(req.text)
          ? "full"
          : "light";

    const queryText = [stripRanges(req.text, req.filter?.expressions ?? []), mode === "light" ? "" : req.previousUserText ?? ""]
      .join(" ")
      .trim();
    const signals = this.signals(req.userId, queryText, req.queryVector);

    if (mode === "browse") return this.browse(req);

    const pack: MemoryPack = { ...empty, mode };
    let picked: Array<{ id: number; reason: RecalledTurn["reason"] }> = [];

    if (hard) {
      const inSpan = this.turnsInFilter(req.userId, req.filter!).filter((id) => id !== req.currentTurnId);
      const labels = req.filterLabels.join(" / ") || "that date";

      if (inSpan.length === 0) {
        pack.notFound.push(`No conversation found on ${labels}.`);
        picked = this.nearby(req, signals).map((id) => ({ id, reason: "nearby" as const }));
        if (picked.length === 0) picked = this.relevantAnywhere(req, signals, 3).map((id) => ({ id, reason: "relevant" as const }));
      } else if (mode === "list") {
        picked = inSpan.map((id) => ({ id, reason: "in-span" as const }));
      } else {
        const ranked = this.rank(inSpan, signals);
        const topical = ranked.filter((id) => signals.isRelevant(id));
        if (signals.terms.length > 0 && topical.length === 0) {
          // The day exists but the topic isn't on it: the user may have the day wrong (R3).
          pack.notFound.push(`Nothing about "${signals.terms.slice(0, 6).join(" ")}" on ${labels}; showing what was discussed then, plus close matches on nearby days.`);
          picked = [
            ...ranked.slice(0, 4).map((id) => ({ id, reason: "in-span" as const })),
            ...this.nearby(req, signals).map((id) => ({ id, reason: "nearby" as const })),
          ];
        } else {
          picked = [...topical, ...ranked.filter((id) => !topical.includes(id))].slice(0, 8).map((id) => ({ id, reason: "in-span" as const }));
        }
      }
      pack.digests = this.digestsFor(req.userId, req.filter!);
    } else {
      const limit = mode === "light" ? 3 : 6;
      const strongOnly = mode === "light";
      picked = this.relevantAnywhere(req, signals, limit, strongOnly).map((id) => ({ id, reason: "relevant" as const }));
      if (mode === "full" && picked.length === 0 && refersToPast(req.text)) {
        pack.notFound.push("No earlier conversation about this was found.");
      }
    }

    // Dedupe and drop turns already in the prompt as thread history.
    const seen = new Set<number>();
    picked = picked.filter((p) => !seen.has(p.id) && seen.add(p.id) && !req.excludeTurnIds.has(p.id));

    const { turns, omitted } = this.expandAndPack(picked, mode, req.budgetChars);
    pack.turns = turns;
    pack.omitted = omitted;
    pack.topics = this.topicsFor(req.userId, turns.map((t) => t.turnId));
    return pack;
  }

  /** For the ambiguity policy: how many relevant turns fall inside a candidate span? */
  countHits(userId: string, span: TemporalSpan, text: string, currentTurnId: number, ignore: Array<{ index: number; length: number }> = []): number {
    if (!span.days) return 0;
    const filter: MemoryTimeFilter = {
      dayRanges: span.granularity === "hour" ? [] : [span.days],
      instantRanges: span.granularity === "hour" ? [{ start: span.start, end: span.end }] : [],
      softDayRanges: [],
      expressions: [],
    };
    const ids = this.turnsInFilter(userId, filter).filter((id) => id !== currentTurnId);
    if (ids.length === 0) return 0;
    const q = ftsQuery(stripRanges(text, ignore));
    if (!q) return ids.length;
    const hits = new Set(this.ftsRank(userId, q, "turn"));
    return ids.filter((id) => hits.has(id)).length;
  }

  /** The time module's view of memory, for "since I asked about X" and friends. */
  anchors(userId: string, threadId: string, currentTurnId: number): AnchorLookup {
    return {
      lastVisit: (beforeMs) => this.store.lastVisit(userId, beforeMs),
      findTurnAbout: (topic, beforeMs) => {
        const q = ftsQuery(topic);
        if (!q) return null;
        for (const id of this.ftsRank(userId, q, "turn")) {
          if (id === currentTurnId) continue;
          const m = this.store.message(id);
          if (m && m.ts_utc < beforeMs && m.status === "complete") return { ts: m.ts_utc, localDay: m.local_day, preview: m.content.slice(0, 120) };
        }
        return null;
      },
      previousAnswerTs: () => {
        const row = this.db
          .prepare("SELECT ts_utc FROM messages WHERE thread_id = ? AND role = 'assistant' AND status != 'forgotten' ORDER BY id DESC LIMIT 1")
          .get(threadId) as { ts_utc: number } | undefined;
        return row?.ts_utc ?? null;
      },
    };
  }

  // ------------------------------------------------------------ internals

  private hasHistory(userId: string, currentTurnId: number) {
    const row = this.db
      .prepare("SELECT 1 AS x FROM messages WHERE user_id = ? AND role = 'user' AND status = 'complete' AND id != ? LIMIT 1")
      .get(userId, currentTurnId) as { x: number } | undefined;
    return !!row;
  }

  /** Everything needed to rank turns for this query, computed once. */
  private signals(userId: string, queryText: string, queryVector: Float32Array | null) {
    const terms = contentTerms(queryText);
    const q = ftsQuery(queryText);
    const fts = q ? this.ftsRank(userId, q, "turn") : [];
    const ftsSet = new Set(fts);

    const vec = new Map<number, number>();
    if (queryVector) {
      const rows = this.db
        .prepare("SELECT owner_id, vector FROM embeddings WHERE owner_type = 'turn' AND user_id = ? AND model = ?")
        .all(userId, this.embedder.model) as Array<{ owner_id: string; vector: Uint8Array }>;
      for (const r of rows) vec.set(Number(r.owner_id), dot(queryVector, fromBlob(r.vector)));
    }
    const vecRanked = [...vec.entries()].filter(([, s]) => s >= VEC_RELEVANT).sort((a, b) => b[1] - a[1]).map(([id]) => id);

    const entityIds = entitiesMentioned(this.db, userId, queryText);
    const entityTurns = entityIds.length
      ? (this.db
          .prepare(
            `SELECT DISTINCT turn_id FROM claims WHERE user_id = ? AND entity_id IN (${entityIds.map(() => "?").join(",")}) ORDER BY turn_id DESC`,
          )
          .all(userId, ...entityIds) as Array<{ turn_id: number }>).map((r) => r.turn_id)
      : [];
    const entitySet = new Set(entityTurns);

    return {
      terms,
      fts,
      vecRanked,
      entityTurns,
      vecScore: (id: number) => vec.get(id) ?? 0,
      isRelevant: (id: number) => ftsSet.has(id) || (vec.get(id) ?? 0) >= VEC_RELEVANT || entitySet.has(id),
      isStrong: (id: number) => (vec.get(id) ?? 0) >= VEC_STRONG || entitySet.has(id) || (vec.size === 0 && fts.indexOf(id) === 0),
    };
  }

  /** Order candidate turns by fused relevance; anything unmatched keeps recency order at the end. */
  private rank(candidates: number[], s: ReturnType<Retriever["signals"]>): number[] {
    const set = new Set(candidates);
    const fused = rrf([s.fts.filter((id) => set.has(id)), s.vecRanked.filter((id) => set.has(id)), s.entityTurns.filter((id) => set.has(id))]);
    const ranked = topByScore(fused, candidates.length);
    const rest = candidates.filter((id) => !fused.has(id)).sort((a, b) => b - a);
    return [...ranked, ...rest];
  }

  private relevantAnywhere(req: RetrieveRequest, s: ReturnType<Retriever["signals"]>, limit: number, strongOnly = false): number[] {
    const lists = [s.fts, s.vecRanked, s.entityTurns];
    const weights = [1, 1, 1];
    // Vague dates ("the other day") add a recency list instead of filtering.
    if (req.filter?.softDayRanges.length) {
      const softIds = this.turnsInFilter(req.userId, { dayRanges: req.filter.softDayRanges, instantRanges: [], softDayRanges: [], expressions: [] });
      lists.push(softIds);
      weights.push(0.5);
    }
    const fused = rrf(lists, 60, weights);
    return topByScore(fused, limit * 3)
      .filter((id) => id !== req.currentTurnId && (strongOnly ? s.isStrong(id) : s.isRelevant(id)))
      .slice(0, limit);
  }

  /** Same topic within a week either side of the requested dates (R3). */
  private nearby(req: RetrieveRequest, s: ReturnType<Retriever["signals"]>): number[] {
    if (s.terms.length === 0 && s.entityTurns.length === 0) return [];
    const widened: MemoryTimeFilter = {
      dayRanges: req.filter!.dayRanges.map((r) => ({ from: shiftDay(r.from, -7), to: shiftDay(r.to, 7) })),
      instantRanges: req.filter!.instantRanges.map((r) => ({ start: r.start - 7 * 864e5, end: r.end + 7 * 864e5 })),
      softDayRanges: [],
      expressions: [],
    };
    const ids = this.turnsInFilter(req.userId, widened).filter((id) => id !== req.currentTurnId);
    return this.rank(ids, s).filter((id) => s.isRelevant(id)).slice(0, 3);
  }

  private turnsInFilter(userId: string, f: MemoryTimeFilter): number[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [userId];
    for (const r of f.dayRanges) {
      clauses.push("(local_day BETWEEN ? AND ?)");
      params.push(r.from, r.to);
    }
    for (const r of f.instantRanges) {
      clauses.push("(ts_utc >= ? AND ts_utc < ?)");
      params.push(r.start, r.end);
    }
    if (clauses.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT id FROM messages
          WHERE user_id = ? AND role = 'user' AND status = 'complete' AND (${clauses.join(" OR ")})
          ORDER BY id DESC LIMIT 300`,
      )
      .all(...params) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  private ftsRank(userId: string, query: string, ownerType: string): number[] {
    try {
      const rows = this.db
        .prepare("SELECT owner_id FROM fts WHERE fts MATCH ? AND owner_type = ? AND user_id = ? ORDER BY bm25(fts) LIMIT 60")
        .all(query, ownerType, userId) as Array<{ owner_id: string }>;
      return rows.map((r) => Number(r.owner_id));
    } catch {
      // ftsQuery() quotes every term, so this shouldn't happen; if it does, degrade to vectors only.
      return [];
    }
  }

  private digestsFor(userId: string, f: MemoryTimeFilter) {
    const ranges = [...f.dayRanges, ...f.instantRanges.map((r) => ({ from: new Date(r.start).toISOString().slice(0, 10), to: new Date(r.end).toISOString().slice(0, 10) }))];
    if (ranges.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT local_day, summary FROM day_digests WHERE user_id = ? AND (${ranges.map(() => "(local_day BETWEEN ? AND ?)").join(" OR ")}) ORDER BY local_day LIMIT 14`,
      )
      .all(userId, ...ranges.flatMap((r) => [r.from, r.to])) as Array<{ local_day: string; summary: string }>;
    // A stale digest is still a decent overview, but the raw turns below are what count.
    return rows.map((r) => ({ day: r.local_day, summary: digestIsStale(this.db, userId, r.local_day) ? `${r.summary} (may be missing the latest turns)` : r.summary }));
  }

  private topicsFor(userId: string, turnIds: number[]) {
    if (turnIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT t.label, t.summary, t.open_items_json FROM topics t, json_each(t.turn_ids_json) j
          WHERE t.user_id = ? AND j.value IN (${turnIds.map(() => "?").join(",")})
          ORDER BY t.updated_at DESC LIMIT 3`,
      )
      .all(userId, ...turnIds) as Array<{ label: string; summary: string; open_items_json: string }>;
    return rows.map((r) => ({ label: r.label, summary: r.summary, openItems: parseJson<string[]>(r.open_items_json, []) }));
  }

  private browse(req: RetrieveRequest): MemoryPack {
    const topics = this.db
      .prepare("SELECT label, summary, open_items_json FROM topics WHERE user_id = ? ORDER BY updated_at DESC LIMIT 12")
      .all(req.userId) as Array<{ label: string; summary: string; open_items_json: string }>;
    const digests = this.db
      .prepare("SELECT local_day, summary FROM day_digests WHERE user_id = ? ORDER BY local_day DESC LIMIT 10")
      .all(req.userId) as Array<{ local_day: string; summary: string }>;
    // If derivation hasn't run yet (no API key, or just started), fall back to recent questions.
    const recent = topics.length || digests.length ? [] : this.recentTurnIds(req.userId, req.currentTurnId, 10);
    const { turns, omitted } = this.expandAndPack(recent.map((id) => ({ id, reason: "relevant" as const })), "list", req.budgetChars);
    return {
      mode: "browse",
      noHistory: false,
      turns,
      omitted,
      notFound: [],
      topics: topics.map((t) => ({ label: t.label, summary: t.summary, openItems: parseJson<string[]>(t.open_items_json, []) })),
      digests: digests.map((d) => ({ day: d.local_day, summary: d.summary })),
    };
  }

  private recentTurnIds(userId: string, currentTurnId: number, n: number) {
    return (this.db
      .prepare("SELECT id FROM messages WHERE user_id = ? AND role = 'user' AND status = 'complete' AND id != ? ORDER BY id DESC LIMIT ?")
      .all(userId, currentTurnId, n) as Array<{ id: number }>).map((r) => r.id);
  }

  private expandAndPack(picked: Array<{ id: number; reason: RecalledTurn["reason"] }>, mode: RecallMode, budget: number) {
    const turns: RecalledTurn[] = [];
    let used = 0;
    let omitted = 0;
    const answerCap = mode === "list" ? 600 : 1800;
    for (const p of picked) {
      const q = this.store.message(p.id);
      if (!q) continue;
      const a = this.store.replyTo(p.id);
      const turn: RecalledTurn = {
        turnId: q.id,
        threadId: q.thread_id,
        askedAt: q.ts_utc,
        tz: q.tz,
        localDay: q.local_day,
        question: redact(q.content),
        answer: a ? truncate(redact(a.content), answerCap) : "",
        answerStatus: !a ? "missing" : a.status === "partial" ? "partial" : "complete",
        claims: this.claimsFor(q),
        reason: p.reason,
      };
      const size = turn.question.length + turn.answer.length + turn.claims.length * 160;
      if (used + size > budget && turns.length > 0) {
        omitted++;
        continue;
      }
      used += size;
      turns.push(turn);
    }
    // Chronological reads better in the prompt.
    turns.sort((a, b) => a.askedAt - b.askedAt);
    return { turns, omitted };
  }

  private claimsFor(q: MessageRow): RecalledClaim[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, e.canonical,
                s.value AS later_value, s.observed_at AS later_at, s.status AS later_status
           FROM claims c JOIN entities e ON e.id = c.entity_id
           LEFT JOIN claims s ON s.id = c.superseded_by
          WHERE c.turn_id = ? ORDER BY c.id LIMIT 30`,
      )
      .all(q.id) as Array<{
      canonical: string;
      attribute: string;
      value: string;
      qualifiers_json: string;
      source_url: string | null;
      source_published_at: string | null;
      observed_at: number;
      status: RecalledClaim["status"];
      later_value: string | null;
      later_at: number | null;
      later_status: string | null;
    }>;
    return rows.map((r) => ({
      entity: r.canonical,
      attribute: r.attribute,
      value: r.value,
      qualifiers: parseJson<Record<string, string>>(r.qualifiers_json, {}),
      sourceUrl: r.source_url,
      sourcePublishedAt: r.source_published_at,
      observedAt: r.observed_at,
      status: r.status,
      laterValue: r.later_value != null ? { value: r.later_value, observedAt: r.later_at!, status: r.later_status! } : undefined,
    }));
  }
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
