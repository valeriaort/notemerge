import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { CachedEmbeddingProvider, LocalBgeM3Embedder } from "../../src/providers/embeddings.js";
import { FakeEmbeddingProvider } from "../../src/providers/fakes.js";
import { EmbeddingError } from "../../src/providers/interfaces.js";
import { createProviders } from "../../src/providers/index.js";
import { loadConfigFrom } from "../../src/server/config.js";

describe("FakeEmbeddingProvider", () => {
  it("returns scripted vectors and records calls", async () => {
    const fake = new FakeEmbeddingProvider();
    fake.vectors.set("slide", [1, 0]);
    expect(await fake.embed(["slide"])).toEqual([[1, 0]]);
    expect(fake.calls).toEqual([["slide"]]);
  });

  it("gives unscripted text a deterministic vector", async () => {
    const fake = new FakeEmbeddingProvider();
    const [a] = await fake.embed(["hola"]);
    const [b] = await fake.embed(["hola"]);
    expect(a).toEqual(b);
  });
});

describe("CachedEmbeddingProvider", () => {
  let fake: FakeEmbeddingProvider;
  let cached: CachedEmbeddingProvider;
  beforeEach(() => {
    fake = new FakeEmbeddingProvider();
    fake.vectors.set("a", [1, 0]);
    fake.vectors.set("b", [0, 1]);
    cached = new CachedEmbeddingProvider(fake, new Database(":memory:"), "m");
  });

  it("does not call the provider again for unchanged text", async () => {
    await cached.embed(["a", "b"]);
    const second = await cached.embed(["b", "a"]);
    expect(second).toEqual([[0, 1], [1, 0]]);
    expect(fake.calls).toHaveLength(1);
  });

  it("embeds only changed text", async () => {
    await cached.embed(["a"]);
    await cached.embed(["a", "b", "b"]);
    expect(fake.calls[1]).toEqual(["b"]);
  });

  it("keys the cache by model", async () => {
    const db = new Database(":memory:");
    await new CachedEmbeddingProvider(fake, db, "m1").embed(["a"]);
    await new CachedEmbeddingProvider(fake, db, "m2").embed(["a"]);
    expect(fake.calls).toHaveLength(2);
  });

  it("surfaces a provider failure as an explicit error and caches nothing", async () => {
    fake.failWith = new EmbeddingError("boom");
    await expect(cached.embed(["a"])).rejects.toThrow(EmbeddingError);
    fake.failWith = null;
    expect(await cached.embed(["a"])).toEqual([[1, 0]]);
  });

  it("rejects a provider that returns the wrong number of vectors", async () => {
    const bad = { embed: async () => [] as number[][] };
    const c = new CachedEmbeddingProvider(bad, new Database(":memory:"), "m");
    await expect(c.embed(["a"])).rejects.toThrow(EmbeddingError);
  });
});

describe("createProviders", () => {
  it("uses the fake when configured and never loads the model", async () => {
    const cfg = { ...loadConfigFrom(process.cwd()), embeddings: { provider: "fake" as const } };
    const providers = createProviders(cfg, new Database(":memory:"));
    expect(await providers.embeddings.embed(["x"])).toHaveLength(1);
  });
});

// Opt-in: downloads about 0.5 GB on first run.
describe.skipIf(!process.env.NOTEMERGE_REAL_EMBEDDINGS)("local bge-m3 (real model)", () => {
  it("embeds Spanish text into normalized vectors", async () => {
    const dir = process.env.NOTEMERGE_MODEL_DIR ?? "./data";
    const [v, w] = await new LocalBgeM3Embedder(dir).embed([
      "El riñón filtra la sangre.",
      "La insuficiencia cardíaca se trata con IECA.",
    ]);
    expect(v.length).toBe(1024);
    expect(Math.hypot(...v)).toBeCloseTo(1, 3);
    expect(v).not.toEqual(w);
  }, 600_000);
});
