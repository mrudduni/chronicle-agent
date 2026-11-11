/**
 * The research panel: everything behind one answer, on the right of the chat.
 *
 *   Dates     how each time expression was read, and any assumption made
 *   Memory    which earlier conversations were recalled (click to open one)
 *   Searches  every query, and every page it returned, with its publish date
 *             and age. Pages the answer cited are marked; each opens in a
 *             new tab.
 *
 * Clicking a citation in the answer opens the panel scrolled to that page and
 * flashes it, so checking a claim takes one click.
 */
import { useEffect, useRef } from "react";
import { type SearchEvent, type UiMessage, hostOf } from "./Message";

interface Props {
  message: UiMessage | undefined;
  /** Source id to scroll to and flash ("S3"); `nonce` re-triggers it on repeat clicks. */
  highlight: { id: string; nonce: number } | null;
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
}

export function ResearchPanel({ message, highlight, onClose, onOpenThread }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!highlight || !bodyRef.current) return;
    const el = bodyRef.current.querySelector<HTMLElement>(`[data-source="${highlight.id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth; // restart the animation on repeat clicks
    el.classList.add("flash");
  }, [highlight, message?.key]);

  const a = message?.activity;
  const cited = new Set(message?.sources.map((s) => s.id) ?? []);
  const chips = a?.time?.chips ?? [];
  const mem = a?.memory;
  const searches = a?.searches ?? [];
  const pages = searches.reduce((n, s) => n + (s.items?.length ?? 0), 0);

  return (
    <aside className="research" aria-label="Research">
      <div className="research-head">
        <div>
          <div className="research-title">Research</div>
          {message?.question && <div className="research-q">{message.question}</div>}
        </div>
        <button className="icon" onClick={onClose} title="Close panel" aria-label="Close research panel">
          ×
        </button>
      </div>

      <div className="research-body" ref={bodyRef}>
        {!message ? (
          <p className="research-empty">Ask something, or click the summary line or a citation on an answer, to see what was searched and read for it.</p>
        ) : (
          <>
            {chips.length > 0 && (
              <section>
                <h3>Dates</h3>
                {chips.map((c, i) => (
                  <div key={i} className={`r-date ${c.decision}`}>
                    <span className="expr">“{c.expression}”</span>
                    <span className="arrow">→</span>
                    <span className="value">{c.interpretation}</span>
                    {c.decision !== "use" && c.note && <div className="why">{c.note}</div>}
                  </div>
                ))}
              </section>
            )}

            {mem && (mem.turns.length > 0 || mem.notFound.length > 0 || mem.noHistory) && (
              <section>
                <h3>Memory</h3>
                {mem.noHistory && <div className="r-note">No earlier conversations yet.</div>}
                {mem.notFound.map((n, i) => (
                  <div key={i} className="r-note warn">
                    {n}
                  </div>
                ))}
                {mem.turns.map((t) => (
                  <button key={t.turnId} className="r-turn" onClick={() => onOpenThread(t.threadId)} title="Open this conversation">
                    <span className="day">
                      {t.day}
                      {t.reason === "nearby" ? " · nearby day" : ""}
                    </span>
                    <span className="q">{t.question}</span>
                  </button>
                ))}
              </section>
            )}

            <section>
              <h3>
                Searches{searches.length > 0 && <span className="count"> {searches.length} queries · {pages} pages</span>}
              </h3>
              {searches.length === 0 && <div className="r-note">{message.pending ? "No searches yet." : "Answered without searching."}</div>}
              {searches.map((s) => (
                <SearchCard key={s.callId} s={s} cited={cited} />
              ))}
            </section>

            {a?.timings && !message.pending && (
              <section className="r-timings">
                prep {a.timings.preMs} ms · first token {fmtMs(a.timings.firstTokenMs)} · total {fmtMs(a.timings.totalMs)}
                {a.timings.rounds ? ` · ${a.timings.rounds} model rounds` : ""}
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function SearchCard({ s, cited }: { s: SearchEvent; cited: Set<string> }) {
  const items = s.items ?? [];
  return (
    <div className={`r-search ${s.state}`}>
      <div className="r-search-head">
        <span className={`mode ${s.mode}`}>{s.mode === "news" ? "news" : "page"}</span>
        <span className="query">{s.query}</span>
      </div>
      <div className="r-search-meta">
        {s.state === "start" && "searching…"}
        {s.state === "error" && `failed: ${s.error}`}
        {s.state === "done" && `${s.results ?? items.length} results${s.since ? ` · published since ${s.since}` : ""}${s.fromCache ? " · cached" : ""}`}
      </div>
      {items.length > 0 && (
        <ol className="r-results">
          {items.map((r) => (
            <li key={r.id}>
              <a className={`r-result ${cited.has(r.id) ? "cited" : ""}`} href={r.url} target="_blank" rel="noreferrer" data-source={r.id}>
                <span className="n">{r.id.slice(1)}</span>
                <span className="body">
                  <span className="title">{r.title || hostOf(r.url)}</span>
                  <span className="meta">
                    {hostOf(r.url)} · {r.publishedAt ? `${r.publishedAt} (${age(r.publishedAt)})` : "undated"}
                    {cited.has(r.id) && <span className="tag">cited</span>}
                  </span>
                  {r.snippet && <span className="snippet">{r.snippet}</span>}
                </span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function fmtMs(ms: number | undefined) {
  if (ms == null || ms < 0) return "–";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "3 days ago", "2 months ago". Approximate is fine here; the exact date is shown next to it. */
function age(day: string) {
  const days = Math.round((Date.now() - Date.parse(`${day}T12:00:00`)) / 86_400_000);
  if (Number.isNaN(days)) return "";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${(days / 365).toFixed(1)} years ago`;
}
