import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { createFakeProviders } from "../../src/providers/fakes.js";
import type { Providers } from "../../src/providers/interfaces.js";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type Database from "better-sqlite3";

export interface TestServer {
  url: string;
  dataDir: string;
  db: Database.Database;
  close: () => void;
}

export function startTestServer(providerOverrides?: Partial<Providers>): Promise<TestServer> {
  return new Promise((resolve) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "notemerge-test-"));
    const dbPath = path.join(dataDir, "notemerge.db");
    const db = openDb(dbPath);
    const providers = { ...createFakeProviders(), ...providerOverrides };
    const app = createApp(db, dataDir, providers);

    const server: Server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://localhost:${port}`;
      resolve({
        url,
        dataDir,
        db,
        close: () => {
          server.close();
          db.close();
        },
      });
    });
  });
}
