/**
 * The chat UI, in three columns:
 *
 *   threads (grouped by day)  |  conversation  |  research panel
 *
 * plus a second view, the memory map: what the agent remembers, drawn on a
 * timeline, with a panel listing everything said about the selected thing.
 *
 * The research panel shows the evidence behind one answer: dates, memory,
 * every search and page. It follows the newest answer while one is being
 * written, and jumps to any answer whose citation or summary line is clicked.
 * On narrow screens the threads and the panel become drawers.
 *
 * State is deliberately simple: the server is the source of truth for
 * history; the UI holds the open thread's messages and updates the last one
 * as events stream in.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AgentEvent,
  type DemoState,
  type Health,
  type MemoryMap,
  type Profile,
  type StoredMessage,
  type ThreadSummary,
  api,
  browserTz,
  setProfile,
} from "./api";
import { MemoryMapView } from "./MemoryMap";
import { MessageView, type UiMessage } from "./Message";
import { ResearchPanel } from "./Research";
import { ThingPanel } from "./ThingPanel";

const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return [];
  }
})();

const EXAMPLES = [
  "Shortlist 5 CRM tools for a 20-person sales team, with current pricing.",
  "Compare Postgres hosting for a small SaaS: Neon, Supabase, RDS.",
  "What did I ask you yesterday? Is your answer still correct?",
];

// Small per-browser preferences. Storage can be unavailable (private windows,
// blocked site data); the app then just uses the defaults.
function load(key: string): string | null {
  try {
    return localStorage.getItem(`chronicle.${key}`);
  } catch {
    return null;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(`chronicle.${key}`, value);
  } catch {
    // Not worth surfacing; the preference just won't survive a reload.
  }
}

const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local time
const wide = () => window.matchMedia("(min-width: 1100px)").matches;

export function App() {
  const [profile, setProfileState] = useState<Profile>(() => {
    const p: Profile = load("profile") === "demo" ? "demo" : "me";
    setProfile(p);
    return p;
  });
  const [demo, setDemo] = useState<DemoState | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Research panel: on wide screens it sits beside the chat, open by default
  // and remembered. On narrow ones it's a drawer over the chat, so it only
  // opens when asked (a citation, the summary line) and closes on send.
  const [panelOpen, setPanelOpen] = useState(() => wide() && (load("panel") ?? "open") === "open");
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<{ id: string; nonce: number } | null>(null);
  const [threadsOpen, setThreadsOpen] = useState(false); // drawer on narrow screens
  const [view, setView] = useState<"chat" | "map">("chat");
  const [map, setMap] = useState<MemoryMap | null>(null);
  const [thing, setThing] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const refreshThreads = useCallback(() => api.threads().then(setThreads).catch(() => {}), []);

  useEffect(() => {
    // `npm run dev` starts the UI and API together, and the UI is usually up
    // first, so keep trying until the API answers.
    let timer: ReturnType<typeof setTimeout>;
    const poll = () =>
      api
        .health()
        .then((h) => {
          setHealth(h);
          void refreshThreads();
          void api.demo().then(setDemo).catch(() => {});
        })
        .catch(() => {
          timer = setTimeout(poll, 1500);
        });
    poll();
    return () => clearTimeout(timer);
  }, [refreshThreads]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, messages.at(-1)?.content]);

  function togglePanel(open: boolean) {
    setPanelOpen(open);
    if (wide()) save("panel", open ? "open" : "closed");
  }

  /** Show one answer's research, optionally scrolled to a source ("S3"). */
  function research(key: string, sourceId?: string) {
    setFocusKey(key);
    setHighlight(sourceId ? { id: sourceId, nonce: Date.now() } : null);
    setPanelOpen(true);
    if (wide()) save("panel", "open");
  }

  async function openMap() {
    if (busy) return;
    setView("map");
    setThreadsOpen(false);
    setThing(null);
    setMap(await api.memoryMap().catch(() => null));
  }

  async function openThread(id: string) {
    if (busy) return;
    setView("chat");
    setThreadId(id);
    setThreadsOpen(false);
    const { messages } = await api.thread(id);
    const ui = fromStored(messages);
    setMessages(ui);
    setFocusKey(ui.findLast((m) => m.role === "assistant")?.key ?? null);
    setHighlight(null);
  }

  function newChat() {
    if (busy) return;
    setView("chat");
    setThreadId(undefined);
    setMessages([]);
    setFocusKey(null);
    setThreadsOpen(false);
  }

  /** Apply one streamed event to the assistant message being written. */
  const apply = (e: AgentEvent) => {
    if (e.type === "turn") {
      setThreadId(e.threadId);
      setMessages((ms) => ms.map((m, i) => (i === ms.length - 2 && m.role === "user" ? { ...m, turnId: e.turnId } : m)));
      return;
    }
    setMessages((ms) => {
      const last = ms.at(-1);
      if (!last || last.role !== "assistant") return ms;
      const a = last.activity ?? { searches: [] };
      let next: UiMessage = last;
      switch (e.type) {
        case "time":
          next = { ...last, activity: { ...a, time: e } };
          break;
        case "memory":
          next = { ...last, activity: { ...a, memory: e } };
          break;
        case "search": {
          // Each search sends "start" then "done"/"error" with the same callId; keep one row per search.
          const known = a.searches.some((s) => s.callId === e.callId);
          const searches = known ? a.searches.map((s) => (s.callId === e.callId ? e : s)) : [...a.searches, e];
          next = { ...last, activity: { ...a, searches } };
          break;
        }
        case "token":
          next = { ...last, content: last.content + e.text };
          break;
        case "sources":
          next = { ...last, sources: e.sources };
          break;
        case "done":
          next = { ...last, pending: false, partial: e.partial, activity: { ...a, timings: e.timings } };
          break;
        case "error":
          next = { ...last, pending: false, error: e.message };
          break;
      }
      return [...ms.slice(0, -1), next];
    });
  };

  /** Send a message. `fresh` starts a new conversation (used by "Ask" on the memory map). */
  async function send(text: string, fresh = false) {
    const t = text.trim();
    if (!t || busy) return;
    const targetThread = fresh ? undefined : threadId;
    if (fresh) {
      setView("chat");
      setThreadId(undefined);
    }
    setInput("");
    setBusy(true);
    const stamp = Date.now();
    setMessages((ms) => [
      ...(fresh ? [] : ms),
      { key: `u${stamp}`, role: "user", content: t, sources: [] },
      { key: `a${stamp}`, role: "assistant", content: "", question: t, pending: true, sources: [], activity: { searches: [] } },
    ]);
    // The panel follows the answer being written, so searches appear there live.
    setFocusKey(`a${stamp}`);
    setHighlight(null);
    if (!wide()) setPanelOpen(false);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await api.chat({ threadId: targetThread, text: t }, apply, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) apply({ type: "error", message: (err as Error).message });
    } finally {
      setMessages((ms) => ms.map((m) => (m.pending ? { ...m, pending: false, partial: m.partial || controller.signal.aborted } : m)));
      setBusy(false);
      abortRef.current = null;
      void refreshThreads();
    }
  }

  async function forget(turnId: number) {
    if (!confirm("Erase this question, its answer and everything remembered from them? This can't be undone.")) return;
    await api.forget(turnId);
    if (threadId) await openThread(threadId);
  }

  async function changeZone(tz: string) {
    await api.setTimezone(tz === "" ? null : tz);
    setHealth(await api.health());
  }

  /** Switch between the user's own memory and the demo history. */
  async function switchProfile(p: Profile) {
    if (busy) return;
    setProfile(p);
    save("profile", p);
    setProfileState(p);
    setThreadId(undefined);
    setMessages([]);
    setFocusKey(null);
    setThing(null);
    setHealth(await api.health());
    await refreshThreads();
    if (view === "map") setMap(await api.memoryMap().catch(() => null));
  }

  /**
   * Load the demo, or reload it when its dates were set for an earlier day,
   * so "on Monday" in the suggested questions still means the right Monday.
   */
  async function enterDemo(force = false) {
    if (busy || demoBusy) return;
    setDemoBusy(true);
    try {
      const state = !force && demo?.loaded && demo.seededFor === today() ? demo : await api.loadDemo();
      setDemo(state);
      await switchProfile("demo");
    } finally {
      setDemoBusy(false);
    }
  }

  const focused = messages.find((m) => m.key === focusKey) ?? messages.findLast((m) => m.role === "assistant");
  const showPanel = view === "chat" && panelOpen && messages.length > 0;
  // On the map, the side panel is the thing detail: always there on wide screens, on demand on narrow ones.
  const showThing = view === "map" && (thing !== null || wide());

  return (
    <div className={`layout ${showPanel || showThing ? "with-panel" : ""} ${threadsOpen ? "threads-open" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand">
            <Logo /> Chronicle
          </div>
          <button className="new" onClick={newChat} disabled={busy}>
            + New chat
          </button>
          <button className={`nav-item ${view === "map" ? "active" : ""}`} onClick={openMap} disabled={busy} title="What I remember, on a timeline">
            Memory map
          </button>
        </div>
        <nav>
          {groupByDay(threads).map(([label, items]) => (
            <div key={label} className="thread-group">
              <div className="group-label">{label}</div>
              {items.map((t) => (
                <button key={t.id} className={`thread ${view === "chat" && t.id === threadId ? "active" : ""}`} onClick={() => openThread(t.id)} title={t.first_question ?? ""}>
                  {t.title ?? t.first_question ?? "Untitled"}
                </button>
              ))}
            </div>
          ))}
          {threads.length === 0 && <div className="no-threads">Your conversations will appear here, grouped by day.</div>}
        </nav>
        {health && (
          <div className="sidebar-foot">
            <span title="Chat model">{health.model}</span>
            <span title="Search backend">{health.search ? `${health.search.name}${health.search.dateFilter ? "" : " (no date filter)"}` : "no search"}</span>
          </div>
        )}
      </aside>
      <div className="scrim" onClick={() => setThreadsOpen(false)} />

      <main>
        <header>
          <button className="icon menu" onClick={() => setThreadsOpen(true)} aria-label="Show conversations">
            ☰
          </button>
          <div className="status">
            {profile === "demo" && (
              <span className="demo-bar">
                <span className="badge demo" title="Sample conversations, kept apart from your own memory">
                  Demo data
                </span>
                <button className="link" onClick={() => enterDemo(true)} disabled={busy || demoBusy} title="Reload the demo with dates relative to today; demo chats are cleared">
                  Reset
                </button>
                <button className="link" onClick={() => switchProfile("me")} disabled={busy}>
                  Exit demo
                </button>
              </span>
            )}
            {health && !health.hasModelKey && <span className="badge warn">no {health.keyName}</span>}
            {health && !health.search && <span className="badge warn">no search key</span>}
            {health?.clockFrozen && (
              <span className="badge warn" title="NOW is set in .env">
                clock frozen: {new Date(health.now).toLocaleString()}
              </span>
            )}
            {health && (
              <select className="tz" value={health.declaredTz ?? ""} onChange={(e) => changeZone(e.target.value)} title="Which clock to read dates by">
                <option value="">{browserTz()} (this device)</option>
                {ZONES.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            )}
            {view === "chat" && messages.length > 0 && (
              <button className={`panel-toggle ${showPanel ? "on" : ""}`} onClick={() => togglePanel(!showPanel)} title="Dates, memory and every search behind an answer">
                Research
              </button>
            )}
          </div>
        </header>

        {view === "map" ? (
          <section className="map-view">
            <div className="map-intro">
              <h1>Memory map</h1>
              <p>
                What I remember, by when it came up. Things we discussed sit above the timeline; the conversations they came from sit below.
                Hover a thing to trace it, click it for everything I said about it, click a conversation to open it.
              </p>
            </div>
            {map ? <MemoryMapView map={map} selected={thing} onSelect={setThing} onOpenConversation={openThread} /> : <p className="muted">Loading…</p>}
          </section>
        ) : (
          <section className="chat">
            {messages.length === 0 && profile === "demo" ? (
              <div className="empty">
                <h1>You're looking at demo data</h1>
                <p>
                  A few past conversations are already in memory: email marketing tools a couple of weeks ago, Postgres hosting the Tuesday before
                  last, and a CRM shortlist on Monday. Open them on the left, or ask about them. Prices in them are sample values, so re-checking
                  should turn up changes.
                </p>
                <div className="examples">
                  {(demo?.suggestions ?? []).map((ex) => (
                    <button key={ex} onClick={() => send(ex)}>
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            ) : messages.length === 0 ? (
              <div className="empty">
                <h1>What do you want to look into?</h1>
                <p>I search the web for anything current, and I remember what we talk about, so you can come back and ask what's changed since.</p>
                <div className="examples">
                  {EXAMPLES.map((ex) => (
                    <button key={ex} onClick={() => send(ex)}>
                      {ex}
                    </button>
                  ))}
                </div>
                <div className="demo-offer">
                  <div>
                    <strong>New here?</strong> Try it on demo data: a few earlier conversations, so you can ask "what did I ask you last Tuesday?"
                    or "has any of that changed since Monday?" straight away. Your own memory isn't touched.
                  </div>
                  <button onClick={() => enterDemo()} disabled={demoBusy}>
                    {demoBusy ? "Loading…" : "Try demo data"}
                  </button>
                </div>
              </div>
            ) : (
              messages.map((m) => (
                <MessageView key={m.key} m={m} focused={showPanel && m.key === focused?.key} onForget={busy ? undefined : forget} onResearch={research} />
              ))
            )}
            <div ref={endRef} />
          </section>
        )}

        {view === "chat" && (
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <textarea
              value={input}
              placeholder="Ask anything… (Enter to send, Shift+Enter for a new line)"
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />
            {busy ? (
              <button type="button" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            ) : (
              <button type="submit" disabled={!input.trim()}>
                Send
              </button>
            )}
          </form>
        )}
      </main>

      {showPanel && <ResearchPanel message={focused} highlight={highlight} onClose={() => togglePanel(false)} onOpenThread={openThread} />}
      {showThing && (
        <ThingPanel
          thingKey={thing}
          onClose={() => (thing ? setThing(null) : setView("chat"))}
          onOpenConversation={openThread}
          onAsk={(text) => void send(text, true)}
        />
      )}
    </div>
  );
}

/** Stored messages to UI messages: answers get their question and their searches back. */
function fromStored(messages: StoredMessage[]): UiMessage[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return messages.map((m) => ({
    key: `m${m.id}`,
    role: m.role,
    content: m.content,
    turnId: m.role === "user" ? m.id : undefined,
    question: m.role === "assistant" && m.replyTo ? byId.get(m.replyTo)?.content : undefined,
    partial: m.status === "partial",
    sources: m.sources ?? [],
    activity:
      m.role === "assistant"
        ? {
            searches: (m.searches ?? []).map((s) => ({
              type: "search" as const,
              callId: s.callId,
              query: s.query,
              mode: s.mode,
              since: s.since,
              state: "done" as const,
              results: s.items.length,
              items: s.items,
            })),
          }
        : undefined,
  }));
}

/** Sidebar groups: Today, Yesterday, then one group per day ("Mon 9 Nov"). */
function groupByDay(threads: ThreadSummary[]): Array<[string, ThreadSummary[]]> {
  const groups = new Map<string, ThreadSummary[]>();
  const dayKey = (ms: number) => new Date(ms).toLocaleDateString("en-CA");
  const todayKey = today();
  const yesterdayKey = dayKey(Date.now() - 86_400_000);
  for (const t of threads) {
    const at = t.last_at ?? t.created_at;
    const key = dayKey(at);
    const label =
      key === todayKey
        ? "Today"
        : key === yesterdayKey
          ? "Yesterday"
          : new Date(at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    groups.set(label, [...(groups.get(label) ?? []), t]);
  }
  return [...groups];
}

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="3" />
      <path d="M16 9v7l5 3" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}
