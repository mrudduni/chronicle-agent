/**
 * Reciprocal rank fusion (Cormack et al., 2009).
 *
 * Keyword (BM25) and vector (cosine) scores are on different scales and can't
 * be added together meaningfully. RRF ignores the scores and uses only rank
 * positions: score(d) = sum over lists of 1 / (k + rank). It needs no tuning
 * and is hard to beat for hybrid search. k = 60 is the value from the paper.
 */
export function rrf<T extends string | number>(lists: T[][], k = 60, weights?: number[]): Map<T, number> {
  const scores = new Map<T, number>();
  lists.forEach((list, li) => {
    const w = weights?.[li] ?? 1;
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + w / (k + rank + 1));
    });
  });
  return scores;
}

export function topByScore<T>(scores: Map<T, number>, n: number): T[] {
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => id);
}
