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

export type AgentEvent =
  | { type: "turn"; threadId: string; turnId: number }
  | { type: "time"; now: string; tz: string; tzSource: string; frozen: boolean; chips: TimeChip[] }
  | ({ type: "memory" } & ReturnType<typeof memoryChip>)
  | { type: "search"; callId: string; query: string; mode: string; since?: string; state: "start" | "done" | "error"; results?: number; fromCache?: boolean; error?: string }
  | { type: "token"; text: string }
  | { type: "sources"; sources: Array<{ id: string; title: string; url: string; publishedAt: string | null }> }
  | { type: "done"; messageId: number; partial: boolean; timings: Record<string, number> }
  | { type: "error"; message: string };

export type Emit = (e: AgentEvent) => void;
