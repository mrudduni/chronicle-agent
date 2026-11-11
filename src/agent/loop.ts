/**
 * The model <-> tool loop for one turn.
 *
 * Hand-written rather than using an SDK's tool runner, because this loop
 * needs to: stream tokens to the UI as they arrive, emit an event per search,
 * run all searches from one step in parallel, write each search to the
 * evidence log, and stop cleanly on a budget. It's short enough to read in
 * one sitting, which matters more here than saving a few lines.
 *
 * It doesn't know which provider it's talking to. The ChatModel (src/llm)
 * keeps the provider's own message format; this file only sees text deltas,
 * tool calls and a stop reason.
 *
 * Per round: stream a response -> if it asked for searches, run them all at
 * once -> send all results back in one message -> repeat. The last allowed
 * round runs with tools switched off so the model has to answer with what it
 * has instead of being cut off.
 */
import { z } from "zod";
import { config } from "../config";
import type { ChatMessage, ChatModel, RoundResult, ToolCall, ToolOutput } from "../llm/types";
import { type SearchResult, type SearchService, formatResultsForModel } from "../search";
import { WEB_SEARCH_TOOL } from "./prompt";
import { type Emit, toSearchItems } from "./events";

const SearchInput = z.object({
  query: z.string().min(1),
  mode: z.enum(["page", "news"]).default("page"),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  domains: z.array(z.string()).max(10).optional(),
});

export interface LoopInput {
  model: ChatModel;
  system: string;
  messages: ChatMessage[];
  search: SearchService;
  today: string;
  emit: Emit;
  signal: AbortSignal;
  /** Called for every search so it can be written to the evidence log. */
  onSearch: (query: string, params: unknown, results: SearchResult[]) => void;
}

export interface LoopResult {
  text: string;
  sources: SearchResult[];
  stop: "done" | "refusal" | "max_tokens" | "aborted" | "error";
  /** Set when stop is "error": the API failed after part of the answer had already streamed. */
  error?: unknown;
  rounds: number;
  firstTokenMs: number | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export async function runLoop(input: LoopInput): Promise<LoopResult> {
  const { model, emit, signal } = input;
  const convo = model.start(input.system, input.messages, WEB_SEARCH_TOOL);
  const ids = input.search.newTurn();
  const sources: SearchResult[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const started = performance.now();
  let firstTokenMs: number | null = null;
  let text = "";
  let retried = false;

  for (let round = 0; round <= config.maxToolRounds; round++) {
    const lastRound = round === config.maxToolRounds;
    // Separate any "let me check" preamble from what follows.
    if (text && !/\n\s*$/.test(text)) {
      text += "\n\n";
      emit({ type: "token", text: "\n\n" });
    }

    let res: RoundResult;
    try {
      res = await convo.round({
        allowTools: !lastRound,
        signal,
        onText: (delta) => {
          if (firstTokenMs === null) firstTokenMs = performance.now() - started;
          text += delta;
          emit({ type: "token", text: delta });
        },
      });
    } catch (err) {
      const kind = model.classifyError(err, signal);
      if (kind === "abort") return { text, sources, stop: "aborted", rounds: round + 1, firstTokenMs, usage };
      if (kind === "retry" && !retried) {
        retried = true;
        round--;
        continue;
      }
      // Nothing shown yet: let the caller report it. Otherwise keep what the
      // user has already read (a busy model can fail on round 3 of 4).
      if (!text.trim()) throw err;
      return { text, sources, stop: "error", error: err, rounds: round + 1, firstTokenMs, usage };
    }
    retried = false;

    usage.input += res.usage.input;
    usage.output += res.usage.output;
    usage.cacheRead += res.usage.cacheRead;
    usage.cacheWrite += res.usage.cacheWrite;

    if (res.stop === "refusal") {
      const note = "\n\nI can't help with that one.";
      text += note;
      emit({ type: "token", text: note });
      return { text, sources, stop: "refusal", rounds: round + 1, firstTokenMs, usage };
    }
    if (res.stop !== "tool_use") {
      return { text, sources, stop: res.stop === "max_tokens" ? "max_tokens" : "done", rounds: round + 1, firstTokenMs, usage };
    }

    const outputs = await Promise.all(res.calls.map((call) => runSearch(call, input, ids, sources)));
    // All results in one message: splitting them teaches the model to stop calling tools in parallel.
    convo.addToolResults(outputs);
  }

  return { text, sources, stop: "done", rounds: config.maxToolRounds + 1, firstTokenMs, usage };
}

async function runSearch(
  call: ToolCall,
  input: LoopInput,
  ids: { nextId(): string },
  sources: SearchResult[],
): Promise<ToolOutput> {
  const parsed = SearchInput.safeParse(call.input);
  if (call.name !== WEB_SEARCH_TOOL.name || !parsed.success) {
    return { call, isError: true, content: `Invalid search input: ${parsed.success ? `unknown tool ${call.name}` : parsed.error.message}` };
  }
  const req = parsed.data;
  // Dates only make sense for news; a dated page search would drop undated pricing pages.
  const effective = req.mode === "page" ? { ...req, since: undefined, until: undefined } : req;
  input.emit({ type: "search", callId: call.id, query: req.query, mode: req.mode, since: effective.since, state: "start" });
  try {
    const { results, fromCache, dateFilterApplied } = await input.search.search(effective, ids, input.signal);
    sources.push(...results);
    input.onSearch(req.query, effective, results);
    input.emit({ type: "search", callId: call.id, query: req.query, mode: req.mode, since: effective.since, state: "done", results: results.length, items: toSearchItems(results), fromCache });
    return { call, isError: false, content: formatResultsForModel(effective, results, input.today, { dateFilterApplied, fromCache }) };
  } catch (err) {
    const message = (err as Error).message;
    input.emit({ type: "search", callId: call.id, query: req.query, mode: req.mode, state: "error", error: message });
    return { call, isError: true, content: `Search failed: ${message}` };
  }
}
