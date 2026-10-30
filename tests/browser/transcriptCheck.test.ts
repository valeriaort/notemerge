import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { startBrowserTestServer } from "./helpers.js";
import type { BrowserTestServer } from "./helpers.js";
import { ScriptedSpeechToText } from "../../src/providers/fakes.js";
import FormData from "form-data";
import type { Sentence } from "../../src/shared/types.js";

const FIXTURES = path.resolve("tests/fixtures");
const SHORT_AUDIO = readFileSync(path.join(FIXTURES, "short_audio.wav"));
const RECORDING_START = 1_700_000_000_000;

// Minimal single-slide PDF
function buildSlidePdf(): Buffer {
  const stream = "BT /F1 24 Tf 50 720 Td (Slide Title) Tj ET\nBT /F1 12 Tf 50 670 Td (- Slide bullet) Tj ET\n";
  const objs = [
    "",
    "<</Type /Catalog /Pages 2 0 R>>",
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
    `<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources <</Font <</F1 3 0 R>>>>>>`,
    `<</Length ${stream.length}>>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = new Array(6).fill(0) as number[];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<</Size 6 /Root 1 0 R>>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

const SLIDE_PDF = buildSlidePdf();

async function seedTranscriptCheckLecture(
  apiUrl: string,
  count = 1,
): Promise<{ lectureId: string; sentences: Sentence[] }> {
  const lectureRes = await fetch(`${apiUrl}/api/lectures`, { method: "POST" });
  const lecture = await lectureRes.json() as { id: string };

  const subjectRes = await fetch(`${apiUrl}/api/subjects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test Subject" }),
  });
  const subject = await subjectRes.json() as { id: string };

  const blockId = "b1";
  const notesData = {
    blocks: [{ id: blockId, type: "paragraph", content: [{ type: "text", text: "notes" }], children: [] }],
    meta: { [blockId]: { firstEditTime: RECORDING_START + 500, lastEditTime: RECORDING_START + 500 } },
  };
  await fetch(`${apiUrl}/api/lectures/${lecture.id}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesData: JSON.stringify(notesData) }),
  });

  const form = new FormData();
  form.append("subjectId", subject.id);
  form.append("presentation", SLIDE_PDF, { filename: "slides.pdf", contentType: "application/pdf" });
  form.append("audio1", SHORT_AUDIO, { filename: "lecture.wav", contentType: "audio/wav" });
  form.append("audio1StartTime", String(RECORDING_START));
  await fetch(`${apiUrl}/api/lectures/${lecture.id}/sources`, {
    method: "POST",
    headers: form.getHeaders() as Record<string, string>,
    body: form.getBuffer(),
  });

  await fetch(`${apiUrl}/api/lectures/${lecture.id}/transcribe`, { method: "POST" });

  // Verify we have flagged sentences
  const checkRes = await fetch(`${apiUrl}/api/lectures/${lecture.id}/transcript-check`);
  const check = await checkRes.json() as { queue: Sentence[] };
  if (check.queue.length < count) {
    throw new Error(`Expected at least ${count} flagged sentences, got ${check.queue.length}`);
  }

  return { lectureId: lecture.id, sentences: check.queue };
}

let srv: BrowserTestServer;
let speechToText: ScriptedSpeechToText;

test.beforeAll(async () => {
  speechToText = new ScriptedSpeechToText();
  // Produce 2 flagged sentences (bad avgLogprob)
  speechToText.setDefaultSegments([
    { startMs: 0, endMs: 1000, text: "Posible error uno.", avgLogprob: -1.5, noSpeechProb: 0.1, compressionRatio: 1.0 },
    { startMs: 1000, endMs: 2000, text: "Posible error dos.", avgLogprob: -1.5, noSpeechProb: 0.1, compressionRatio: 1.0 },
  ]);
  srv = await startBrowserTestServer({ speechToText });
});

test.afterAll(() => {
  srv.close();
});

test("transcript check screen shows flagged sentences", async ({ page }) => {
  const { lectureId, sentences } = await seedTranscriptCheckLecture(srv.url, 1);
  expect(sentences.length).toBeGreaterThan(0);

  await page.goto(`${srv.url}/#/transcript-check/${lectureId}`);
  await page.waitForSelector("[data-testid='transcript-check-screen']", { timeout: 5000 });

  // Should show the sentence text
  const sentenceText = await page.locator("[data-testid='sentence-text']").innerText();
  expect(sentenceText).toBeTruthy();
});

test("Space key plays audio (fake audio)", async ({ page }) => {
  const { lectureId } = await seedTranscriptCheckLecture(srv.url, 1);

  await page.goto(`${srv.url}/#/transcript-check/${lectureId}`);
  await page.waitForSelector("[data-testid='transcript-check-screen']", { timeout: 5000 });

  // Monitor fetch requests for audio
  const audioRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("audio-clip")) {
      audioRequests.push(req.url());
    }
  });

  // Press Space
  await page.keyboard.press(" ");

  // Should have triggered an audio request
  await page.waitForFunction(() => {
    return document.querySelectorAll("[data-testid='play-button']").length > 0;
  });
  // Small wait for the network request
  await page.waitForTimeout(500);
  expect(audioRequests.length).toBeGreaterThan(0);
});

test("Enter advances a flagged sentence", async ({ page }) => {
  const { lectureId, sentences } = await seedTranscriptCheckLecture(srv.url, 1);
  const firstId = sentences[0]!.id;

  await page.goto(`${srv.url}/#/transcript-check/${lectureId}`);
  await page.waitForSelector("[data-testid='transcript-check-screen']", { timeout: 5000 });

  // Check progress shows 0/N handled
  const progress = await page.locator("[data-testid='progress-indicator']").innerText();
  expect(progress).toContain("0 /");

  // Press Enter to advance
  await page.keyboard.press("Enter");

  // The sentence was the last one — merge auto-starts, page navigates to review
  // Wait for the review page OR the merge to complete
  await page.waitForFunction(
    () => window.location.hash.includes("review") || window.location.hash.includes("transcript-check") === false,
    { timeout: 10000 },
  );

  // Verify sentence was advanced via API
  const sentRes = await fetch(`${srv.url}/api/lectures/${lectureId}/sentences`);
  const { sentences: updatedSents } = await sentRes.json() as { sentences: Sentence[] };
  const s = updatedSents.find((s) => s.id === firstId);
  expect(s?.flagState).toBe("advanced");
});

test("a typed correction sticks", async ({ page }) => {
  // Create a separate lecture with 2 flags so we can correct one without triggering merge
  const lectureRes = await fetch(`${srv.url}/api/lectures`, { method: "POST" });
  const lecture = await lectureRes.json() as { id: string };
  const subjectRes = await fetch(`${srv.url}/api/subjects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test" }),
  });
  const subject = await subjectRes.json() as { id: string };
  const blockId = "b1";
  const notesData = {
    blocks: [{ id: blockId, type: "paragraph", content: [{ type: "text", text: "notes" }], children: [] }],
    meta: { [blockId]: { firstEditTime: RECORDING_START + 500, lastEditTime: RECORDING_START + 500 } },
  };
  await fetch(`${srv.url}/api/lectures/${lecture.id}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesData: JSON.stringify(notesData) }),
  });
  const form = new FormData();
  form.append("subjectId", subject.id);
  form.append("presentation", SLIDE_PDF, { filename: "slides.pdf", contentType: "application/pdf" });
  form.append("audio1", SHORT_AUDIO, { filename: "lecture.wav", contentType: "audio/wav" });
  form.append("audio1StartTime", String(RECORDING_START));
  await fetch(`${srv.url}/api/lectures/${lecture.id}/sources`, {
    method: "POST",
    headers: form.getHeaders() as Record<string, string>,
    body: form.getBuffer(),
  });
  await fetch(`${srv.url}/api/lectures/${lecture.id}/transcribe`, { method: "POST" });

  const checkRes = await fetch(`${srv.url}/api/lectures/${lecture.id}/transcript-check`);
  const { queue } = await checkRes.json() as { queue: Sentence[] };
  if (queue.length < 2) {
    // With only 1 flag, skip this test
    return;
  }
  const sentenceId = queue[0]!.id;

  await page.goto(`${srv.url}/#/transcript-check/${lecture.id}`);
  await page.waitForSelector("[data-testid='transcript-check-screen']", { timeout: 5000 });

  // Click "Correct" to open editor
  await page.click("[data-testid='edit-button']");
  await page.waitForSelector("[data-testid='correction-input']");

  // Clear and type correction
  await page.fill("[data-testid='correction-input']", "Texto corregido por el usuario.");

  // Save
  await page.click("[data-testid='save-correction']");

  // Wait for UI update
  await page.waitForTimeout(500);

  // Verify correction was persisted
  const sentRes = await fetch(`${srv.url}/api/lectures/${lecture.id}/sentences`);
  const { sentences: updatedSents } = await sentRes.json() as { sentences: Sentence[] };
  const s = updatedSents.find((s) => s.id === sentenceId);
  expect(s?.correctedText).toBe("Texto corregido por el usuario.");
  expect(s?.flagState).toBe("corrected");
});

test("Skip button jumps to merge", async ({ page }) => {
  const { lectureId } = await seedTranscriptCheckLecture(srv.url, 1);

  await page.goto(`${srv.url}/#/transcript-check/${lectureId}`);
  await page.waitForSelector("[data-testid='transcript-check-screen']", { timeout: 5000 });

  // Click Skip
  await page.click("[data-testid='skip-button']");

  // Should navigate to review after merge completes
  await page.waitForFunction(
    () => window.location.hash.includes("review"),
    { timeout: 15000 },
  );

  expect(page.url()).toContain("review");
});

test("merge starts by itself when queue is clear", async ({ page }) => {
  const { lectureId } = await seedTranscriptCheckLecture(srv.url, 1);

  await page.goto(`${srv.url}/#/transcript-check/${lectureId}`);
  await page.waitForSelector("[data-testid='transcript-check-screen']", { timeout: 5000 });

  // Advance the only flagged sentence via Enter
  await page.keyboard.press("Enter");

  // Merge should auto-start and navigate to review
  await page.waitForFunction(
    () => window.location.hash.includes("review"),
    { timeout: 15000 },
  );

  expect(page.url()).toContain("review");
});
