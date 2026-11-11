/**
 * Text embeddings for semantic memory search, computed locally.
 *
 * Why local: memory is the user's private history, and the point of a
 * local-first design is that it stays on the machine. A small model
 * (bge-small, 384 dimensions, ~34 MB quantised) runs in-process via ONNX,
 * embeds a query in a few milliseconds once warm, and needs no extra API key.
 *
 * Why no vector database: one user's history is thousands of vectors, not
 * millions. Brute-force cosine over 10k x 384 floats takes a few milliseconds
 * in plain JS. An ANN index would add a service and buy nothing at this scale.
 *
 * If the model can't load (offline first run, disk issue), `ready()` stays
 * false and retrieval quietly falls back to keyword search alone.
 */
export interface Embedder {
  readonly model: string;
  ready(): boolean;
  /** Vectors are L2-normalised, so cosine similarity is a plain dot product. */
  embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
}

/** bge models retrieve better when queries carry this instruction prefix. */
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

type Extractor = (texts: string[], opts: { pooling: "cls"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

export class LocalEmbedder implements Embedder {
  readonly model = "Xenova/bge-small-en-v1.5";
  private extractor: Extractor | null = null;
  private loading: Promise<void> | null = null;
  private failedAt = 0;

  ready() {
    return this.extractor !== null;
  }

  /**
   * Start loading in the background. Called at boot so the first query isn't
   * slow. A failed load (usually a network blip during the first download)
   * is retried at most once a minute instead of being given up on.
   */
  warm(): Promise<void> {
    if (this.failedAt && Date.now() - this.failedAt > 60_000) {
      this.failedAt = 0;
      this.loading = null;
    }
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const { pipeline, env } = await import("@huggingface/transformers");
        env.cacheDir = ".cache/models";
        const pipe = await pipeline("feature-extraction", this.model, { dtype: "q8" });
        this.extractor = pipe as unknown as Extractor;
        // One throwaway call compiles the graph, so the first real query is fast.
        await this.extractor(["warm up"], { pooling: "cls", normalize: true });
      } catch (err) {
        this.failedAt = Date.now();
        console.warn(`[embed] local model unavailable for now, using keyword search only: ${(err as Error).message}`);
      }
    })();
    return this.loading;
  }

  async embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]> {
    if (!this.extractor) {
      await this.warm();
      if (!this.extractor) return [];
    }
    const inputs = kind === "query" ? texts.map((t) => BGE_QUERY_PREFIX + t) : texts;
    const out = await this.extractor(inputs, { pooling: "cls", normalize: true });
    return out.tolist().map((v) => Float32Array.from(v));
  }
}

/**
 * Deterministic stand-in for tests: hashed bag of words. Good enough to check
 * that ranking and fusion work without downloading a model.
 */
export class HashEmbedder implements Embedder {
  readonly model = "hash-256";
  ready() {
    return true;
  }
  async embed(texts: string[]) {
    return texts.map((t) => {
      const v = new Float32Array(256);
      for (const word of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        let h = 2166136261;
        for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
        v[Math.abs(h) % 256]! += 1;
      }
      return normalise(v);
    });
  }
}

/** A disabled embedder (EMBEDDINGS=off). */
export const noEmbedder: Embedder = {
  model: "none",
  ready: () => false,
  embed: async () => [],
};

export function normalise(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i]! * b[i]!;
  return s;
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Uint8Array): Float32Array {
  // Copy so the vector is aligned and independent of SQLite's buffer.
  const copy = new Uint8Array(b);
  return new Float32Array(copy.buffer);
}
