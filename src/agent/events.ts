/**
 * Events streamed to the UI over SSE during one turn.
 *
 * The UI shows the agent's working as it happens: how it read the dates,
 * what it recalled, each search as it runs. That makes it feel fast
 * (something visible within milliseconds) and lets the user catch a wrong
 * assumption before reading the whole answer.
 */
import type { TimeChip } from "../time";
import type { memoryChip } from "../memory/retrieve/render";

/** One search result as the UI shows it in the research panel. */
export interface SearchItem {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
  snippet: string;
}

export function toSearchItems(results: Array<{ id: string; title: string; url: string; publishedAt: string | null; content?: string }>): SearchItem[] {
  return results.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    publishedAt: r.publishedAt,
    snippet: (r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 280),
  }));
}

export type AgentEvent =
  | { type: "turn"; threadId: string; turnId: number }
  | { type: "time"; now: string; tz: string; tzSource: string; frozen: boolean; chips: TimeChip[] }
  | ({ type: "memory" } & ReturnType<typeof memoryChip>)
  | {
      type: "search";
      callId: string;
      query: string;
      mode: string;
      since?: string;
      state: "start" | "done" | "error";
      results?: number;
      /** The results themselves, on "done", so the user can open each page. */
      items?: SearchItem[];
      fromCache?: boolean;
      error?: string;
    }
  | { type: "token"; text: string }
  | { type: "sources"; sources: Array<{ id: string; title: string; url: string; publishedAt: string | null }> }
  | { type: "done"; messageId: number; partial: boolean; timings: Record<string, number> }
  | { type: "error"; message: string };

export type Emit = (e: AgentEvent) => void;
