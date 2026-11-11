/**
 * One turn, start to finish. Start reading the codebase here.
 *
 *   PRE   (code only, tens of ms)
 *         clock + timezone -> resolve time expressions -> let memory settle
 *         ambiguous dates -> recall past turns -> build re-check plan
 *   LOOP  (model) stream the answer, running web searches in parallel
 *   POST  (background) save the answer, queue indexing / claims / digest / topic
 *
 * prepare() is split out from run() so the whole PRE stage can be tested
 * without a model or network.
 */
import { config } from "../config";
import type { Db } from "../db";
import type { ChatMessage, ChatModel } from "../llm/types";
import type { Derivation } from "../memory/derive";
import { knownEntityNames } from "../memory/derive/entities";
import { memoryChip } from "../memory/retrieve/render";
import type { MemoryPack, Retriever } from "../memory/retrieve/retriever";
import type { MemoryStore, MessageRow } from "../memory/store";
import type { SearchService } from "../search";
import {
  type Clock,
  type LlmTimeFallback,
  type ResolvedTime,
  type TimeContext,
  buildTimeContext,
  decide,
  describeNow,
  memoryFilterOf,
  readTime,
  searchWindowOf,
  uiChipsOf,
} from "../time";
import { citedIds } from "./citations";
import type { Emit } from "./events";
import { runLoop } from "./loop";
import { SYSTEM_PROMPT, buildContextBlock } from "./prompt";
import { buildRecheckPlan } from "./recheck";

export interface TurnInput {
  userId: string;
  threadId?: string;
  text: string;
  browserTz?: string;
  locale?: string;
}

export interface AgentDeps {
  db: Db;
  store: MemoryStore;
  retriever: Retriever;
  derivation: Derivation;
  search: SearchService;
  clock: Clock;
  /** Null when the provider's API key is missing; the turn then ends with a clear error. */
  model: ChatModel | null;
  timeFallback?: LlmTimeFallback;
}

export interface PreparedTurn {
  ctx: TimeContext;
  threadId: string;
  userMessage: MessageRow;
  history: MessageRow[];
  resolved: ResolvedTime[];
  pack: MemoryPack;
  contextBlock: string;
  messages: ChatMessage[];
  timings: Record<string, number>;
}

export class Agent {
  constructor(private readonly d: AgentDeps) {}

  /** PRE: everything before the model is called. Pure code: no model, no network. */
  async prepare(input: TurnInput): Promise<PreparedTurn> {
    const { store, retriever, db, clock } = this.d;
    const t0 = performance.now();
    const user = store.user(input.userId);
    const ctx = buildTimeContext(clock, {
      browserTz: input.browserTz,
      declaredTz: user.declaredTz,
      lastSeenTz: user.lastSeenTz,
      locale: input.locale,
    });
    if (ctx.tzSource !== "fallback") store.setLastSeenTz(input.userId, ctx.tz);

    const thread = (input.threadId && store.thread(input.threadId)) || store.createThread(input.userId, ctx.nowMs);
    const history = store.threadMessages(thread.id, config.historyMessages);
    const userMessage = store.appendMessage({
      threadId: thread.id,
      userId: input.userId,
      role: "user",
      content: input.text,
      tsUtc: ctx.nowMs,
      tz: ctx.tz,
      tzSource: ctx.tzSource,
    });
    if (history.length === 0) store.setThreadTitle(thread.id, titleFrom(input.text));

    // The query embedding runs while the time pipeline works.
    const vectorP = retriever.embedQuery(input.text).catch(() => null);

    const t1 = performance.now();
    const readings = await readTime(input.text, ctx, {
      anchors: retriever.anchors(input.userId, thread.id, userMessage.id),
      entityNames: knownEntityNames(db, input.userId),
      llm: this.d.timeFallback,
    });
    const offsets = readings.map((r) => ({ index: r.index, length: r.length }));
    // Ambiguous dates are settled by asking memory which reading has the conversation.
    const resolved = decide(readings, (span) => retriever.countHits(input.userId, span, input.text, userMessage.id, offsets));
    const t2 = performance.now();

    const filter = memoryFilterOf(resolved);
    const queryVector = await vectorP;
    const historyTurnIds = new Set(history.filter((m) => m.role === "user").map((m) => m.id));
    const pack = retriever.retrieve({
      userId: input.userId,
      threadId: thread.id,
      currentTurnId: userMessage.id,
      text: input.text,
      filter,
      filterLabels: resolved.filter((r) => r.reading.target !== "world").flatMap((r) => r.filterSpans.map((s) => s.label)),
      excludeTurnIds: historyTurnIds,
      previousUserText: [...history].reverse().find((m) => m.role === "user")?.content,
      queryVector,
      budgetChars: config.memoryBudgetChars,
    });
    const t3 = performance.now();

    const window = searchWindowOf(resolved, ctx);
    const recheckPlan = buildRecheckPlan(input.text, pack, window, ctx);
    const provider = this.d.search.provider;
    const contextBlock = buildContextBlock({
      ctx,
      resolved,
      window,
      pack,
      recheckPlan,
      searchBackend: provider ? { name: provider.name, dateFilter: provider.supportsDateFilter } : null,
    });

    const messages: ChatMessage[] = [
      ...historyToParams(history),
      { role: "user", content: input.text },
      { role: "system", content: contextBlock },
    ];

    return {
      ctx,
      threadId: thread.id,
      userMessage,
      history,
      resolved,
      pack,
      contextBlock,
      messages,
      timings: {
        setupMs: round(t1 - t0),
        timeMs: round(t2 - t1),
        recallMs: round(t3 - t2),
        preMs: round(performance.now() - t0),
      },
    };
  }

  /** A full turn: PRE, then the model loop, then background memory work. */
  async run(input: TurnInput, emit: Emit, signal: AbortSignal): Promise<void> {
    const started = performance.now();
    const prep = await this.prepare(input);
    const { ctx } = prep;

    emit({ type: "turn", threadId: prep.threadId, turnId: prep.userMessage.id });
    emit({ type: "time", now: describeNow(ctx), tz: ctx.tz, tzSource: ctx.tzSource, frozen: ctx.frozen, chips: uiChipsOf(prep.resolved, ctx) });
    emit({ type: "memory", ...memoryChip(prep.pack) });

    if (!this.d.model) {
      emit({ type: "error", message: `${config.keyName} is not set. Add it to .env and restart.` });
      return;
    }

    let result;
    try {
      result = await runLoop({
        model: this.d.model,
        system: SYSTEM_PROMPT,
        messages: prep.messages,
        search: this.d.search,
        today: ctx.now.toISODate()!,
        emit,
        signal,
        onSearch: (query, params, results) =>
          this.d.store.appendSearch({
            turnId: prep.userMessage.id,
            userId: input.userId,
            provider: this.d.search.provider?.name ?? "none",
            query,
            params,
            results,
            tsUtc: this.d.clock.now(),
          }),
      });
    } catch (err) {
      emit({ type: "error", message: friendlyError(err) });
      return;
    }

    const partial = result.stop === "aborted" || result.stop === "max_tokens" || result.stop === "error";
    const reply = this.d.store.appendMessage({
      threadId: prep.threadId,
      userId: input.userId,
      role: "assistant",
      content: result.text,
      tsUtc: this.d.clock.now(),
      tz: ctx.tz,
      tzSource: ctx.tzSource,
      replyTo: prep.userMessage.id,
      status: partial ? "partial" : "complete",
    });

    const cited = citedIds(result.text);
    emit({
      type: "sources",
      sources: result.sources.filter((s) => cited.has(s.id)).map((s) => ({ id: s.id, title: s.title, url: s.url, publishedAt: s.publishedAt })),
    });

    const timings = {
      ...prep.timings,
      firstTokenMs: result.firstTokenMs != null ? round(result.firstTokenMs + prep.timings.preMs!) : -1,
      totalMs: round(performance.now() - started),
      rounds: result.rounds,
      sourcesSeen: new Set(result.sources.map((s) => s.url)).size,
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cacheReadTokens: result.usage.cacheRead,
    };
    this.d.db
      .prepare("INSERT INTO traces (turn_id, data_json, ts_utc) VALUES (?, ?, ?)")
      .run(prep.userMessage.id, JSON.stringify({ timings, stop: result.stop, resolved: prep.resolved.map((r) => ({ text: r.reading.text, chosen: r.chosen.label, decision: r.decision })), memoryMode: prep.pack.mode }), this.d.clock.now());

    emit({ type: "done", messageId: reply.id, partial, timings });
    if (result.stop === "error") emit({ type: "error", message: friendlyError(result.error) });

    // POST: memory work happens after the user has the answer.
    if (!partial) this.d.derivation.afterTurn(prep.userMessage.id);
  }
}

/** Thread history as API messages. Only text: tool calls from old turns aren't replayed. */
function historyToParams(history: MessageRow[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history) {
    if (!m.content.trim()) continue;
    out.push({ role: m.role, content: m.status === "partial" ? `${m.content}\n\n[answer was cut off]` : m.content });
  }
  // The API wants the conversation to start with the user.
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

function titleFrom(text: string) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

function round(ms: number) {
  return Math.round(ms * 10) / 10;
}

function friendlyError(err: unknown): string {
  const e = err as { status?: number; message?: string };
  // Gemini answers a bad key with 400 "API key not valid" rather than 401.
  if (e?.status === 401 || e?.status === 403 || /api key not valid/i.test(e?.message ?? "")) {
    return `The ${config.provider === "gemini" ? "Gemini" : "Anthropic"} API key was rejected. Check ${config.keyName} in .env.`;
  }
  if (e?.status === 429) return "Rate limited by the model API. Try again in a moment.";
  if (e?.status === 503 || e?.status === 529) {
    return `${config.agentModel} is overloaded right now. Try again in a minute, or set AGENT_MODEL in .env to another model.`;
  }
  if (e?.status && e.status >= 500) return "The model API had a problem. Try again.";
  return `Something went wrong: ${e?.message ?? String(err)}`;
}
