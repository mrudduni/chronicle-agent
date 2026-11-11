/**
 * Picks the model provider. The only file that constructs SDK clients.
 *
 * LLM_PROVIDER in .env chooses explicitly; otherwise whichever key is set
 * wins, Claude first. The rest of the app only sees ChatModel and WorkerLlm.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { AnthropicChat, AnthropicWorker } from "./anthropic";
import { GeminiChat, GeminiWorker, geminiClient } from "./gemini";
import { type ChatModel, NoLlmError, type WorkerLlm } from "./types";

/** Also used by the fallback search backend, which runs on Claude whatever the chat provider is. */
export const anthropic: Anthropic | null = config.anthropicKey
  ? new Anthropic({ apiKey: config.anthropicKey, maxRetries: 2 })
  : null;

const gemini = config.geminiKey ? geminiClient(config.geminiKey) : null;

/** The chat model for the configured provider, or null when its key is missing. */
export const chatModel: ChatModel | null =
  config.provider === "anthropic"
    ? anthropic && new AnthropicChat(anthropic, config.agentModel, config.agentEffort, config.fastMode)
    : gemini && new GeminiChat(gemini, config.agentModel, config.agentEffort);

/** Worker that always fails cleanly, used when there's no API key. */
export const unavailableWorker: WorkerLlm = {
  json: async () => {
    throw new NoLlmError();
  },
};

/**
 * A JSON worker on the configured provider. The eval grader passes the agent
 * model and a higher effort; everything else uses the small worker model.
 */
export function createWorker(model = config.workerModel, effort: "low" | "medium" | "high" = "low"): WorkerLlm {
  if (config.provider === "anthropic") return anthropic ? new AnthropicWorker(anthropic, model, effort) : unavailableWorker;
  return gemini ? new GeminiWorker(gemini, model) : unavailableWorker;
}
