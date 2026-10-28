import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { createFakeProviders } from "../../src/providers/fakes.js";
import type { AddressInfo } from "net";
import type { Server } from "http";
import type { Page } from "@playwright/test";
import type { Lecture } from "../../src/shared/types.js";

export interface BrowserTestServer {
  url: string;
  dataDir: string;
  close: () => void;
}

/**
 * Boots the server on a free port against a temp data directory with all
 * provider fakes injected. Call close() in afterEach/afterAll.
 *
 * The server serves the built React client from dist/client. Run
 * `npm run build:client` (or `npm run test:browser` which does it) first.
 */
export function startBrowserTestServer(): Promise<BrowserTestServer> {
  return new Promise((resolve) => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "notemerge-browser-"));
    const dbPath = path.join(dataDir, "notemerge.db");
    const db = openDb(dbPath);
    const providers = createFakeProviders();
    const app = createApp(db, dataDir, providers);

    const server: Server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://localhost:${port}`;
      resolve({
        url,
        dataDir,
        close: () => {
          server.close();
          db.close();
        },
      });
    });
  });
}

/**
 * Creates a lecture via the API and returns it.
 * Use this to seed state before opening the browser.
 */
export async function seedLecture(apiUrl: string): Promise<Lecture> {
  const res = await fetch(`${apiUrl}/api/lectures`, { method: "POST" });
  if (!res.ok) throw new Error(`seedLecture failed: ${res.status}`);
  return res.json() as Promise<Lecture>;
}

/**
 * Navigates to the Write view for a specific lecture.
 */
export async function openLecturePage(
  page: Page,
  baseUrl: string,
  lectureId: string,
): Promise<void> {
  await page.goto(`${baseUrl}/#/write/${lectureId}`);
  await page.waitForSelector("[data-testid='notes-editor']");
}
