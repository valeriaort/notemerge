import { createHash } from "crypto";
import path from "path";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "./interfaces.js";
import { EmbeddingError } from "./interfaces.js";

export const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-m3";

type FeatureExtractor = (
  texts: string[],
  options: { pooling: "cls" | "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

// Local bge-m3 (ONNX) run inside the Node server. The model downloads on first
// use into a cache directory under dataDir; nothing is loaded until embed() runs.
export class LocalBgeM3Embedder implements EmbeddingProvider {
  readonly model: string;
  private readonly dataDir: string;
  private extractor: Promise<FeatureExtractor> | null = null;

  constructor(dataDir: string, model: string = DEFAULT_EMBEDDING_MODEL) {
    this.model = model;
    this.dataDir = dataDir;
  }

  private load(): Promise<FeatureExtractor> {
    if (!this.extractor) {
      this.extractor = (async () => {
        const { pipeline, env } = await import("@huggingface/transformers");
        env.cacheDir = path.resolve(this.dataDir, "models");
        return (await pipeline("feature-extraction", this.model)) as unknown as FeatureExtractor;
      })();
      // Do not cache a failed load: the next call retries from scratch.
      this.extractor.catch(() => {
        this.extractor = null;
      });
    }
    return this.extractor;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    try {
      const extract = await this.load();
      const output = await extract(texts, { pooling: "cls", normalize: true });
      return output.tolist();
    } catch (err) {
      throw new EmbeddingError(`Embedding failed: ${(err as Error).message}`);
    }
  }
}

// Stores vectors in SQLite keyed by model and a hash of the text, so only
// text that has not been embedded before reaches the inner provider.
export class CachedEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly db: Database.Database,
    private readonly model: string,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_cache (
        model TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        vector TEXT NOT NULL,
        PRIMARY KEY (model, text_hash)
      );
    `);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const hashes = texts.map((t) => createHash("sha256").update(t).digest("hex"));
    const select = this.db.prepare(
      "SELECT vector FROM embedding_cache WHERE model = ? AND text_hash = ?",
    );
    const vectors = new Map<string, number[]>();
    const missing = new Map<string, string>(); // hash -> text, deduplicated
    hashes.forEach((hash, i) => {
      if (vectors.has(hash) || missing.has(hash)) return;
      const row = select.get(this.model, hash) as { vector: string } | undefined;
      if (row) vectors.set(hash, JSON.parse(row.vector) as number[]);
      else missing.set(hash, texts[i]);
    });

    if (missing.size > 0) {
      const missingHashes = [...missing.keys()];
      const fresh = await this.inner.embed([...missing.values()]);
      if (fresh.length !== missingHashes.length) {
        throw new EmbeddingError(
          `Embedding provider returned ${fresh.length} vectors for ${missingHashes.length} texts`,
        );
      }
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO embedding_cache (model, text_hash, vector) VALUES (?, ?, ?)",
      );
      this.db.transaction(() => {
        missingHashes.forEach((hash, i) => {
          insert.run(this.model, hash, JSON.stringify(fresh[i]));
          vectors.set(hash, fresh[i]);
        });
      })();
    }

    return hashes.map((h) => vectors.get(h)!);
  }
}
