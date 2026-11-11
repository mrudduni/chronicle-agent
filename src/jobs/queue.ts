/**
 * Durable background job queue, stored in SQLite.
 *
 * Everything slow happens here, after the user already has their answer:
 * indexing, claim extraction, digests, topics.
 *
 * Crash safety (M1): a job is a row, not a promise in memory. If the server
 * dies mid-job, the row is still `pending` and runs on the next boot.
 * UNIQUE(kind, owner_id, version) makes enqueueing idempotent, so boot
 * catch-up can enqueue everything again without creating duplicates, and a
 * deriver version bump automatically schedules a rebuild (M15).
 *
 * One worker, jobs one at a time: SQLite has a single writer, and nothing
 * here is latency-sensitive.
 */
import type { Db } from "../db";
import { NoLlmError } from "../llm/types";

export interface JobKind {
  name: string;
  version: number;
  /** Jobs that need the worker model wait (rather than fail) while there's no API key. */
  needsLlm: boolean;
  run(ownerId: string): Promise<void>;
}

const MAX_ATTEMPTS = 3;

export class JobQueue {
  private kinds = new Map<string, JobKind>();
  private running: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    kinds: JobKind[],
    private readonly llmAvailable: boolean,
  ) {
    for (const k of kinds) this.kinds.set(k.name, k);
  }

  enqueue(kind: string, ownerId: string | number) {
    const k = this.kinds.get(kind);
    if (!k) throw new Error(`unknown job kind: ${kind}`);
    this.db
      .prepare("INSERT OR IGNORE INTO jobs (kind, owner_id, version, created_at) VALUES (?, ?, ?, ?)")
      .run(kind, String(ownerId), k.version, Date.now());
  }

  /** Start processing if not already running. Returns immediately. */
  kick() {
    if (!this.running) {
      this.running = this.loop().finally(() => {
        this.running = null;
      });
    }
  }

  /** Process until nothing runnable is left. Used by tests and evals. */
  async drain() {
    this.kick();
    while (this.running) await this.running;
  }

  pendingCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'").get() as { n: number };
    return row.n;
  }

  private nextJob() {
    const kinds = [...this.kinds.values()].filter((k) => this.llmAvailable || !k.needsLlm).map((k) => k.name);
    if (kinds.length === 0) return undefined;
    // Cheap jobs first (indexing has no LLM call), then oldest first.
    return this.db
      .prepare(
        `SELECT id, kind, owner_id, version, attempts FROM jobs
          WHERE status = 'pending' AND kind IN (${kinds.map(() => "?").join(",")})
          ORDER BY CASE kind WHEN 'index' THEN 0 ELSE 1 END, id
          LIMIT 1`,
      )
      .get(...kinds) as { id: number; kind: string; owner_id: string; version: number; attempts: number } | undefined;
  }

  private async loop() {
    for (let job = this.nextJob(); job; job = this.nextJob()) {
      const kind = this.kinds.get(job.kind)!;
      if (job.version !== kind.version) {
        // An older version's job; the catch-up pass has enqueued the current one.
        this.db.prepare("UPDATE jobs SET status = 'done', last_error = 'superseded' WHERE id = ?").run(job.id);
        continue;
      }
      try {
        await kind.run(job.owner_id);
        this.db.prepare("UPDATE jobs SET status = 'done', attempts = attempts + 1 WHERE id = ?").run(job.id);
      } catch (err) {
        if (err instanceof NoLlmError) {
          // Not this job's fault. Leave it pending for when a key is configured.
          return;
        }
        const attempts = job.attempts + 1;
        const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
        this.db.prepare("UPDATE jobs SET status = ?, attempts = ?, last_error = ? WHERE id = ?").run(status, attempts, String((err as Error).message).slice(0, 500), job.id);
        console.warn(`[jobs] ${job.kind}(${job.owner_id}) failed (attempt ${attempts}): ${(err as Error).message}`);
        if (status === "pending") await new Promise((r) => setTimeout(r, 500 * attempts));
      }
    }
  }
}
