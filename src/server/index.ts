/**
 * HTTP API. Thin by design: validate input, call the agent, stream events.
 * No business logic lives here.
 *
 *   POST /api/chat           one turn, streamed as server-sent events
 *   GET  /api/threads        sidebar list
 *   GET  /api/threads/:id    a thread's messages
 *   POST /api/forget         erase a turn and everything derived from it
 *   POST /api/timezone       declare (or clear) the timezone to use
 *   GET  /api/health         config summary for the UI header
 *   GET  /api/traces/latest  timings of the last turn (dev panel)
 *   GET  /api/demo           whether demo data is loaded, and questions to try
 *   POST /api/demo           load (or reload) the demo history for today's dates
 *   GET  /api/memory/map     what memory holds, shaped as a graph (read-only queries)
 *   GET  /api/memory/thing/:key  everything said about one thing, oldest first
 *
 * Every route works on one "profile": the person's own memory, or the demo.
 * The UI picks it with the x-chronicle-profile header; the two never mix.
 */
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { citedIds } from "../agent/citations";
import { createApp } from "../app";
import { DEMO_USER, demoState, seedDemo } from "../demo/seed";
import { config } from "../config";
import { LocalEmbedder } from "../embed";
import { chatModel } from "../llm/client";
import { memoryMap, thingDetail } from "../memory/map";
import { isValidZone } from "../time";
import { type AgentEvent, type SearchItem, toSearchItems } from "../agent/events";

const app = createApp();
const { store, agent, derivation, db, clock, search } = app;
const userOf = (c: Context) => (c.req.header("x-chronicle-profile") === "demo" ? DEMO_USER : config.defaultUserId);

// Load the embedding model and heal derived memory in the background, so
// neither delays the server coming up.
if (app.embedder instanceof LocalEmbedder) void app.embedder.warm();
derivation.catchUp();

const api = new Hono().basePath("/api");

const ChatBody = z.object({
  threadId: z.string().uuid().optional(),
  text: z.string().trim().min(1).max(20_000),
  tz: z.string().max(64).optional(),
  locale: z.string().max(35).optional(),
});

api.post("/chat", async (c) => {
  const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "bad request" }, 400);
  const body = parsed.data;
  const userId = userOf(c);

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());
    // The agent emits synchronously; writes are chained so they go out in
    // order, and awaited at the end so the last events aren't lost when the
    // stream closes.
    let writes = Promise.resolve();
    const emit = (e: AgentEvent) => {
      writes = writes.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) })).catch(() => {});
    };
    try {
      await agent.run({ userId, threadId: body.threadId, text: body.text, browserTz: body.tz, locale: body.locale }, emit, controller.signal);
    } catch (err) {
      console.error("[chat]", err);
      emit({ type: "error", message: (err as Error).message });
    }
    await writes;
  });
});

api.get("/threads", (c) => c.json(store.listThreads(userOf(c))));

api.get("/threads/:id", (c) => {
  const thread = store.thread(c.req.param("id"));
  if (!thread || thread.user_id !== userOf(c)) return c.json({ error: "not found" }, 404);
  const messages = store.threadMessages(thread.id).map((m) => {
    // Re-attach the searches and cited sources to old answers, so citations
    // still link and the research panel still works after a reload.
    let sources: SearchItem[] = [];
    let searches: Array<{ callId: string; query: string; mode: string; since?: string; items: SearchItem[] }> = [];
    if (m.role === "assistant" && m.reply_to) {
      const cited = citedIds(m.content);
      searches = store.searchesForTurn(m.reply_to).map((s) => ({
        callId: `stored-${s.id}`,
        query: s.query,
        mode: s.params.mode ?? "page",
        since: s.params.since,
        items: toSearchItems(s.results as Parameters<typeof toSearchItems>[0]),
      }));
      sources = searches.flatMap((s) => s.items).filter((r) => cited.has(r.id));
    }
    return { id: m.id, role: m.role, content: m.content, ts: m.ts_utc, tz: m.tz, localDay: m.local_day, status: m.status, replyTo: m.reply_to, sources, searches };
  });
  return c.json({ thread, messages });
});

api.post("/forget", async (c) => {
  const body = z.object({ turnId: z.number().int() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "turnId required" }, 400);
  const ok = store.forgetTurn(userOf(c), body.data.turnId, clock.now());
  return c.json({ ok });
});

api.post("/timezone", async (c) => {
  const body = z.object({ tz: z.string().nullable() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success || (body.data.tz !== null && !isValidZone(body.data.tz))) return c.json({ error: "unknown timezone" }, 400);
  store.declareTz(userOf(c), body.data.tz, clock.now());
  return c.json({ ok: true, tz: body.data.tz });
});

api.get("/health", (c) => {
  const user = store.user(userOf(c));
  return c.json({
    provider: config.provider,
    model: config.agentModel,
    worker: config.workerModel,
    hasModelKey: !!chatModel,
    keyName: config.keyName,
    search: search.provider ? { name: search.provider.name, dateFilter: search.provider.supportsDateFilter } : null,
    embeddings: app.embedder.ready() ? app.embedder.model : "loading or off",
    clockFrozen: clock.frozen,
    now: new Date(clock.now()).toISOString(),
    declaredTz: user.declaredTz,
    pendingJobs: derivation.queue.pendingCount(),
  });
});

api.get("/memory/map", (c) => c.json(memoryMap(db, userOf(c))));

api.get("/memory/thing/:key", (c) => {
  const detail = thingDetail(db, userOf(c), c.req.param("key"));
  return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
});

api.get("/demo", (c) => c.json(demoState(app)));

api.post("/demo", async (c) => {
  const body = z.object({ tz: z.string().max(64).optional() }).safeParse(await c.req.json().catch(() => ({})));
  return c.json(seedDemo(app, body.success ? body.data.tz : undefined));
});

api.get("/traces/latest", (c) => {
  const row = db.prepare("SELECT data_json, ts_utc FROM traces ORDER BY id DESC LIMIT 1").get() as { data_json: string; ts_utc: number } | undefined;
  return c.json(row ? { ...JSON.parse(row.data_json), at: row.ts_utc } : null);
});

serve({ fetch: api.fetch, port: config.port }, (info) => {
  console.log(`API on http://localhost:${info.port}  (UI: http://localhost:5173)`);
  console.log(`Model: ${config.agentModel} (${config.provider}), worker: ${config.workerModel}`);
  if (!chatModel) console.warn(`${config.keyName} is not set: chat will not work until it is.`);
  if (!config.tavilyKey) {
    console.warn(
      config.anthropicKey
        ? "TAVILY_API_KEY is not set: using Anthropic's built-in web search (no date filters)."
        : "TAVILY_API_KEY is not set: web search is off. Get a free key at https://app.tavily.com.",
    );
  }
  if (clock.frozen) console.warn(`Clock is frozen at ${new Date(clock.now()).toISOString()} (NOW in .env).`);
});
