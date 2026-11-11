/**
 * The contracts between the app and whichever model provider is configured.
 *
 * Two kinds of model call:
 *  - ChatModel:  the conversation itself, streamed, with the web_search tool.
 *  - WorkerLlm:  background JSON jobs (claims, digests, topics, time fallback).
 *
 * Everything outside src/llm depends on these interfaces, not on an SDK. That
 * is what lets the same agent run on Claude or Gemini, and lets tests swap in
 * a scripted fake so the derivers never know which model ran.
 */
import type { z } from "zod";

export type Provider = "anthropic" | "gemini";

export interface WorkerLlm {
  /** Ask for JSON that matches `schema`. Throws if the model can't produce it. */
  json<S extends z.ZodType>(schema: S, args: { system: string; user: string; maxTokens?: number }): Promise<z.infer<S>>;
}

/**
 * A message in provider-neutral form. "system" is the per-request context
 * block: Claude takes it as a mid-conversation system message, Gemini gets it
 * as an extra part of the user's turn.
 */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** A function tool described with plain JSON Schema; each provider wraps it in its own format. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolOutput {
  call: ToolCall;
  content: string;
  isError: boolean;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RoundResult {
  calls: ToolCall[];
  stop: "end" | "tool_use" | "max_tokens" | "refusal";
  usage: Usage;
}

/**
 * One conversation with the model. It holds the provider's own message
 * history, so details like Claude's thinking blocks or Gemini's thought
 * signatures are echoed back exactly as received, without the loop knowing
 * they exist.
 */
export interface Conversation {
  /** Stream one model response. Text goes to onText as it arrives. */
  round(opts: { allowTools: boolean; onText: (delta: string) => void; signal: AbortSignal }): Promise<RoundResult>;
  /** Send the results of the tool calls from the last round, all in one message. */
  addToolResults(outputs: ToolOutput[]): void;
}

export interface ChatModel {
  readonly provider: Provider;
  readonly model: string;
  start(system: string, messages: ChatMessage[], tool: ToolSpec): Conversation;
  /**
   * What the loop should do with an error from round():
   * "abort" (the user stopped it), "retry" (a malformed response, worth one
   * more try) or "fatal" (a real API error: bad key, rate limit, outage).
   */
  classifyError(err: unknown, signal: AbortSignal): "abort" | "retry" | "fatal";
}

export class NoLlmError extends Error {
  constructor() {
    super("No model API key is set (ANTHROPIC_API_KEY or GEMINI_API_KEY)");
  }
}
