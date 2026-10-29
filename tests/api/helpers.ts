import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { createFakeProviders } from "../../src/providers/fakes.js";
import type { Providers } from "../../src/providers/interfaces.js";
import type { Config } from "../../src/server/config.js";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type Database from "better-sqlite3";

export interface TestServer {
  url: string;
  dataDir: string;
  db: Database.Database;
  cfg: Config;
  close: () => void;
}

export function startTestServer(providerOverrides?: Partial<Providers>, cfgOverride?: Partial<Config>): Promise<TestServer> {
  return new Promise((resolve) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "notemerge-test-"));
    const dbPath = path.join(dataDir, "notemerge.db");
    const db = openDb(dbPath);
    const providers = { ...createFakeProviders(), ...providerOverrides };
    const cfg: Config = {
      port: 0,
      dataDir,
      transcriptionModel: "whisper-large-v3",
      groq: { apiKey: "test" },
      jev: { apiKey: "test", model: "jev-1.14.0" },
      haiku: { apiKey: "test" },
      notion: { clientId: "test-client-id", clientSecret: "test-client-secret" },
      thresholds: {
        whisperAvgLogprob: -1.0,
        whisperNoSpeechProb: 0.6,
        whisperCompressionRatio: 2.4,
        noiseMinProbability: 0.95,
      },
      contextMarginMs: 60000,
      mergeWindowConcurrency: 4,
      chunkTargetMs: 120000,
      ...cfgOverride,
    };
    const app = createApp(db, dataDir, providers, cfg);

    const server: Server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://localhost:${port}`;
      cfg.port = port;
      resolve({
        url,
        dataDir,
        db,
        cfg,
        close: () => {
          server.close();
          db.close();
        },
      });
    });
  });
}
