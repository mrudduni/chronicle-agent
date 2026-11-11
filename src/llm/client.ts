/**
 * Model access. The only file that constructs an Anthropic client.
 *
 * Two roles:
 *  - agent model (Opus 5.5): the conversation itself, streamed, low effort by
 *    default. The hard parts (dates, memory lookup, date filters) are done in
 *    code, so the model doesn't need to think long to be right.
 *  - worker model (Haiku 5.5): structured JSON jobs that run after the answer
 *    has been sent (claims, digests, topics), plus the rare time fallback.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { config } from "../config";
import { NoLlmError, type WorkerLlm } from "./types";

export const anthropic: Anthropic | null = config.anthropicKey
  ? new Anthropic({ apiKey: config.anthropicKey, maxRetries: 2 })
  : null;

export function requireClient(): Anthropic {
  if (!anthropic) throw new NoLlmError();
  return anthropic;
}

export class AnthropicWorker implements WorkerLlm {
  constructor(private readonly client: Anthropic, private readonly model = config.workerModel) {}

  async json<S extends z.ZodType>(schema: S, args: { system: string; user: string; maxTokens?: number }): Promise<z.infer<S>> {
    const res = await this.client.messages.parse({
      model: this.model,
      max_tokens: args.maxTokens ?? 4000,
      system: args.system,
      messages: [{ role: "user", content: args.user }],
      output_config: { format: zodOutputFormat(schema), effort: "low" },
    });
    if (res.stop_reason === "refusal") throw new Error("worker model declined the request");
    if (res.parsed_output == null) throw new Error(`worker model returned no parsable output (stop: ${res.stop_reason})`);
    return res.parsed_output as z.infer<S>;
  }
}

/** Worker that always fails cleanly, used when there's no API key. */
export const unavailableWorker: WorkerLlm = {
  json: async () => {
    throw new NoLlmError();
  },
};

export function createWorker(): WorkerLlm {
  return anthropic ? new AnthropicWorker(anthropic) : unavailableWorker;
}
