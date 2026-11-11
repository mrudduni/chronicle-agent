/**
 * Runtime configuration, read once at startup.
 *
 * Everything tunable lives here so the rest of the code never touches
 * process.env directly. Values are validated with zod so a typo in .env fails
 * loudly at boot instead of halfway through a conversation.
 */
import { existsSync } from "node:fs";
import { z } from "zod";

// Node 22+ can read .env files natively, so there's no need for dotenv.
if (existsSync(".env")) process.loadEnvFile(".env");

const Env = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  TAVILY_API_KEY: z.string().optional(),
  LLM_PROVIDER: z.enum(["anthropic", "gemini"]).optional(),
  AGENT_MODEL: z.string().optional(),
  WORKER_MODEL: z.string().optional(),
  AGENT_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  FAST_MODE: z.enum(["true", "false"]).default("false"),
  NOW: z.string().optional(),
  DB_PATH: z.string().default("data/chronicle.db"),
  // Not PORT: dev tools commonly set PORT for the UI server, and the API must not grab it.
  API_PORT: z.coerce.number().default(8787),
  EMBEDDINGS: z.enum(["on", "off"]).default("on"),
});

const env = Env.parse(process.env);
const blank = (v?: string) => (v && v.trim() ? v.trim() : undefined);

const anthropicKey = blank(env.ANTHROPIC_API_KEY);
const geminiKey = blank(env.GEMINI_API_KEY);
// An explicit choice wins; otherwise use whichever key is present, Claude first.
const provider = env.LLM_PROVIDER ?? (anthropicKey ? "anthropic" : geminiKey ? "gemini" : "anthropic");

// Default models per provider. The Gemini pair both have a free tier.
const MODELS = {
  anthropic: { agent: "claude-opus-5-5", worker: "claude-haiku-5-5", keyName: "ANTHROPIC_API_KEY" },
  gemini: { agent: "gemini-3.6-flash", worker: "gemini-3.5-flash-lite", keyName: "GEMINI_API_KEY" },
} as const;

export const config = {
  provider,
  /** The env variable the chosen provider needs, for messages to the user. */
  keyName: MODELS[provider].keyName,
  anthropicKey,
  geminiKey,
  tavilyKey: blank(env.TAVILY_API_KEY),
  agentModel: blank(env.AGENT_MODEL) ?? MODELS[provider].agent,
  workerModel: blank(env.WORKER_MODEL) ?? MODELS[provider].worker,
  agentEffort: env.AGENT_EFFORT,
  fastMode: env.FAST_MODE === "true",
  frozenNow: blank(env.NOW),
  dbPath: env.DB_PATH,
  port: env.API_PORT,
  embeddings: env.EMBEDDINGS === "on",

  // Single local user by default. minimi-style: the memory belongs to the
  // person at this machine, so clearing browser storage doesn't wipe it.
  defaultUserId: "local",

  /** How many prior messages of the current thread go into the prompt verbatim. */
  historyMessages: 12,
  /** Upper bound on model <-> tool round trips in a single turn. */
  maxToolRounds: 4,
  /** Rough character budget for the recalled-memory block (~4 chars/token). */
  memoryBudgetChars: 18_000,
  /** How long an identical web search is served from cache. */
  searchCacheTtlMs: 10 * 60 * 1000,
} as const;

export type Config = typeof config;
