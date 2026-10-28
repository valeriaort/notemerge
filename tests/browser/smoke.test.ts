import { test, expect } from "@playwright/test";
import { startBrowserTestServer, seedLecture, openLecturePage } from "./helpers.js";
import type { BrowserTestServer } from "./helpers.js";

let srv: BrowserTestServer;

test.beforeAll(async () => {
  srv = await startBrowserTestServer();
});

test.afterAll(() => {
  srv.close();
});

test("create a lecture in the UI, type text, reload — text is still there", async ({
  page,
}) => {
  // Open the Library page
  await page.goto(srv.url);
  await page.waitForSelector("button", { hasText: "New Lecture" });

  // Click "New Lecture" — navigates to Write view
  await page.click("button >> text=New Lecture");
  await page.waitForSelector("[data-testid='notes-textarea']");

  // Type some text
  const textarea = page.locator("[data-testid='notes-textarea']");
  await textarea.fill("Lecture notes about the heart");

  // Wait for "Saved" indicator (auto-save debounce is 500ms)
  await page.waitForSelector("text=Saved", { timeout: 5000 });

  // Reload the page — the URL still has the lecture ID in the hash
  await page.reload();
  await page.waitForSelector("[data-testid='notes-textarea']");

  // Text should still be there
  const value = await page.locator("[data-testid='notes-textarea']").inputValue();
  expect(value).toBe("Lecture notes about the heart");
});

test("seedLecture helper creates a lecture accessible by ID", async ({ page }) => {
  const lecture = await seedLecture(srv.url);
  await openLecturePage(page, srv.url, lecture.id);

  const textarea = page.locator("[data-testid='notes-textarea']");
  await expect(textarea).toBeVisible();
});
