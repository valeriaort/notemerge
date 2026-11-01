import { test, expect } from "@playwright/test";
import path from "path";
import { startBrowserTestServer } from "./helpers.js";
import type { BrowserTestServer } from "./helpers.js";

const FIXTURES = path.resolve("tests/fixtures");

let srv: BrowserTestServer;

test.beforeAll(async () => {
  srv = await startBrowserTestServer();
});

test.afterAll(() => {
  srv.close();
});

test("live notes is the default mode and New Lecture opens the editor", async ({ page }) => {
  await page.goto(srv.url);
  await expect(page.getByTestId("mode-live")).toBeChecked();
  await page.getByTestId("new-lecture").click();
  await page.waitForSelector("[data-testid='notes-editor']");
});

test("choosing uploaded notes by keyboard opens Sources with no editor and no start time", async ({ page }) => {
  await page.goto(srv.url);
  await page.getByTestId("mode-live").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("mode-untimed")).toBeChecked();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");

  await page.waitForSelector("[data-testid='sources-screen']");
  await expect(page.getByTestId("notes-drop-zone")).toBeVisible();
  await expect(page.getByTestId("notes-editor")).toHaveCount(0);
  await expect(page.getByText(/start time/i)).toHaveCount(0);
});

test("notes alone is rejected with the server message, then notes + presentation seal", async ({ page }) => {
  await page.goto(srv.url);
  await page.getByTestId("mode-untimed").check();
  await page.getByTestId("new-lecture").click();
  await page.waitForSelector("[data-testid='sources-screen']");

  await page.getByTestId("new-subject-option").click();
  await page.getByTestId("new-subject-input").fill("Anatomy");

  await page.getByTestId("notes-file-input").setInputFiles(path.join(FIXTURES, "notes.md"));
  await page.getByTestId("submit-sources").click();
  await expect(page.getByText(/notes alone cannot be merged/i)).toBeVisible();

  await page.getByTestId("file-input").setInputFiles(path.join(FIXTURES, "text_slides.pdf"));
  await page.getByTestId("submit-sources").click();
  await page.waitForSelector("[data-testid='slides-preview']");
});

test("a scanned PDF as notes shows the server error", async ({ page }) => {
  await page.goto(srv.url);
  await page.getByTestId("mode-untimed").check();
  await page.getByTestId("new-lecture").click();
  await page.waitForSelector("[data-testid='sources-screen']");
  await page.getByTestId("new-subject-option").click();
  await page.getByTestId("new-subject-input").fill("Anatomy");
  await page.getByTestId("notes-file-input").setInputFiles(path.join(FIXTURES, "notes-scanned.pdf"));
  await page.getByTestId("file-input").setInputFiles(path.join(FIXTURES, "text_slides.pdf"));
  await page.getByTestId("submit-sources").click();
  await expect(page.getByTestId("sources-error")).toBeVisible();
});

test("reopening an untimed lecture still in writing goes to Sources", async ({ page }) => {
  await page.goto(srv.url);
  await page.getByTestId("mode-untimed").check();
  await page.getByTestId("new-lecture").click();
  await page.waitForSelector("[data-testid='sources-screen']");
  await page.getByTestId("sources-back").click();
  await page.getByTestId("open-lecture-button").first().click();
  await page.waitForSelector("[data-testid='sources-screen']");
});

test("untimed notes + audio seals, lists the audio, and Continue leads to the transcript check", async ({ page }) => {
  await page.goto(srv.url);
  await page.getByTestId("mode-untimed").check();
  await page.getByTestId("new-lecture").click();
  await page.waitForSelector("[data-testid='sources-screen']");
  const lectureId = page.url().split("/").pop()!;

  await page.getByTestId("new-subject-option").click();
  await page.getByTestId("new-subject-input").fill("Anatomy");
  await expect(page.getByTestId("audio1-drop-zone")).toBeVisible();
  await expect(page.getByTestId("audio2-drop-zone")).toHaveCount(0);
  await expect(page.getByText(/start time/i)).toHaveCount(0);

  await page.getByTestId("notes-file-input").setInputFiles(path.join(FIXTURES, "notes.md"));
  await page.getByTestId("audio1-file-input").setInputFiles(path.join(FIXTURES, "short_audio.wav"));
  await expect(page.getByTestId("audio2-drop-zone")).toBeVisible();
  await page.getByTestId("submit-sources").click();
  await page.waitForSelector("[data-testid='slides-preview']");

  const listed = await (await fetch(`${srv.url}/api/lectures/${lectureId}/audio-files`)).json() as { audioFiles: unknown[] };
  expect(listed.audioFiles).toHaveLength(1);

  await page.getByTestId("continue-after-seal").click();
  await page.waitForURL(/#\/transcript-check\//);
});
