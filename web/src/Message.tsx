/**
 * One message in the chat, plus the agent's visible working for that turn:
 * how it read the dates, what it recalled, which searches it ran, and the
 * sources it cited. The working is shown above the answer and collapses
 * once the answer is done, so it informs without getting in the way.
 */
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentEvent, Source } from "./api";

type TimeEvent = Extract<AgentEvent, { type: "time" }>;
type MemoryEvent = Extract<AgentEvent, { type: "memory" }>;
type SearchEvent = Extract<AgentEvent, { type: "search" }>;

export interface Activity {
  time?: TimeEvent;
  memory?: MemoryEvent;
  searches: SearchEvent[];
  timings?: Record<string, number>;
}

export interface UiMessage {
  key: string;
  role: "user" | "assistant";
  content: string;
  /** For user messages: the turn id, used by "forget". */
  turnId?: number;
  pending?: boolean;
  partial?: boolean;
  error?: string;
  sources: Source[];
  activity?: Activity;
}

export function MessageView({ m, onForget }: { m: UiMessage; onForget?: (turnId: number) => void }) {
  if (m.role === "user") {
    return (
      <div className="msg user">
        <div className="bubble">{m.content}</div>
        {m.turnId && onForget && (
          <button className="forget" title="Erase this question, its answer and everything remembered from them" onClick={() => onForget(m.turnId!)}>
            forget
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="msg assistant">
      {m.activity && <ActivityView a={m.activity} pending={!!m.pending} />}
      {m.content ? (
        <div className="answer">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (props) => <CiteOrLink {...props} sources={m.sources} /> }}>
            {linkCitations(m.content)}
          </ReactMarkdown>
          {m.pending && <span className="cursor" />}
        </div>
      ) : m.pending ? (
        <div className="answer muted">Thinking…</div>
      ) : null}
      {m.partial && <div className="note">This answer was cut off.</div>}
      {m.error && <div className="error">{m.error}</div>}
      {m.sources.length > 0 && <SourceList sources={m.sources} />}
    </div>
  );
}

/**
 * "[S3]" in the answer becomes a link the renderer turns into a numbered
 * citation. Some models group them ("[S1, S4]"), so each id in a group gets
 * its own link.
 *
 * Markdown tables can't hold line breaks, so models sometimes write "<br>"
 * inside a cell. HTML isn't rendered (on purpose: answers quote web pages),
 * so it's turned into a visible separator instead of showing up as raw text.
 */
function linkCitations(text: string) {
  return text
    .replace(/\[(S\d+(?:\s*,\s*S\d+)*)\]/g, (_, ids: string) =>
      ids
        .split(/\s*,\s*/)
        .map((id) => `[${id.slice(1)}](#cite-${id})`)
        .join(" "),
    )
    .replace(/<br\s*\/?>/gi, " · ");
}

function CiteOrLink(props: { href?: string; children?: React.ReactNode; sources: Source[] }) {
  const { href, children, sources } = props;
  const m = href?.match(/^#cite-(S\d+)$/);
  if (m) {
    const s = sources.find((x) => x.id === m[1]);
    return (
      <a className="cite" href={s?.url ?? "#"} target="_blank" rel="noreferrer" title={s ? `${s.title}${s.publishedAt ? ` (${s.publishedAt})` : ""}` : "source"}>
        {children}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function SourceList({ sources }: { sources: Source[] }) {
  return (
    <ol className="sources">
      {sources.map((s) => (
        <li key={s.id} value={Number(s.id.slice(1))}>
          <a href={s.url} target="_blank" rel="noreferrer">
            {s.title || hostOf(s.url)}
          </a>
          <span className="meta">
            {hostOf(s.url)}
            {s.publishedAt ? ` · ${s.publishedAt}` : " · undated"}
          </span>
        </li>
      ))}
    </ol>
  );
}

function ActivityView({ a, pending }: { a: Activity; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const expanded = pending || open;
  const chips = a.time?.chips ?? [];
  const mem = a.memory;
  const recalled = mem && mem.turns.length > 0;
  const nothing = chips.length === 0 && !recalled && !mem?.notFound.length && a.searches.length === 0;
  if (nothing && !pending) return null;

  return (
    <div className="activity">
      <button className="activity-toggle" onClick={() => setOpen(!open)} disabled={pending}>
        {summary(a, pending)}
      </button>
      {expanded && (
        <div className="activity-body">
          {chips.map((c, i) => (
            <div key={i} className={`chip time ${c.decision}`} title={c.note}>
              <span className="label">“{c.expression}”</span> → {c.interpretation}
              {c.decision !== "use" && c.note && <div className="sub">{c.note}</div>}
            </div>
          ))}
          {mem?.notFound.map((n, i) => (
            <div key={`nf${i}`} className="chip memory missing">
              {n}
            </div>
          ))}
          {recalled && (
            <div className="chip memory">
              Recalled {mem!.turns.length} earlier {mem!.turns.length === 1 ? "turn" : "turns"}
              <ul>
                {mem!.turns.map((t) => (
                  <li key={t.turnId}>
                    <span className="meta">{t.day}{t.reason === "nearby" ? " (nearby day)" : ""}</span> {t.question}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {a.searches.map((s) => (
            <div key={s.callId} className={`chip search ${s.state}`}>
              <span className="label">{s.mode === "news" ? `news${s.since ? ` since ${s.since}` : ""}` : "page"}</span> {s.query}
              <span className="meta">
                {s.state === "start" ? " searching…" : s.state === "error" ? ` failed: ${s.error}` : ` ${s.results} results${s.fromCache ? " (cached)" : ""}`}
              </span>
            </div>
          ))}
          {a.timings && !pending && (
            <div className="timings">
              prep {a.timings.preMs} ms · first token {a.timings.firstTokenMs} ms · total {(a.timings.totalMs! / 1000).toFixed(1)} s
              {a.timings.cacheReadTokens ? ` · ${a.timings.cacheReadTokens} cached tokens` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function summary(a: Activity, pending: boolean) {
  const parts: string[] = [];
  const running = a.searches.filter((s) => s.state === "start");
  if (a.time?.chips.length) parts.push(a.time.chips.map((c) => c.interpretation).join(", "));
  if (a.memory?.turns.length) parts.push(`recalled ${a.memory.turns.length}`);
  if (a.memory?.notFound.length) parts.push("no matching memory");
  if (a.searches.length) parts.push(`${a.searches.length} ${a.searches.length === 1 ? "search" : "searches"}`);
  if (pending && running.length) return `Searching: ${running.map((s) => s.query).join(" · ")}`;
  return parts.join(" · ") || (pending ? "Working…" : "Details");
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
