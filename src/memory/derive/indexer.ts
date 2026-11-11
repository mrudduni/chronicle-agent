/**
 * Keeps the keyword index (FTS5) and the vector index in step with the log.
 *
 * The unit of retrieval is a turn: one user message plus the answer to it.
 * Indexing them together means "Postgres hosting" finds the turn even if only
 * the answer used those words. Topics and day digests are indexed too, so
 * vague questions can land on a summary first.
 */
import type { Db } from "../../db";
import { type Embedder, toBlob } from "../../embed";
import { redact } from "../redact";
import type { MemoryStore } from "../store";

export class Indexer {
  constructor(
    private readonly db: Db,
    private readonly store: MemoryStore,
    private readonly embedder: Embedder,
  ) {}

  async indexTurn(turnId: number) {
    const q = this.store.message(turnId);
    if (!q || q.role !== "user" || q.status === "forgotten") return;
    const a = this.store.replyTo(turnId);
    const text = redact(`${q.content}\n\n${a && a.status !== "forgotten" ? a.content : ""}`).slice(0, 6000);
    this.upsertText("turn", String(turnId), q.user_id, q.local_day, text);
    // Embed the question plus the start of the answer. The question carries
    // most of the intent; the answer adds the names that were discussed.
    await this.upsertVector("turn", String(turnId), q.user_id, redact(`${q.content}\n${(a?.content ?? "").slice(0, 800)}`));
  }

  async indexDoc(type: "topic" | "digest", id: string, userId: string, localDay: string, text: string) {
    const clean = redact(text);
    this.upsertText(type, id, userId, localDay, clean);
    await this.upsertVector(type, id, userId, clean);
  }

  private upsertText(type: string, id: string, userId: string, localDay: string, text: string) {
    this.db.prepare("DELETE FROM fts WHERE owner_type = ? AND owner_id = ?").run(type, id);
    this.db.prepare("INSERT INTO fts (owner_type, owner_id, user_id, local_day, text) VALUES (?, ?, ?, ?, ?)").run(type, id, userId, localDay, text);
  }

  private async upsertVector(type: string, id: string, userId: string, text: string) {
    // Background job, so it's fine to wait for the model to finish loading here.
    const [v] = await this.embedder.embed([text], "passage");
    if (!v) return; // embeddings disabled or unavailable: keyword index only
    this.db
      .prepare("INSERT OR REPLACE INTO embeddings (owner_type, owner_id, user_id, model, vector) VALUES (?, ?, ?, ?, ?)")
      .run(type, id, userId, this.embedder.model, toBlob(v));
  }
}
