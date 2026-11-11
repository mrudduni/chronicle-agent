/**
 * The chat UI: threads on the left, conversation on the right.
 *
 * State is deliberately simple: the server is the source of truth for
 * history; the UI holds the open thread's messages and updates the last one
 * as events stream in.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type AgentEvent, type DemoState, type Health, type Profile, type StoredMessage, type ThreadSummary, api, browserTz, setProfile } from "./api";
import { MessageView, type UiMessage } from "./Message";

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

// Remember demo mode across reloads. Storage can be unavailable (private
// windows, blocked site data); the app then just starts on the user's own data.
function savedProfile(): Profile {
  try {
    return localStorage.getItem("chronicle.profile") === "demo" ? "demo" : "me";
  } catch {
    return "me";
  }
}

function saveProfile(p: Profile) {
  try {
    localStorage.setItem("chronicle.profile", p);
  } catch {
    // Not worth surfacing; demo mode just won't survive a reload.
  }
}

const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local time

export function App() {
  const [profile, setProfileState] = useState<Profile>(() => {
    const p = savedProfile();
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
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const refreshThreads = useCallback(() => api.threads().then(setThreads).catch(() => {}), []);

  useEffect(() => {
    // `npm run dev` starts the UI and API together, and the UI is usually up
    // first, so keep trying until the API answers.
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      api
        .health()
        .then((h) => {
          setHealth(h);
          void refreshThreads();
          void api.demo().then(setDemo).catch(() => {});
        })
        .catch(() => {
          timer = setTimeout(load, 1500);
        });
    load();
    return () => clearTimeout(timer);
  }, [refreshThreads]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  async function openThread(id: string) {
    if (busy) return;
    setThreadId(id);
    const { messages } = await api.thread(id);
    setMessages(messages.map(fromStored));
  }

  function newChat() {
    if (busy) return;
    setThreadId(undefined);
    setMessages([]);
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

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setInput("");
    setBusy(true);
    const stamp = Date.now();
    setMessages((ms) => [
      ...ms,
      { key: `u${stamp}`, role: "user", content: t, sources: [] },
      { key: `a${stamp}`, role: "assistant", content: "", pending: true, sources: [], activity: { searches: [] } },
    ]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await api.chat({ threadId, text: t }, apply, controller.signal);
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

  /** Switch between the user's own memory and the demo history. */
  async function switchProfile(p: Profile) {
    if (busy) return;
    setProfile(p);
    saveProfile(p);
    setProfileState(p);
    setThreadId(undefined);
    setMessages([]);
    setHealth(await api.health());
    await refreshThreads();
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

  async function changeZone(tz: string) {
    await api.setTimezone(tz === "" ? null : tz);
    setHealth(await api.health());
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <button className="new" onClick={newChat}>
          New chat
        </button>
        <nav>
          {threads.map((t) => (
            <button key={t.id} className={`thread ${t.id === threadId ? "active" : ""}`} onClick={() => openThread(t.id)} title={t.first_question ?? ""}>
              <span className="title">{t.title ?? t.first_question ?? "Untitled"}</span>
              <span className="meta">{t.last_at ? new Date(t.last_at).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : ""}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main>
        <header>
          <div className="brand">Chronicle</div>
          {health && (
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
              {!health.hasModelKey && <span className="badge warn">no {health.keyName}</span>}
              <span className="badge" title="search backend">
                {health.search ? `${health.search.name}${health.search.dateFilter ? "" : " (no date filter)"}` : "no search"}
              </span>
              {health.clockFrozen && <span className="badge warn" title="NOW is set in .env">clock frozen: {new Date(health.now).toLocaleString()}</span>}
              <select className="tz" value={health.declaredTz ?? ""} onChange={(e) => changeZone(e.target.value)} title="Which clock to read dates by">
                <option value="">{browserTz()} (this device)</option>
                {ZONES.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </div>
          )}
        </header>

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
            messages.map((m) => <MessageView key={m.key} m={m} onForget={busy ? undefined : forget} />)
          )}
          <div ref={endRef} />
        </section>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            value={input}
            placeholder="Ask anything…"
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
      </main>
    </div>
  );
}

function fromStored(m: StoredMessage): UiMessage {
  return {
    key: `m${m.id}`,
    role: m.role,
    content: m.content,
    turnId: m.role === "user" ? m.id : undefined,
    partial: m.status === "partial",
    sources: m.sources ?? [],
  };
}
