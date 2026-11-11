/**
 * The LLM side of the time module's fallback resolver. Only called for
 * references the rules deliberately skip ("since Diwali", "before my trip").
 * Output goes back through validateGuesses() in src/time before it's trusted.
 */
import { z } from "zod";
import type { LlmTimeFallback, TimeContext } from "../time";
import type { WorkerLlm } from "./types";

const Guesses = z.object({
  expressions: z.array(
    z.object({
      text: z.string().describe("the time expression, copied exactly from the message"),
      from: z.string().describe("first day, YYYY-MM-DD"),
      to: z.string().describe("last day, YYYY-MM-DD"),
      confidence: z.number().describe("0 to 1"),
      note: z.string().describe("one short phrase on how you resolved it"),
    }),
  ),
});

export function llmTimeFallback(worker: WorkerLlm): LlmTimeFallback {
  return {
    async guess(message: string, ctx: TimeContext) {
      const out = await worker.json(Guesses, {
        maxTokens: 800,
        system:
          "You convert time references in a chat message into calendar date ranges. " +
          "Only include expressions that refer to a time. Copy each one exactly as written. " +
          "If a reference depends on facts you don't know (the user's personal trip dates), leave it out. " +
          "For past-tense questions, prefer the most recent occurrence.",
        user: `Today is ${ctx.now.toFormat("cccc d LLLL yyyy")} in ${ctx.tz}.\n\nMessage:\n${message}`,
      });
      return out.expressions;
    },
  };
}
