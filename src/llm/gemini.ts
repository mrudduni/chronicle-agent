/**
 * Gemini, through Google's @google/genai SDK.
 *
 * Same two roles as the Claude side, behind the same interfaces:
 *  - GeminiChat:   the agent model (Gemini 3.6 Flash by default), streamed,
 *                  with web_search as a function declaration.
 *  - GeminiWorker: JSON jobs (Gemini 3.5 Flash-Lite by default) using
 *                  response_json_schema, then checked again with zod.
 *
 * Both default models have a free tier in the Gemini API. The default is the
 * stable 3.6 Flash rather than the newer 3.8: during testing 3.8 kept
 * answering 503 "high demand", and a model that's often busy is a bad default.
 *
 * Gemini 3 attaches "thought signatures" to parts of its responses and
 * expects them back unchanged on the next request, or function calling
 * degrades. The simplest way to get that right is to keep every part of the
 * model's turn exactly as streamed, and send the whole list back.
 */
import { ApiError, type Content, FunctionCallingConfigMode, GoogleGenAI, type Part, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import type { ChatMessage, ChatModel, Conversation, RoundResult, ToolSpec, Usage, WorkerLlm } from "./types";

type Effort = "low" | "medium" | "high";

const THINKING: Record<Effort, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

// Finish reasons that mean the response was withheld, not finished.
const BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"]);

/** Thrown when Gemini produced a function call it couldn't format; the loop retries once. */
class MalformedResponseError extends Error {}

export function geminiClient(apiKey: string) {
  // The SDK's default is 5 attempts with up to 60 s between them, so a busy
  // model (503) looks like a hang. A few quick retries (about 7 s at most),
  // then let the user see the error.
  // v1beta, not the SDK's default v1: preview models (and some newer
  // features) are only served there, so AGENT_MODEL can name any of them.
  return new GoogleGenAI({ apiKey, apiVersion: "v1beta", httpOptions: { retryOptions: { attempts: 4, initialDelay: 1, maxDelay: 4 } } });
}

export class GeminiChat implements ChatModel {
  readonly provider = "gemini" as const;

  constructor(
    private readonly ai: GoogleGenAI,
    readonly model: string,
    private readonly effort: Effort,
  ) {}

  start(system: string, messages: ChatMessage[], tool: ToolSpec): Conversation {
    const contents = toContents(messages);
    const declaration = { name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters };
    // Gemini API function calls don't always carry an id, so the loop gets
    // one from here, and the original (if any) is sent back with the result.
    const nativeIds = new Map<string, string | undefined>();
    let seq = 0;

    return {
      round: async ({ allowTools, onText, signal }): Promise<RoundResult> => {
        const stream = await this.ai.models.generateContentStream({
          model: this.model,
          contents,
          config: {
            systemInstruction: system,
            maxOutputTokens: 16000,
            tools: [{ functionDeclarations: [declaration] }],
            toolConfig: { functionCallingConfig: { mode: allowTools ? FunctionCallingConfigMode.AUTO : FunctionCallingConfigMode.NONE } },
            thinkingConfig: { thinkingLevel: THINKING[this.effort] },
            abortSignal: signal,
          },
        });

        const parts: Part[] = [];
        let finish = "";
        let blocked = false;
        let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        for await (const chunk of stream) {
          if (chunk.promptFeedback?.blockReason) blocked = true;
          const candidate = chunk.candidates?.[0];
          for (const part of candidate?.content?.parts ?? []) {
            parts.push(part);
            if (part.text && !part.thought) onText(part.text);
          }
          if (candidate?.finishReason) finish = String(candidate.finishReason);
          const u = chunk.usageMetadata;
          if (u) {
            const cached = u.cachedContentTokenCount ?? 0;
            usage = {
              input: (u.promptTokenCount ?? 0) - cached,
              output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
              cacheRead: cached,
              cacheWrite: 0,
            };
          }
        }

        if (blocked || BLOCKED.has(finish)) return { calls: [], stop: "refusal", usage };
        if (finish === "MALFORMED_FUNCTION_CALL") throw new MalformedResponseError("Gemini returned a malformed function call");
        if (finish === "MAX_TOKENS") return { calls: [], stop: "max_tokens", usage };

        const calls = parts
          .filter((p) => p.functionCall)
          .map((p) => {
            const id = `call_${++seq}`;
            nativeIds.set(id, p.functionCall!.id);
            return { id, name: p.functionCall!.name ?? "", input: p.functionCall!.args ?? {} };
          });
        if (calls.length === 0) return { calls, stop: "end", usage };

        // The model's turn goes back exactly as received, thought signatures included.
        contents.push({ role: "model", parts });
        return { calls, stop: "tool_use", usage };
      },

      addToolResults: (outputs) => {
        contents.push({
          role: "user",
          parts: outputs.map((o) => {
            const id = nativeIds.get(o.call.id);
            return {
              functionResponse: {
                ...(id ? { id } : {}),
                name: o.call.name,
                response: o.isError ? { error: o.content } : { output: o.content },
              },
            };
          }),
        });
      },
    };
  }

  classifyError(err: unknown, signal: AbortSignal) {
    if (signal.aborted || (err as Error)?.name === "AbortError") return "abort" as const;
    return err instanceof ApiError ? ("fatal" as const) : ("retry" as const);
  }
}

export class GeminiWorker implements WorkerLlm {
  constructor(
    private readonly ai: GoogleGenAI,
    private readonly model: string,
  ) {}

  async json<S extends z.ZodType>(schema: S, args: { system: string; user: string; maxTokens?: number }): Promise<z.infer<S>> {
    // Gemini reads standard JSON Schema; the "$schema" marker zod adds isn't one of the supported keys.
    const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: args.user,
      config: {
        systemInstruction: args.system,
        // Thinking tokens count against this limit on Gemini, so leave headroom.
        maxOutputTokens: (args.maxTokens ?? 4000) * 2,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchema,
      },
    });
    const text = res.text;
    if (!text) {
      const why = res.promptFeedback?.blockReason ?? res.candidates?.[0]?.finishReason ?? "empty response";
      throw new Error(`worker model returned no output (${why})`);
    }
    // The API constrains the shape; zod still checks it, the same as on the Claude side.
    return schema.parse(JSON.parse(text)) as z.infer<S>;
  }
}

/**
 * Neutral messages to Gemini contents. Gemini has no mid-conversation system
 * role, so the context block becomes a second part of the user's turn, and
 * consecutive messages from the same side are merged.
 */
function toContents(messages: ChatMessage[]): Content[] {
  const out: Content[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const last = out.at(-1);
    if (last?.role === role) last.parts!.push({ text: m.content });
    else out.push({ role, parts: [{ text: m.content }] });
  }
  return out;
}
