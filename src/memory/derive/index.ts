/**
 * Memory, derive side: wires the derivers to the job queue.
 *
 * After every turn, four jobs are queued:
 *   index   keyword + vector index for the turn (no LLM, runs first)
 *   claims  the claim ledger
 *   topic   file the turn under a topic, update open items
 *   digest  update that day's digest
 *
 * On boot, catchUp() queues anything missing, so a crash, a missing API key or
 * a deriver version bump heals itself.
 */
import type { Db } from "../../db";
import type { Embedder } from "../../embed";
import { JobQueue } from "../../jobs/queue";
import type { WorkerLlm } from "../../llm/types";
import type { MemoryStore } from "../store";
import { CLAIMS_VERSION, deriveClaims } from "./claims";
import { DIGEST_VERSION, deriveDigest } from "./digest";
import { Indexer } from "./indexer";
import { TOPIC_VERSION, deriveTopic } from "./topics";

export interface Derivation {
  queue: JobQueue;
  indexer: Indexer;
  /** Queue the derivers for a finished turn (identified by its user message id). */
  afterTurn(turnId: number): void;
  /** Queue everything the log has that derived memory doesn't. */
  catchUp(): void;
}

export function createDerivation(opts: { db: Db; store: MemoryStore; worker: WorkerLlm; embedder: Embedder; llmAvailable: boolean }): Derivation {
  const { db, store, worker, embedder } = opts;
  const indexer = new Indexer(db, store, embedder);

  // The index job is keyed by embedding model, so switching models re-embeds everything.
  const indexOwner = (turnId: number) => `${turnId}@${embedder.model}`;
  const digestOwner = (userId: string, day: string, upToMsg: number) => `${userId}|${day}|${upToMsg}`;

  const queue = new JobQueue(
    db,
    [
      { name: "index", version: 1, needsLlm: false, run: (owner) => indexer.indexTurn(Number(owner.split("@")[0])) },
      { name: "claims", version: CLAIMS_VERSION, needsLlm: true, run: (owner) => deriveClaims(db, store, worker, Number(owner)) },
      { name: "topic", version: TOPIC_VERSION, needsLlm: true, run: (owner) => deriveTopic(db, store, worker, indexer, Number(owner)) },
      {
        name: "digest",
        version: DIGEST_VERSION,
        needsLlm: true,
        run: (owner) => {
          const [userId, day] = owner.split("|");
          return deriveDigest(db, store, worker, indexer, userId!, day!);
        },
      },
    ],
    opts.llmAvailable,
  );

  function afterTurn(turnId: number) {
    const q = store.message(turnId);
    if (!q) return;
    const reply = store.replyTo(turnId);
    queue.enqueue("index", indexOwner(turnId));
    queue.enqueue("claims", turnId);
    queue.enqueue("topic", turnId);
    queue.enqueue("digest", digestOwner(q.user_id, q.local_day, reply?.id ?? turnId));
    queue.kick();
  }

  function catchUp() {
    const turns = db
      .prepare(
        `SELECT q.id AS turn_id, q.user_id, q.local_day, a.id AS reply_id
           FROM messages q JOIN messages a ON a.reply_to = q.id
          WHERE q.role = 'user' AND q.status = 'complete' AND a.status = 'complete'`,
      )
      .all() as Array<{ turn_id: number; user_id: string; local_day: string; reply_id: number }>;
    const lastPerDay = new Map<string, { userId: string; day: string; upTo: number }>();
    for (const t of turns) {
      queue.enqueue("index", indexOwner(t.turn_id));
      queue.enqueue("claims", t.turn_id);
      queue.enqueue("topic", t.turn_id);
      const key = `${t.user_id}|${t.local_day}`;
      const cur = lastPerDay.get(key);
      if (!cur || cur.upTo < t.reply_id) lastPerDay.set(key, { userId: t.user_id, day: t.local_day, upTo: t.reply_id });
    }
    for (const d of lastPerDay.values()) queue.enqueue("digest", digestOwner(d.userId, d.day, d.upTo));
    queue.kick();
  }

  return { queue, indexer, afterTurn, catchUp };
}
