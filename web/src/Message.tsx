/**
 * One message in the chat.
 *
 * An answer shows a one-line summary of the agent's working ("Tue 3 Nov ·
 * recalled 2 · 4 searches") and the answer itself. The detail lives in the
 * research panel on the right: clicking the summary, a citation or a source
 * opens it on that answer, scrolled to the page in question. Keeping the
 * detail out of the reading column means the answer stays easy to read and
 * the evidence is one click away instead of buried above it.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentEvent, SearchItem, Source } from "./api";

type TimeEvent = Extract<AgentEvent, { type: "time" }>;
type MemoryEvent = Extract<AgentEvent, { type: "memory" }>;
export type SearchEvent = Extract<AgentEvent, { type: "search" }>;

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
  /** For answers: the question they answer (shown in the research panel). */
  question?: string;
  pending?: boolean;
  partial?: boolean;
  error?: string;
  sources: Source[];
  activity?: Activity;
}

interface Props {
  m: UiMessage;
  focused: boolean;
  onForget?: (turnId: number) => void;
  /** Open the research panel on this answer, optionally at one source ("S3"). */
  onResearch: (key: string, sourceId?: string) => void;
}

export function MessageView({ m, focused, onForget, onResearch }: Props) {
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

  const hasWorking = !!m.activity && (m.pending || summaryOf(m.activity, false) !== "");
  return (
    <div className={`msg assistant ${focused ? "focused" : ""}`}>
      {hasWorking && (
        <button className={`working ${m.pending ? "live" : ""}`} onClick={() => onResearch(m.key)} title="Show dates, memory and every search in the research panel">
          <span className="dot" />
          <span className="text">{summaryOf(m.activity!, !!m.pending) || "Working…"}</span>
          <span className="open">Research ›</span>
        </button>
      )}
      {m.content ? (
        <div className="answer">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (props) => <CiteOrLink {...props} onCite={(id) => onResearch(m.key, id)} /> }}>
            {linkCitations(m.content)}
          </ReactMarkdown>
          {m.pending && <span className="cursor" />}
        </div>
      ) : m.pending ? (
        <div className="answer muted">Thinking…</div>
      ) : null}
      {m.partial && <div className="note">This answer was cut off.</div>}
      {m.error && <div className="error">{m.error}</div>}
      {m.sources.length > 0 && (
        <div className="source-chips">
          {m.sources.map((s) => (
            <button key={s.id} className="source-chip" onClick={() => onResearch(m.key, s.id)} title={s.title}>
              <span className="n">{s.id.slice(1)}</span>
              <span className="host">{hostOf(s.url)}</span>
              {s.publishedAt && <span className="date">{s.publishedAt}</span>}
            </button>
          ))}
        </div>
      )}
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

/** Citations open the research panel at that source; ordinary links open in a new tab. */
function CiteOrLink(props: { href?: string; children?: React.ReactNode; onCite: (id: string) => void }) {
  const { href, children, onCite } = props;
  const m = href?.match(/^#cite-(S\d+)$/);
  if (m) {
    return (
      <button className="cite" onClick={() => onCite(m[1]!)} title="Show this source">
        {children}
      </button>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export function summaryOf(a: Activity, pending: boolean) {
  const running = a.searches.filter((s) => s.state === "start");
  if (pending && running.length) return `Searching: ${running.map((s) => s.query).join(" · ")}`;
  const parts: string[] = [];
  if (a.time?.chips.length) parts.push(a.time.chips.map((c) => c.interpretation).join(", "));
  if (a.memory?.turns.length) parts.push(`recalled ${a.memory.turns.length}`);
  if (a.memory?.notFound.length) parts.push("no matching memory");
  if (a.searches.length) parts.push(`${a.searches.length} ${a.searches.length === 1 ? "search" : "searches"}`);
  return parts.join(" · ");
}

export function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export type { SearchItem };
