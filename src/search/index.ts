/**
 * The search service the agent's single tool calls into.
 *
 * Picks the backend, caches identical searches for a few minutes (follow-up
 * questions often re-ask the same thing), and assigns result ids (S1, S2, ...)
 * that are unique within a turn, so citations are unambiguous even across
 * several parallel searches.
 */
import { config } from "../config";
import { anthropic } from "../llm/client";
import { AnthropicBuiltinProvider } from "./anthropic-builtin";
import { TavilyProvider } from "./tavily";
import type { SearchProvider, SearchRequest, SearchResult } from "./types";

export * from "./types";
export { formatResultsForModel, orderResults } from "./format";

export function createSearchProvider(): SearchProvider | null {
  if (config.tavilyKey) return new TavilyProvider(config.tavilyKey);
  if (anthropic) return new AnthropicBuiltinProvider(anthropic);
  return null;
}

export class SearchService {
  private cache = new Map<string, { at: number; results: Omit<SearchResult, "id">[] }>();

  constructor(
    readonly provider: SearchProvider | null,
    private readonly ttlMs = config.searchCacheTtlMs,
    private readonly now: () => number = Date.now,
  ) {}

  /** Per-turn id counter, so ids stay unique across parallel searches in one answer. */
  newTurn() {
    let n = 0;
    return { nextId: () => `S${++n}` };
  }

  async search(req: SearchRequest, ids: { nextId(): string }, signal?: AbortSignal) {
    if (!this.provider) throw new Error("No search backend configured (set TAVILY_API_KEY).");
    const key = JSON.stringify([this.provider.name, req.query.trim().toLowerCase(), req.mode, req.since, req.until, req.domains]);
    const hit = this.cache.get(key);
    let raw: Omit<SearchResult, "id">[];
    let fromCache = false;
    if (hit && this.now() - hit.at < this.ttlMs) {
      raw = hit.results;
      fromCache = true;
    } else {
      raw = await this.provider.search(req, signal);
      this.cache.set(key, { at: this.now(), results: raw });
      this.evict();
    }
    // Same URL twice in one result set adds noise, not evidence.
    const seen = new Set<string>();
    const results: SearchResult[] = raw
      .filter((r) => !seen.has(r.url) && seen.add(r.url))
      .map((r) => ({ ...r, id: ids.nextId() }));
    return { results, fromCache, dateFilterApplied: this.provider.supportsDateFilter && req.mode === "news" };
  }

  private evict() {
    if (this.cache.size < 300) return;
    const cutoff = this.now() - this.ttlMs;
    for (const [k, v] of this.cache) if (v.at < cutoff) this.cache.delete(k);
  }
}
