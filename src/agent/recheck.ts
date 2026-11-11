/**
 * Re-check plans for "has anything changed?" / "is that still correct?".
 *
 * Built in code from the claim ledger, not improvised by the model: which
 * entities, which facts, what we said and when, and which two searches to run
 * for each. The two searches are deliberate (T29):
 *   - a "page" search for the current pricing/plans page, with no date filter,
 *     because pricing pages are evergreen and have no publish date;
 *   - a "news" search since the original date, for launches and changes.
 */
import { DateTime } from "luxon";
import type { MemoryPack } from "../memory/retrieve/retriever";
import type { SearchWindow, TimeContext } from "../time";

const CHANGE_RE =
  /\b(?:chang(?:e|ed|es)|still (?:correct|true|right|valid|accurate|the case)|any (?:updates?|news|changes)|shipped|launched|released|announced|since|up to date|outdated|anything new)\b/i;

export function isChangeQuestion(text: string): boolean {
  return CHANGE_RE.test(text);
}

export function buildRecheckPlan(text: string, pack: MemoryPack, window: SearchWindow | null, ctx: TimeContext): string | null {
  if (!isChangeQuestion(text) || pack.turns.length === 0) return null;

  const turns = pack.turns.filter((t) => t.reason !== "relevant" || pack.turns.length <= 2);
  const byEntity = new Map<string, string[]>();
  for (const t of turns) {
    for (const c of t.claims) {
      const said = DateTime.fromMillis(c.observedAt, { zone: ctx.tz }).toFormat("ccc d LLL");
      const q = Object.entries(c.qualifiers).map(([k, v]) => `${k}=${v}`).join(", ");
      const line = `${c.attribute}: ${c.value}${q ? ` [${q}]` : ""}, said ${said}${c.status === "unsourced" ? " (unsourced)" : ""}`;
      byEntity.set(c.entity, [...(byEntity.get(c.entity) ?? []), line]);
    }
  }

  const since = window?.since ?? ([...turns.map((t) => t.localDay)].sort()[0] ?? ctx.now.toISODate()!);
  const lines = ["Re-check plan (from memory):"];
  if (byEntity.size) {
    for (const [entity, facts] of byEntity) lines.push(`- ${entity}: ${facts.join("; ")}`);
    lines.push(
      `For each item above, in one parallel step: a "page" search for its current pricing/plans page, and a "news" search with since=${since} for launches and changes.`,
    );
  } else {
    // The claim ledger may not exist yet (derivation still running, or no API key earlier).
    lines.push(
      "- No stored facts for these turns. Work out the items from the recalled turns above (e.g. the products that were shortlisted).",
      `Then for each, in one parallel step: a "page" search for its current pricing/plans page and a "news" search with since=${since}.`,
    );
  }
  lines.push("Answer with a table: item | then (date) | now (source, date) | Changed / Unchanged / Couldn't verify.");
  return lines.join("\n");
}
