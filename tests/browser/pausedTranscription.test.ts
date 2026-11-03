import { test, expect } from "@playwright/test";
import path from "path";
import { startBrowserTestServer } from "./helpers.js";
import type { BrowserTestServer } from "./helpers.js";
import { ScriptedSpeechToText } from "../../src/providers/fakes.js";

const FIXTURES = path.resolve("tests/fixtures");

let srv: BrowserTestServer;
const stt = new ScriptedSpeechToText();

test.beforeAll(async () => {
  srv = await startBrowserTestServer({ speechToText: stt });
});

test.afterAll(() => {
  srv.close();
});

test("a paused transcription stays on Sources with the failed chunk and Retry, which then reaches the transcript check", async ({ page }) => {
  stt.setFailCount(100, 400);
  await page.goto(srv.url);
  await page.getByTestId("mode-untimed").check();
  await page.getByTestId("new-lecture").click();
  await page.waitForSelector("[data-testid='sources-screen']");
  await page.getByTestId("new-subject-option").click();
  await page.getByTestId("new-subject-input").fill("Anatomy");
  await page.getByTestId("notes-file-input").setInputFiles(path.join(FIXTURES, "notes.md"));
  await page.getByTestId("audio1-file-input").setInputFiles(path.join(FIXTURES, "short_audio.wav"));
  await page.getByTestId("submit-sources").click();
  await page.waitForSelector("[data-testid='slides-preview']");

  await page.getByTestId("continue-after-seal").click();
  await expect(page.getByTestId("failed-chunk").first()).toContainText("A01-C001");
  await expect(page.getByTestId("retry-transcription")).toBeVisible();
  expect(page.url()).not.toContain("transcript-check");

  stt.setFailCount(0);
  await page.getByTestId("retry-transcription").click();
  await page.waitForURL(/#\/transcript-check\//);
});

async function lectureInStage(stage: string): Promise<string> {
  const lecture = await (await fetch(`${srv.url}/api/lectures`, { method: "POST" })).json() as { id: string };
  const db = (await import("better-sqlite3")).default;
  const conn = new db(path.join(srv.dataDir, "notemerge.db"));
  conn.prepare("UPDATE lectures SET stage = ? WHERE id = ?").run(stage, lecture.id);
  conn.close();
  return lecture.id;
}

test("opening transcript-check for a sealed lecture routes to Sources, not a bare error", async ({ page }) => {
  const id = await lectureInStage("sealed");
  await page.goto(`${srv.url}/#/transcript-check/${id}`);
  await page.waitForURL(new RegExp(`#/sources/${id}`));
  await expect(page.getByText("not in the transcript-check stage")).toHaveCount(0);
});

for (const stage of ["review", "exported"]) {
  test(`opening transcript-check for a ${stage} lecture routes to Review`, async ({ page }) => {
    const id = await lectureInStage(stage);
    await page.goto(`${srv.url}/#/transcript-check/${id}`);
    await page.waitForURL(new RegExp(`#/review/${id}`));
  });
}
