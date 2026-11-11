/**
 * The model <-> tool loop for one turn.
 *
 * Hand-written rather than using the SDK's tool runner, because this loop
 * needs to: stream tokens to the UI as they arrive, emit an event per search,
 * run all searches from one step in parallel, write each search to the
 * evidence log, and stop cleanly on a budget. It's short enough to read in
 * one sitting, which matters more here than saving a few lines.
 *
 * Per round: stream a response -> if it asked for searches, run them all at
 * once -> send all results back in one message -> repeat. The last allowed
 * round runs with tool_choice "none" so the model has to answer with what it
 * has instead of being cut off.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config";
import { type SearchResult, type SearchService, formatResultsForModel } from "../search";
import { WEB_SEARCH_TOOL } from "./prompt";
import type { Emit } from "./events";

const SearchInput = z.object({
  query: z.string().min(1),
  mode: z.enum(["page", "news"]).default("page"),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  domains: z.array(z.string()).max(10).optional(),
});

export interface LoopInput {
  client: Anthropic;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
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
  stop: "done" | "refusal" | "max_tokens" | "aborted";
  rounds: number;
  firstTokenMs: number | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export async function runLoop(input: LoopInput): Promise<LoopResult> {
  const { client, emit, signal } = input;
  const messages = [...input.messages];
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

    const stream = client.beta.messages.stream(
      {
        model: config.agentModel,
        max_tokens: 16000,
        system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
        tools: [WEB_SEARCH_TOOL],
        tool_choice: lastRound ? { type: "none" } : { type: "auto" },
        messages,
        output_config: { effort: config.agentEffort },
        // Cache the conversation prefix as well, so later rounds and later turns reuse it.
        cache_control: { type: "ephemeral" },
        // If the model declines a request, the API retries it on a fallback model in the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        ...(config.fastMode ? { speed: "fast" as const } : {}),
      },
      { signal },
    );
    stream.on("text", (delta) => {
      if (firstTokenMs === null) firstTokenMs = performance.now() - started;
      text += delta;
      emit({ type: "token", text: delta });
    });

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return { text, sources, stop: "aborted", rounds: round + 1, firstTokenMs, usage };
      // With streamed tool input, a call whose JSON can't be parsed at all rejects here.
      // That's worth one retry of the round; real API errors are not.
      if (!(err instanceof Anthropic.APIError) && !retried) {
        retried = true;
        round--;
        continue;
      }
      throw err;
    }
    retried = false;

    usage.input += message.usage.input_tokens;
    usage.output += message.usage.output_tokens;
    usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;

    if (message.stop_reason === "refusal") {
      const note = "\n\nI can't help with that one.";
      text += note;
      emit({ type: "token", text: note });
      return { text, sources, stop: "refusal", rounds: round + 1, firstTokenMs, usage };
    }

    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      return { text, sources, stop: message.stop_reason === "max_tokens" ? "max_tokens" : "done", rounds: round + 1, firstTokenMs, usage };
    }
    if (message.stop_reason === "max_tokens") {
      // A tool call cut off mid-input isn't safe to run.
      return { text, sources, stop: "max_tokens", rounds: round + 1, firstTokenMs, usage };
    }

    // Echo the assistant turn back unchanged (thinking and fallback blocks included).
    messages.push({ role: "assistant", content: message.content });

    const results = await Promise.all(
      toolUses.map((use) => runSearch(use, input, ids, sources)),
    );
    // All results in one user message: splitting them teaches the model to stop calling tools in parallel.
    messages.push({ role: "user", content: results });
  }

  return { text, sources, stop: "done", rounds: config.maxToolRounds + 1, firstTokenMs, usage };
}

async function runSearch(
  use: Anthropic.Beta.BetaToolUseBlock,
  input: LoopInput,
  ids: { nextId(): string },
  sources: SearchResult[],
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const parsed = SearchInput.safeParse(use.input);
  if (use.name !== "web_search" || !parsed.success) {
    return { type: "tool_result", tool_use_id: use.id, is_error: true, content: `Invalid search input: ${parsed.success ? `unknown tool ${use.name}` : parsed.error.message}` };
  }
  const req = parsed.data;
  // Dates only make sense for news; a dated page search would drop undated pricing pages.
  const effective = req.mode === "page" ? { ...req, since: undefined, until: undefined } : req;
  input.emit({ type: "search", callId: use.id, query: req.query, mode: req.mode, since: effective.since, state: "start" });
  try {
    const { results, fromCache, dateFilterApplied } = await input.search.search(effective, ids, input.signal);
    sources.push(...results);
    input.onSearch(req.query, effective, results);
    input.emit({ type: "search", callId: use.id, query: req.query, mode: req.mode, since: effective.since, state: "done", results: results.length, fromCache });
    return { type: "tool_result", tool_use_id: use.id, content: formatResultsForModel(effective, results, input.today, { dateFilterApplied, fromCache }) };
  } catch (err) {
    const message = (err as Error).message;
    input.emit({ type: "search", callId: use.id, query: req.query, mode: req.mode, state: "error", error: message });
    return { type: "tool_result", tool_use_id: use.id, is_error: true, content: `Search failed: ${message}` };
  }
}
