/**
 * The contract for background "worker" model calls (claim extraction,
 * digests, topics, the time fallback).
 *
 * Modules depend on this interface, not on the SDK, so tests can swap in a
 * scripted fake and the derivers never know which model ran.
 */
import type { z } from "zod";

export interface WorkerLlm {
  /** Ask for JSON that matches `schema`. Throws if the model can't produce it. */
  json<S extends z.ZodType>(schema: S, args: { system: string; user: string; maxTokens?: number }): Promise<z.infer<S>>;
}

export class NoLlmError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY is not set");
  }
}
