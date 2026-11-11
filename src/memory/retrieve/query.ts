/**
 * Turning a chat message into memory search queries.
 *
 * Two things matter here:
 *  - Strip the time expressions first. "On Monday" is handled by the date
 *    filter; left in, the word "Monday" would match unrelated turns that
 *    mention Monday (R6).
 *  - Never hand raw user text to FTS5 MATCH. Quotes, hyphens, colons and
 *    words like NEAR are query syntax there, and a stray one throws. Each
 *    term is quoted individually (R15).
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our so than that the their them then there these they this to us was we were what when where " +
    "which who why will with would you your about any anything since still today yesterday ago last week asked ask " +
    "tell told said say remember changed change correct answer again please hey hi thanks just also something big"
  ).split(" "),
);

/** Remove character ranges (the time expressions) from text. */
export function stripRanges(text: string, ranges: Array<{ index: number; length: number }>): string {
  let out = text;
  for (const r of [...ranges].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, r.index) + " ".repeat(r.length) + out.slice(r.index + r.length);
  }
  return out.replace(/\s+/g, " ").trim();
}

export function contentTerms(text: string): string[] {
  const terms = (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? [])
    .map((t) => t.replace(/[.\-]+$/, ""))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  return [...new Set(terms)].slice(0, 24);
}

/** A safe FTS5 query: every term quoted, OR-ed together. Null if nothing is left. */
export function ftsQuery(text: string): string | null {
  const terms = contentTerms(text);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}
