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

test("Continue to Sources button navigates to Sources screen", async ({ page }) => {
  const lecture = await seedLecture(srv.url);
  await openLecturePage(page, srv.url, lecture.id);

  // Click "Continue to Sources" — keyboard-accessible button in the toolbar
  await page.click("[data-testid='continue-to-sources']");

  // Sources screen should render
  await page.waitForSelector("[data-testid='sources-screen']", { timeout: 5000 });
  await page.waitForSelector("[data-testid='drop-zone']");
  await page.waitForSelector("[data-testid='submit-sources']");
});

test("typing // with keyboard only inserts a slide marker divider", async ({ page }) => {
  const lecture = await seedLecture(srv.url);
  await openLecturePage(page, srv.url, lecture.id);

  const editorContent = page
    .locator("[data-testid='notes-editor'] [contenteditable='true']")
    .first();
  await editorContent.click();
  // Type some notes, then a slide transition — no mouse
  await editorContent.type("Notes before slide");
  await editorContent.press("Enter");
  await editorContent.type("//");

  // Wait for the divider to appear (the // paragraph is replaced by a slideMarker block)
  await page.waitForSelector("[data-testid='slide-marker']", { timeout: 5000 });

  // Wait for autosave so the slideMarker block is persisted in notesData
  await page.waitForSelector("text=Saved", { timeout: 5000 });

  // Reload — the divider must survive
  await page.reload();
  await page.waitForSelector("[data-testid='notes-editor']");

  const marker = page.locator("[data-testid='slide-marker']");
  await expect(marker).toBeVisible();
});
