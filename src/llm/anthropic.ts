/**
 * Claude, through the Anthropic SDK.
 *
 *  - AnthropicChat:   the agent model (Opus 5.5 by default), streamed, low
 *                     effort. The hard parts (dates, memory lookup, date
 *                     filters) are done in code, so the model doesn't need to
 *                     think long to be right.
 *  - AnthropicWorker: structured JSON jobs (Haiku 5.5 by default) that run
 *                     after the answer has been sent.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { ChatMessage, ChatModel, Conversation, RoundResult, ToolSpec, WorkerLlm } from "./types";

type Effort = "low" | "medium" | "high";

export class AnthropicChat implements ChatModel {
  readonly provider = "anthropic" as const;

  constructor(
    private readonly client: Anthropic,
    readonly model: string,
    private readonly effort: Effort,
    private readonly fast: boolean,
  ) {}

  start(system: string, messages: ChatMessage[], tool: ToolSpec): Conversation {
    // A "system" role mid-conversation carries operator authority without
    // touching the cached prefix (see agent/prompt.ts).
    const history: Anthropic.Beta.BetaMessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
    const apiTool: Anthropic.Beta.BetaTool = {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Beta.BetaTool["input_schema"],
      // Stream the tool input as it's generated; the loop validates it with zod before running anything.
      eager_input_streaming: true,
    };

    return {
      round: async ({ allowTools, onText, signal }): Promise<RoundResult> => {
        const stream = this.client.beta.messages.stream(
          {
            model: this.model,
            max_tokens: 16000,
            system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
            tools: [apiTool],
            tool_choice: allowTools ? { type: "auto" } : { type: "none" },
            messages: history,
            output_config: { effort: this.effort },
            // Cache the conversation prefix as well, so later rounds and later turns reuse it.
            cache_control: { type: "ephemeral" },
            // If the model declines a request, the API retries it on a fallback model in the same call.
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            ...(this.fast ? { speed: "fast" as const } : {}),
          },
          { signal },
        );
        stream.on("text", onText);
        const message = await stream.finalMessage();

        const usage = {
          input: message.usage.input_tokens,
          output: message.usage.output_tokens,
          cacheRead: message.usage.cache_read_input_tokens ?? 0,
          cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
        };
        if (message.stop_reason === "refusal") return { calls: [], stop: "refusal", usage };
        // A tool call cut off mid-input isn't safe to run.
        if (message.stop_reason === "max_tokens") return { calls: [], stop: "max_tokens", usage };

        const calls = message.content
          .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input }));
        if (calls.length === 0) return { calls, stop: "end", usage };

        // Echo the assistant turn back unchanged (thinking and fallback blocks included).
        history.push({ role: "assistant", content: message.content });
        return { calls, stop: "tool_use", usage };
      },

      addToolResults: (outputs) => {
        history.push({
          role: "user",
          content: outputs.map((o) => ({
            type: "tool_result" as const,
            tool_use_id: o.call.id,
            content: o.content,
            ...(o.isError ? { is_error: true } : {}),
          })),
        });
      },
    };
  }

  classifyError(err: unknown, signal: AbortSignal) {
    if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return "abort" as const;
    // With streamed tool input, a call whose JSON can't be parsed at all rejects
    // with a non-API error. That's worth one retry; real API errors are not.
    return err instanceof Anthropic.APIError ? ("fatal" as const) : ("retry" as const);
  }
}

export class AnthropicWorker implements WorkerLlm {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
    private readonly effort: Effort = "low",
  ) {}

  async json<S extends z.ZodType>(schema: S, args: { system: string; user: string; maxTokens?: number }): Promise<z.infer<S>> {
    const res = await this.client.messages.parse({
      model: this.model,
      max_tokens: args.maxTokens ?? 4000,
      system: args.system,
      messages: [{ role: "user", content: args.user }],
      output_config: { format: zodOutputFormat(schema), effort: this.effort },
    });
    if (res.stop_reason === "refusal") throw new Error("worker model declined the request");
    if (res.parsed_output == null) throw new Error(`worker model returned no parsable output (stop: ${res.stop_reason})`);
    return res.parsed_output as z.infer<S>;
  }
}
