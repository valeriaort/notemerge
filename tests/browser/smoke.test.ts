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

test("create a lecture in the UI, type text, reload — content is still there", async ({
  page,
}) => {
  // Open the Library page
  await page.goto(srv.url);
  await page.waitForSelector("button", { hasText: "New Lecture" });

  // Click "New Lecture" — navigates to Write view
  await page.click("button >> text=New Lecture");
  await page.waitForSelector("[data-testid='notes-editor']");

  // Click into the editor and type
  const editorContent = page.locator("[data-testid='notes-editor'] [contenteditable='true']").first();
  await editorContent.click();
  await editorContent.type("Lecture notes about the heart");

  // Wait for "Saved" indicator (auto-save debounce is 500ms)
  await page.waitForSelector("text=Saved", { timeout: 5000 });

  // Reload — the URL still has the lecture ID in the hash
  await page.reload();
  await page.waitForSelector("[data-testid='notes-editor']");

  // Content should still be there
  const text = await page.locator("[data-testid='notes-editor']").innerText();
  expect(text).toContain("Lecture notes about the heart");
});

test("pressing Enter in the editor creates a new block", async ({ page }) => {
  const lecture = await seedLecture(srv.url);
  await openLecturePage(page, srv.url, lecture.id);

  const editor = page.locator("[data-testid='notes-editor'] [contenteditable='true']").first();
  await editor.click();
  await editor.type("First block");
  await editor.press("Enter");
  await editor.type("Second block");

  // Wait for autosave
  await page.waitForSelector("text=Saved", { timeout: 5000 });

  // Reload and verify both blocks are still there
  await page.reload();
  await page.waitForSelector("[data-testid='notes-editor']");

  const text = await page.locator("[data-testid='notes-editor']").innerText();
  expect(text).toContain("First block");
  expect(text).toContain("Second block");
});

test("autosave works without any manual save action", async ({ page }) => {
  const lecture = await seedLecture(srv.url);
  await openLecturePage(page, srv.url, lecture.id);

  const editor = page.locator("[data-testid='notes-editor'] [contenteditable='true']").first();
  await editor.click();
  await editor.type("Autosaved content");

  // The "Saved" indicator must appear without clicking any save button
  await page.waitForSelector("text=Saved", { timeout: 5000 });
});

test("seedLecture helper creates a lecture accessible by ID", async ({ page }) => {
  const lecture = await seedLecture(srv.url);
  await openLecturePage(page, srv.url, lecture.id);

  const editor = page.locator("[data-testid='notes-editor']");
  await expect(editor).toBeVisible();
});
