/**
 * How recalled memory is shown to the model and to the user.
 *
 * The model gets a compact, structured block: when each turn happened (in the
 * zone the user was in then, plus its age), what was asked, what was
 * answered, and the claim ledger with sources and dates. Explicit "not found"
 * lines come first, so the model can't skip over them.
 */
import { DateTime } from "luxon";
import { ageOfDay, formatDay, formatInstant, type TimeContext } from "../../time";
import type { MemoryPack, RecalledTurn } from "./retriever";

export function renderMemoryForPrompt(pack: MemoryPack, ctx: TimeContext): string {
  if (pack.noHistory) {
    return "No earlier conversations with this user exist. If they refer to one, say you have no record of it, then help with what they're asking.";
  }
  if (pack.mode === "none") return "";

  const today = ctx.now.toISODate()!;
  const lines: string[] = [];

  for (const n of pack.notFound) lines.push(`NOT FOUND: ${n}`);

  if (pack.digests.length) {
    lines.push("", "Day notes:");
    for (const d of pack.digests) lines.push(`- ${formatDay(d.day)} (${ageOfDay(d.day, today)}): ${d.summary}`);
  }

  if (pack.topics.length) {
    lines.push("", "Topics:");
    for (const t of pack.topics) {
      lines.push(`- ${t.label}: ${t.summary}${t.openItems.length ? ` Open: ${t.openItems.join("; ")}.` : ""}`);
    }
  }

  if (pack.turns.length) {
    lines.push("", "Past turns (oldest first):");
    for (const t of pack.turns) lines.push(renderTurn(t, ctx, today));
  }

  if (pack.omitted > 0) lines.push("", `(${pack.omitted} more matching turns were left out for space.)`);
  if (lines.length === 0) return "";
  return lines.join("\n").trim();
}

function renderTurn(t: RecalledTurn, ctx: TimeContext, today: string): string {
  const when = formatInstant(t.askedAt, t.tz);
  const age = ageOfDay(t.localDay, today);
  const zoneNote = t.tz !== ctx.tz ? ` (user's clock was on ${t.tz} then)` : "";
  const tag = t.reason === "nearby" ? " [near the requested date, not on it]" : t.reason === "relevant" ? " [related]" : "";
  const out = [`\n## Turn ${t.turnId}: ${when}, ${age}${zoneNote}${tag}`, `User asked: ${t.question}`];
  if (t.answerStatus === "missing") out.push("My answer: (none saved)");
  else out.push(`My answer${t.answerStatus === "partial" ? " (cut off before it finished)" : ""}: ${t.answer}`);

  if (t.claims.length) {
    out.push("Facts I stated then:");
    for (const c of t.claims) {
      const q = Object.entries(c.qualifiers).map(([k, v]) => `${k}=${v}`).join(", ");
      const src = c.sourceUrl ? `source ${c.sourceUrl}${c.sourcePublishedAt ? ` (published ${c.sourcePublishedAt})` : ""}` : c.status === "user" ? "stated by the user" : "no source (low trust)";
      const later = c.laterValue
        ? `; later observed as ${c.laterValue.value} on ${DateTime.fromMillis(c.laterValue.observedAt, { zone: ctx.tz }).toFormat("d LLL yyyy")}`
        : "";
      out.push(`- ${c.entity} | ${c.attribute}: ${c.value}${q ? ` [${q}]` : ""} | ${src}${later}`);
    }
  }
  return out.join("\n");
}

/** Short summary for the UI's "memory used" chip. */
export function memoryChip(pack: MemoryPack) {
  return {
    mode: pack.mode,
    noHistory: pack.noHistory,
    notFound: pack.notFound,
    turns: pack.turns.map((t) => ({ turnId: t.turnId, threadId: t.threadId, day: t.localDay, question: t.question.slice(0, 140), reason: t.reason })),
    topics: pack.topics.map((t) => t.label),
    omitted: pack.omitted,
  };
}
