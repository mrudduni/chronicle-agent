/**
 * The claim ledger: atomic, checkable facts pulled out of each answer.
 *
 * "Is your answer from 3 November still correct?" is only answerable if we
 * know exactly what was claimed, about what, from which source, and when.
 * This job extracts that after the answer has been sent, so it costs the user
 * no time.
 *
 * Trust rules:
 *  - The extractor must quote the sentence each claim came from, and code
 *    checks the quote really is in the answer and the value is in the quote.
 *    Anything that fails is dropped rather than stored wrong (M5).
 *  - A claim with no cited source is kept but marked `unsourced`, and
 *    re-checks treat it as low trust (M3).
 *  - Prices carry their qualifiers (plan, billing period, region, currency,
 *    seats), so "$20/seat/month billed annually" never gets compared with
 *    "$25/seat/month billed monthly" and reported as a price rise (M8).
 *  - Facts the user stated ("no, it's $25 now") become `user` claims and
 *    supersede what the agent said earlier (M4).
 */
import { z } from "zod";
import { type Db, tx } from "../../db";
import type { WorkerLlm } from "../../llm/types";
import type { SearchResult } from "../../search/types";
import type { MemoryStore } from "../store";
import { knownEntityNames, upsertEntity } from "./entities";

export const CLAIMS_VERSION = 1;

const ClaimsOut = z.object({
  claims: z.array(
    z.object({
      said_by: z.enum(["assistant", "user"]),
      entity: z.string(),
      entity_type: z.enum(["product", "company", "person", "place", "concept", "other"]),
      attribute: z.string(),
      value: z.string(),
      unit: z.string().nullable(),
      plan: z.string().nullable(),
      billing_period: z.string().nullable(),
      region: z.string().nullable(),
      currency: z.string().nullable(),
      seats: z.string().nullable(),
      quote: z.string(),
      source_ids: z.array(z.string()),
    }),
  ),
});

const SYSTEM = `You build a ledger of checkable facts from one chat turn, so they can be re-verified later.

Extract only facts that can change over time and that someone might re-check: prices, plans, limits, quotas, versions, release or launch dates, availability, policies, who holds a role, funding, headcount.
Skip opinions, advice, general explanations and anything timeless.

For each fact:
- entity: the product or company it is about. If it matches a name in the known-entities list, use that exact name.
- attribute: short and generic ("price", "free tier", "storage limit", "latest version", "launched").
- value: as stated, e.g. "$20", "10 GB", "v4.2".
- plan, billing_period, region, currency, seats: fill in when the text says them; otherwise null.
- quote: copy the exact sentence or table row from the text the fact came from. Do not paraphrase.
- source_ids: the [S#] markers attached to that sentence, e.g. ["S2"]. Empty if none.
- said_by: "assistant" for facts from the answer, "user" for facts the user stated or corrected.

Return an empty list if there is nothing worth tracking.`;

export async function deriveClaims(db: Db, store: MemoryStore, worker: WorkerLlm, turnId: number) {
  const q = store.message(turnId);
  const a = store.replyTo(turnId);
  if (!q || !a || a.status !== "complete" || isTrivial(q.content, a.content)) return;

  const sources = store
    .searchesForTurn(turnId)
    .flatMap((s) => s.results as SearchResult[])
    .filter((r) => r && typeof r.id === "string");
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  const known = knownEntityNames(db, q.user_id, 80);
  const out = await worker.json(ClaimsOut, {
    system: SYSTEM,
    maxTokens: 3000,
    user: [
      `Known entities: ${known.length ? known.join(", ") : "(none yet)"}`,
      `Sources:\n${sources.map((s) => `[${s.id}] ${s.title} | ${s.url} | published ${s.publishedAt ?? "unknown"}`).join("\n") || "(none)"}`,
      `User message:\n${q.content}`,
      `Assistant answer:\n${a.content}`,
    ].join("\n\n"),
  });

  const answerNorm = norm(a.content);
  const userNorm = norm(q.content);

  tx(db, () => {
    // Re-running a newer extractor version replaces this turn's claims.
    db.prepare("DELETE FROM claims WHERE turn_id = ?").run(turnId);

    for (const c of out.claims) {
      const haystack = c.said_by === "user" ? userNorm : answerNorm;
      if (!haystack.includes(norm(c.quote)) || !valueInQuote(c.value, c.quote)) continue;

      const source = c.source_ids.map((id) => sourceById.get(id.replace(/[[\]]/g, ""))).find(Boolean);
      const entityId = upsertEntity(db, q.user_id, c.entity.trim(), c.entity_type);
      const qualifiers = Object.fromEntries(
        Object.entries({ plan: c.plan, billing_period: c.billing_period, region: c.region, currency: c.currency, seats: c.seats, unit: c.unit })
          .filter(([, v]) => v != null && v !== ""),
      );
      const status = c.said_by === "user" ? "user" : source ? "sourced" : "unsourced";

      const res = db
        .prepare(
          `INSERT INTO claims (user_id, turn_id, entity_id, attribute, value, qualifiers_json, quote, source_url, source_published_at, observed_at, status, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          q.user_id, turnId, entityId, c.attribute.toLowerCase(), c.value, JSON.stringify(qualifiers), c.quote,
          source?.url ?? null, source?.publishedAt ?? null, a.ts_utc, status, CLAIMS_VERSION,
        );
      const newId = Number(res.lastInsertRowid);

      // Older observations of the same fact (same entity, attribute and
      // qualifiers) are superseded by this one, but kept: re-checks need them.
      db.prepare(
        `UPDATE claims SET superseded_by = ?
          WHERE user_id = ? AND entity_id = ? AND attribute = ? AND qualifiers_json = ?
            AND id != ? AND superseded_by IS NULL AND observed_at <= ?`,
      ).run(newId, q.user_id, entityId, c.attribute.toLowerCase(), JSON.stringify(qualifiers), newId, a.ts_utc);
    }
  });
}

/** "thanks!", "ok", "lol" don't produce facts or topics (M18). */
export function isTrivial(question: string, answer: string): boolean {
  return question.trim().length < 16 && !question.includes("?") && answer.length < 400;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[*_`#>|]/g, " ").replace(/\[s\d+\]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Does the quote actually contain the value? Exact match is too strict
 * ("$20/user/month" vs "$20 per user per month"), so require the value's
 * numbers to all appear, or most of its words if it has no numbers.
 */
function valueInQuote(value: string, quote: string): boolean {
  const q = quote.toLowerCase();
  const numbers = value.match(/\d+(?:[.,]\d+)?/g);
  if (numbers?.length) return numbers.every((n) => q.includes(n));
  const words = value.toLowerCase().match(/[\p{L}]{3,}/gu) ?? [];
  if (!words.length) return q.includes(value.toLowerCase());
  return words.filter((w) => q.includes(w)).length / words.length >= 0.5;
}
