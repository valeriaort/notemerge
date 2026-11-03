import { test, expect } from "@playwright/test";
import path from "path";
import { startBrowserTestServer, seedLecture, openLecturePage } from "./helpers.js";
import type { BrowserTestServer } from "./helpers.js";

const FIXTURES = path.resolve("tests/fixtures");

let srv: BrowserTestServer;

test.beforeAll(async () => { srv = await startBrowserTestServer(); });
test.afterAll(() => { srv.close(); });

async function openSources(page: import("@playwright/test").Page, markerTs?: number) {
  const lecture = await seedLecture(srv.url);
  if (markerTs !== undefined) {
    await fetch(`${srv.url}/api/lectures/${lecture.id}/markers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blockId: "b1", timestamp: markerTs }),
    });
  }
  await openLecturePage(page, srv.url, lecture.id);
  await page.getByTestId("continue-to-sources").click();
  await page.waitForSelector("[data-testid='sources-screen']");
  await page.getByTestId("new-subject-option").click();
  await page.getByTestId("new-subject-input").fill("Anatomy");
  return lecture;
}

test("live lecture: audio start time is pre-filled from the first marker and sent per file", async ({ page }) => {
  // 2026-03-10 09:14:20 Madrid (CET, UTC+1) = 08:14:20Z
  const markerTs = Date.UTC(2026, 2, 10, 8, 14, 20);
  const lecture = await openSources(page, markerTs);

  await expect(page.getByTestId("audio1-drop-zone")).toBeVisible();
  await page.getByTestId("audio1-file-input").setInputFiles(path.join(FIXTURES, "short_audio.wav"));
  const start = page.getByTestId("audio1-start-time");
  await expect(start).toHaveValue("2026-03-10T09:14:20");

  await start.fill("2026-03-10T09:10");
  await page.getByTestId("audio2-file-input").setInputFiles(path.join(FIXTURES, "short_audio.wav"));
  await page.getByTestId("submit-sources").click();
  await expect(page.getByTestId("sources-error")).toBeVisible(); // second start time missing

  await page.getByTestId("audio2-start-time").fill("2026-03-10T10:30");
  await page.getByTestId("submit-sources").click();
  await page.waitForSelector("[data-testid='slides-preview']");

  const listed = await (await fetch(`${srv.url}/api/lectures/${lecture.id}/audio-files`)).json() as
    { audioFiles: Array<{ recordingStartMs: number }> };
  expect(listed.audioFiles.map((a) => a.recordingStartMs)).toEqual([
    Date.UTC(2026, 2, 10, 8, 10, 0),
    Date.UTC(2026, 2, 10, 9, 30, 0),
  ]);
});
