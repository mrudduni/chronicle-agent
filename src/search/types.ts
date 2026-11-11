/**
 * The search contract. The agent's single tool is `web_search`; this is what
 * sits behind it. Any backend that implements SearchProvider can be dropped in.
 */

export interface SearchRequest {
  query: string;
  /**
   * news: dated articles, changelogs, announcements; honours since/until.
   * page: the current state of a page (pricing, docs, plans). Ignores dates on
   *       purpose: evergreen pages often have no publish date, so a date
   *       filter would drop exactly the page you need (edge case T29).
   */
  mode: "news" | "page";
  since?: string; // YYYY-MM-DD
  until?: string; // YYYY-MM-DD
  domains?: string[];
  maxResults?: number;
}

export interface SearchResult {
  /** Stable id within one turn ("S3"), used for citations. Assigned by the formatter. */
  id: string;
  title: string;
  url: string;
  content: string;
  /** YYYY-MM-DD if the provider knows it; null for undated pages. */
  publishedAt: string | null;
  score?: number;
}

export interface SearchProvider {
  readonly name: string;
  /** Whether since/until are actually enforced (Tavily yes, the built-in fallback no). */
  readonly supportsDateFilter: boolean;
  search(req: SearchRequest, signal?: AbortSignal): Promise<Omit<SearchResult, "id">[]>;
}
