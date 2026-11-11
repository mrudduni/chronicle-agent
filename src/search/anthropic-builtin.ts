/**
 * Fallback search backend: Anthropic's server-side web search.
 *
 * Used when no TAVILY_API_KEY is set, so the app still works with a single
 * key. Rather than changing the agent loop (which would then mix two kinds of
 * tool), it's wrapped to look like any other provider: a small model runs the
 * server-side search and we collect the result URLs plus the passages it cited.
 *
 * Trade-offs, also shown in the UI: no server-side date filter (the date
 * window goes into the query text instead), an extra model call per search
 * (slower), and page text is only what the model chose to cite.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { SearchProvider, SearchRequest, SearchResult } from "./types";

export class AnthropicBuiltinProvider implements SearchProvider {
  readonly name = "anthropic-web-search";
  readonly supportsDateFilter = false;

  // Sonnet 5.5 supports the current web_search tool version; it's quick and
  // only has to search and quote, not reason.
  constructor(private readonly client: Anthropic, private readonly model = "claude-sonnet-5-5") {}

  async search(req: SearchRequest, signal?: AbortSignal): Promise<Omit<SearchResult, "id">[]> {
    const window = [req.since && `published after ${req.since}`, req.until && `before ${req.until}`].filter(Boolean).join(" and ");
    const res = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 2000,
        output_config: { effort: "low" },
        tools: [
          {
            type: "web_search_20260209",
            name: "web_search",
            max_uses: 2,
            ...(req.domains?.length ? { allowed_domains: req.domains } : {}),
          },
        ],
        messages: [
          {
            role: "user",
            content:
              `Search the web for: ${req.query}${window ? ` (only sources ${window})` : ""}.\n` +
              "Then list the most relevant findings as short factual bullet points, quoting numbers, prices and dates exactly as the sources state them. No commentary.",
          },
        ],
      },
      { signal },
    );

    // URL -> result, with every passage the model cited from it.
    const byUrl = new Map<string, Omit<SearchResult, "id">>();
    for (const block of res.content) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) {
          if (!byUrl.has(r.url)) byUrl.set(r.url, { title: r.title, url: r.url, content: "", publishedAt: pageAgeToDay(r.page_age) });
        }
      }
      if (block.type === "text" && block.citations) {
        for (const c of block.citations) {
          if (c.type !== "web_search_result_location") continue;
          const entry = byUrl.get(c.url) ?? { title: c.title ?? c.url, url: c.url, content: "", publishedAt: null };
          if (!entry.content.includes(c.cited_text)) entry.content = `${entry.content} ${c.cited_text}`.trim();
          byUrl.set(c.url, entry);
        }
      }
    }
    // Results the model never cited have no readable text (their content is encrypted), so keep only cited ones.
    return [...byUrl.values()].filter((r) => r.content).slice(0, req.maxResults ?? 6);
  }
}

function pageAgeToDay(age: string | null): string | null {
  if (!age) return null;
  const d = new Date(age);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
