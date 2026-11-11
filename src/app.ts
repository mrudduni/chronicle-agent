/**
 * Composition root: builds every component and wires them together.
 *
 * The only place that knows about concrete implementations. The server, the
 * eval runner and tests all start here, with different options (a frozen
 * clock, an in-memory database, a fake embedder).
 */
import { Agent } from "./agent/orchestrator";
import { config } from "./config";
import { openDb } from "./db";
import { type Embedder, LocalEmbedder, noEmbedder } from "./embed";
import { anthropic, createWorker } from "./llm/client";
import { llmTimeFallback } from "./llm/time-fallback";
import type { WorkerLlm } from "./llm/types";
import { createDerivation } from "./memory/derive";
import { Retriever } from "./memory/retrieve/retriever";
import { MemoryStore } from "./memory/store";
import { SearchService, createSearchProvider } from "./search";
import { type Clock, FixedClock, systemClock } from "./time";

export interface AppOptions {
  dbPath?: string;
  clock?: Clock;
  embedder?: Embedder;
  worker?: WorkerLlm;
}

export function createApp(opts: AppOptions = {}) {
  const db = openDb(opts.dbPath ?? config.dbPath);
  const clock = opts.clock ?? (config.frozenNow ? new FixedClock(config.frozenNow) : systemClock);
  const embedder = opts.embedder ?? (config.embeddings ? new LocalEmbedder() : noEmbedder);
  const worker = opts.worker ?? createWorker();
  const llmAvailable = !!anthropic || !!opts.worker;

  const store = new MemoryStore(db);
  const retriever = new Retriever(db, store, embedder);
  const derivation = createDerivation({ db, store, worker, embedder, llmAvailable });
  const search = new SearchService(createSearchProvider(), config.searchCacheTtlMs, () => clock.now());

  const agent = new Agent({
    db,
    store,
    retriever,
    derivation,
    search,
    clock,
    client: anthropic,
    timeFallback: llmAvailable ? llmTimeFallback(worker) : undefined,
  });

  return { db, clock, embedder, store, retriever, derivation, search, agent };
}

export type App = ReturnType<typeof createApp>;
