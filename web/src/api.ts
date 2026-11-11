/**
 * Client side of the API. The chat endpoint streams server-sent events over
 * a POST, which EventSource can't do, so the stream is read with fetch and
 * parsed by hand (it's only "event:" and "data:" lines).
 */
import type { AgentEvent } from "../../src/agent/events";

export type { AgentEvent };

export interface Source {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
}

export interface StoredMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  ts: number;
  tz: string;
  localDay: string;
  status: string;
  replyTo: number | null;
  sources: Source[];
}

export interface ThreadSummary {
  id: string;
  title: string | null;
  created_at: number;
  last_at: number | null;
  first_question: string | null;
}

export interface Health {
  model: string;
  hasAnthropicKey: boolean;
  search: { name: string; dateFilter: boolean } | null;
  embeddings: string;
  clockFrozen: boolean;
  now: string;
  declaredTz: string | null;
  pendingJobs: number;
}

export const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetch("/api/health").then((r) => json<Health>(r)),
  threads: () => fetch("/api/threads").then((r) => json<ThreadSummary[]>(r)),
  thread: (id: string) => fetch(`/api/threads/${id}`).then((r) => json<{ messages: StoredMessage[] }>(r)),
  forget: (turnId: number) =>
    fetch("/api/forget", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turnId }) }).then((r) => json(r)),
  setTimezone: (tz: string | null) =>
    fetch("/api/timezone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tz }) }).then((r) => json(r)),

  async chat(body: { threadId?: string; text: string }, onEvent: (e: AgentEvent) => void, signal: AbortSignal) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, tz: browserTz(), locale: navigator.language }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`chat failed: ${res.status} ${await res.text()}`);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      // Events are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = raw
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) onEvent(JSON.parse(data) as AgentEvent);
      }
    }
  },
};
