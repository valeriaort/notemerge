import { test, expect } from "@playwright/test";
import path from "path";
import fs from "fs";
import { startBrowserTestServer } from "./helpers.js";
import type { BrowserTestServer } from "./helpers.js";

const FIXTURES = path.resolve("tests/fixtures");

let srv: BrowserTestServer;

test.beforeAll(async () => { srv = await startBrowserTestServer(); });
test.afterAll(() => { srv.close(); });

async function openUntimedSources(page: import("@playwright/test").Page) {
  await page.goto(srv.url);
  await page.getByTestId("mode-untimed").check();
  await page.getByTestId("new-lecture").click();
  await page.waitForSelector("[data-testid='sources-screen']");
  await page.getByTestId("new-subject-option").click();
  await page.getByTestId("new-subject-input").fill("Anatomy");
  return page.url().split("/").pop()!;
}

async function dropFiles(page: import("@playwright/test").Page, names: Array<[string, string]>) {
  const files = names.map(([name, type]) => ({
    name, type, base64: fs.readFileSync(path.join(FIXTURES, name)).toString("base64"),
  }));
  await page.evaluate((fs_) => {
    const dt = new DataTransfer();
    for (const f of fs_) {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    document.querySelector("[data-testid='sources-screen']")!
      .dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
}

test("files dropped anywhere are routed by type: notes, presentation and audio", async ({ page }) => {
  await openUntimedSources(page);
  await dropFiles(page, [["notes.md", "text/markdown"], ["text_slides.pdf", "application/pdf"], ["short_audio.wav", "audio/wav"]]);
  await expect(page.getByTestId("notes-drop-zone")).toContainText("notes.md");
  await expect(page.getByTestId("drop-zone")).toContainText("text_slides.pdf");
  await expect(page.getByTestId("audio1-drop-zone")).toContainText("short_audio.wav");
});

test("notes + presentation + audio, then a second recording, seal and list both audio files", async ({ page }) => {
  await openUntimedSources(page);
  await page.getByTestId("notes-file-input").setInputFiles(path.join(FIXTURES, "notes.md"));
  await page.getByTestId("file-input").setInputFiles(path.join(FIXTURES, "text_slides.pdf"));
  await page.getByTestId("audio1-file-input").setInputFiles(path.join(FIXTURES, "short_audio.wav"));
  await page.getByTestId("audio2-file-input").setInputFiles(path.join(FIXTURES, "short_audio.wav"));
  const lectureId = page.url().split("/").pop()!;
  await page.getByTestId("submit-sources").click();
  await page.waitForSelector("[data-testid='slides-preview']");
  const listed = await (await fetch(`${srv.url}/api/lectures/${lectureId}/audio-files`)).json() as { audioFiles: unknown[] };
  expect(listed.audioFiles).toHaveLength(2);
});
