/**
 * Tavily search backend (primary).
 *
 * Chosen because it returns page content with each result (no extra fetch
 * round trip), filters by publish date on the server (start_date/end_date),
 * and has a free tier with no card, so reviewers can run this themselves.
 *
 * API: POST https://api.tavily.com/search with a Bearer key.
 */
import { DateTime } from "luxon";
import type { SearchProvider, SearchRequest, SearchResult } from "./types";

interface TavilyResponse {
  results: Array<{ title: string; url: string; content: string; score?: number; published_date?: string | null }>;
}

export class TavilyProvider implements SearchProvider {
  readonly name = "tavily";
  readonly supportsDateFilter = true;

  constructor(private readonly apiKey: string) {}

  async search(req: SearchRequest, signal?: AbortSignal): Promise<Omit<SearchResult, "id">[]> {
    const dated = req.mode === "news" && (req.since || req.until);
    const body: Record<string, unknown> = {
      query: req.query,
      topic: req.mode === "news" ? "news" : "general",
      search_depth: "basic",
      chunks_per_source: 3,
      max_results: req.maxResults ?? 6,
      include_published_date: true,
    };
    if (dated) {
      if (req.since) body.start_date = req.since;
      if (req.until) body.end_date = req.until;
      // Drop results outside the window, and undated ones, for "what changed since" news searches.
      body.filter_by_published_date = true;
    }
    if (req.domains?.length) body.include_domains = req.domains;

    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Tavily ${res.status}${res.status === 429 ? " (rate limited)" : res.status === 432 ? " (plan limit reached)" : ""}: ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as TavilyResponse;
    return (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content ?? "",
      publishedAt: toDay(r.published_date),
      score: r.score,
    }));
  }
}

function toDay(s?: string | null): string | null {
  if (!s) return null;
  // Tavily returns RFC 2822 or ISO strings depending on the source.
  const iso = DateTime.fromISO(s, { zone: "UTC" });
  if (iso.isValid) return iso.toISODate();
  const rfc = DateTime.fromRFC2822(s, { zone: "UTC" });
  if (rfc.isValid) return rfc.toISODate();
  const loose = new Date(s);
  return Number.isNaN(loose.getTime()) ? null : loose.toISOString().slice(0, 10);
}
