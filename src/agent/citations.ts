/**
 * Which search results an answer actually cited.
 *
 * The prompt asks for "[S3]", but models also group ids ("[S1, S4]"), so
 * every S-id inside a bracket counts. Used when an answer finishes and when
 * an old thread is reloaded, so both show the same sources.
 */
export function citedIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const group of text.matchAll(/\[(S\d+(?:\s*,\s*S\d+)*)\]/g)) {
    for (const id of group[1]!.split(/\s*,\s*/)) ids.add(id);
  }
  return ids;
}
