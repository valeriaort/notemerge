/**
 * Smoke test: variant D keyboard flow.
 * Exercises the combined journey — Write (//) → Sources → Transcript check
 * (Space/Enter) → Review (K, E, Revert) → Export PDF — plus reopening a
 * lecture at each stage via the Library stage-routing in App.tsx.
 *
 * Does NOT duplicate API-level assertions; only guards keyboard shortcuts and
 * screen routing that cannot be verified at the API seam.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { startBrowserTestServer } from "./helpers.js";
import type { BrowserTestServer } from "./helpers.js";
import {
  ScriptedSpeechToText,
  ScriptedClassifier,
  ScriptedWritingModel,
} from "../../src/providers/fakes.js";
import FormData from "form-data";
import type {
  MergedBlock,
  CoverageQuestion,
  CoverageAnswers,
  ConflictQuestion,
  ConflictAnswers,
} from "../../src/shared/types.js";

const FIXTURES = path.resolve("tests/fixtures");
const SHORT_AUDIO = readFileSync(path.join(FIXTURES, "short_audio.wav"));
const RECORDING_START = 1_700_000_000_000;

function buildSlidePdf(): Buffer {
  const pages = [{ texts: [{ text: "Slide Title", y: 720, size: 24 }, { text: "- Slide bullet", y: 670, size: 12 }] }];
  const n = pages.length;
  const numObjs = 3 + n * 2;
  const objBodies: string[] = [""];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objBodies.push("<</Type /Catalog /Pages 2 0 R>>");
  objBodies.push(`<</Type /Pages /Kids [${kids}] /Count ${n}>>`);
  objBodies.push("<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>");
  for (let i = 0; i < n; i++) {
    const contentObjNum = 5 + i * 2;
    let stream = "";
    for (const { text, y, size } of pages[i]!.texts) {
      const esc = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
      stream += `BT /F1 ${size} Tf 50 ${y} Td (${esc}) Tj ET\n`;
    }
    objBodies.push(`<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNum} 0 R /Resources <</Font <</F1 3 0 R>>>>>>`);
    objBodies.push(`<</Length ${stream.length}>>\nstream\n${stream}endstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = new Array(numObjs + 1).fill(0) as number[];
  for (let i = 1; i <= numObjs; i++) { offsets[i] = pdf.length; pdf += `${i} 0 obj\n${objBodies[i]}\nendobj\n`; }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${numObjs + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= numObjs; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${numObjs + 1} /Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

const SLIDE_PDF = buildSlidePdf();

/** Classifier: all slide bullets missing, all note blocks conflicting. */
const allConflictsClassifier = {
  async classifyCoverage(_s: string, questions: CoverageQuestion[]): Promise<CoverageAnswers> {
    const a: CoverageAnswers = {};
    for (const q of questions) a[q.key] = { label: "missing", probability: 0.98 };
    return a;
  },
  async checkConflicts(_s: string, questions: ConflictQuestion[]): Promise<ConflictAnswers> {
    const a: ConflictAnswers = {};
    for (const q of questions) a[q.key] = { label: "conflicts", probability: 0.97 };
    return a;
  },
};

/** Seeds a lecture to 'review' stage with a conflict block (B01) and a fallback addition. */
async function seedToReview(
  apiUrl: string,
  classifier: ScriptedClassifier,
  writingModel: ScriptedWritingModel,
): Promise<string> {
  const lectureRes = await fetch(`${apiUrl}/api/lectures`, { method: "POST" });
  const lecture = await lectureRes.json() as { id: string };

  const blockId = "B01";
  const t = RECORDING_START;
  const notesData = {
    blocks: [{ id: blockId, type: "paragraph", content: [{ type: "text", text: "student note" }], children: [] }],
    meta: { [blockId]: { firstEditTime: t, lastEditTime: t + 5 * 60 * 1000 } },
  };
  await fetch(`${apiUrl}/api/lectures/${lecture.id}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesData: JSON.stringify(notesData) }),
  });

  const form = new FormData();
  form.append("subjectName", "Anatomy");
  form.append("presentation", SLIDE_PDF, { filename: "slides.pdf", contentType: "application/pdf" });
  form.append("audio1", SHORT_AUDIO, { filename: "lecture.wav", contentType: "audio/wav" });
  form.append("audio1StartTime", String(RECORDING_START));
  await fetch(`${apiUrl}/api/lectures/${lecture.id}/sources`, {
    method: "POST",
    headers: form.getHeaders() as Record<string, string>,
    body: form.getBuffer(),
  });

  // B01 conflicts; S001-B01 missing → fallback addition
  classifier.addConflictAnswers({ [`conflict:${blockId}`]: { label: "conflicts", probability: 0.97 } });
  classifier.addCoverageAnswers({ "coverage:S001-B01": { label: "missing", probability: 0.98 } });
  // Rewrite for conflict so proposedRewrite is set (needed for E to substitute text)
  writingModel.setOperations([{ type: "rewrite", blockId, text: "corrected note text", sourceIds: ["S001-B01"] }]);

  await fetch(`${apiUrl}/api/lectures/${lecture.id}/transcribe`, { method: "POST" });
  await fetch(`${apiUrl}/api/lectures/${lecture.id}/transcript-check/skip`, { method: "POST" });

  return lecture.id;
}

let srv: BrowserTestServer;
let speechToText: ScriptedSpeechToText;
let classifier: ScriptedClassifier;
let writingModel: ScriptedWritingModel;

test.beforeEach(async () => {
  speechToText = new ScriptedSpeechToText();
  classifier = new ScriptedClassifier();
  writingModel = new ScriptedWritingModel();
  // One flagged sentence: single Enter clears the queue and auto-starts merge
  speechToText.setDefaultSegments([
    { startMs: 0, endMs: 1500, text: "Posible error.", avgLogprob: -1.5, noSpeechProb: 0.1, compressionRatio: 1.0 },
  ]);
  srv = await startBrowserTestServer({ speechToText, classifier: allConflictsClassifier });
});

test.afterEach(() => {
  srv.close();
});

// ─── Main E2E flow ───────────────────────────────────────────────────────────

test("full keyboard flow: // in Write → Space/Enter in TranscriptCheck → K/Revert/PDF in Review", async ({ page }) => {
  // Create the lecture so we have an ID to navigate to
  const lectureRes = await fetch(`${srv.url}/api/lectures`, { method: "POST" });
  const { id: lectureId } = await lectureRes.json() as { id: string };

  // ── Write: type notes and // slide marker (exercises // shortcut) ─────────
  await page.goto(`${srv.url}/#/write/${lectureId}`);
  await page.waitForSelector("[data-testid='notes-editor']");

  const editor = page.locator("[data-testid='notes-editor'] [contenteditable='true']").first();
  await editor.click();
  await editor.type("Notes before slide");
  await editor.press("Enter");
  await editor.type("//");
  await page.waitForSelector("[data-testid='slide-marker']", { timeout: 5000 });
  await page.waitForSelector("text=Saved", { timeout: 5000 });

  // ── Seed sources + transcription via API (browser typed notes are now in DB) ─
  const form = new FormData();
  form.append("subjectName", "Anatomy");
  form.append("presentation", SLIDE_PDF, { filename: "slides.pdf", contentType: "application/pdf" });
  form.append("audio1", SHORT_AUDIO, { filename: "lecture.wav", contentType: "audio/wav" });
  form.append("audio1StartTime", String(RECORDING_START));
  const sourcesRes = await fetch(`${srv.url}/api/lectures/${lectureId}/sources`, {
    method: "POST",
    headers: form.getHeaders() as Record<string, string>,
    body: form.getBuffer(),
  });
  expect(sourcesRes.ok).toBe(true);

  await fetch(`${srv.url}/api/lectures/${lectureId}/transcribe`, { method: "POST" });

  // ── TranscriptCheck: Space to play, Enter to advance ─────────────────────
  await page.goto(`${srv.url}/#/transcript-check/${lectureId}`);
  await page.waitForSelector("[data-testid='transcript-check-screen']", { timeout: 5000 });

  const audioRequests: string[] = [];
  page.on("request", (req) => { if (req.url().includes("audio-clip")) audioRequests.push(req.url()); });

  await page.keyboard.press(" ");
  await page.waitForTimeout(500);
  expect(audioRequests.length).toBeGreaterThan(0);

  // Enter advances the single sentence → merge auto-starts → navigates to review
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => window.location.hash.includes("review"),
    { timeout: 20000 },
  );

  // ── Review: K to keep conflict, Revert an addition, export PDF ───────────
  await page.waitForSelector("[data-testid='review-screen']", { timeout: 10000 });
  await page.waitForFunction(
    () => document.querySelector("[data-testid^='merged-block-']") !== null,
    { timeout: 10000 },
  );

  // K resolves first unresolved conflict
  await page.keyboard.press("k");
  await page.waitForFunction(
    () => !document.querySelector("[data-testid='keep-button']"),
    { timeout: 5000 },
  );

  // Revert the fallback addition if one is present
  const revertBtn = page.locator("[data-testid='revert-button']").first();
  if (await revertBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await revertBtn.click();
  }

  // Export PDF — button becomes enabled once all conflicts are resolved
  const exportBtn = page.locator("[data-testid='export-pdf-button']");
  await expect(exportBtn).not.toBeDisabled({ timeout: 5000 });
  await exportBtn.click();

  // Server marks lecture as exported
  const stagRes = await fetch(`${srv.url}/api/lectures/${lectureId}`);
  const updated = await stagRes.json() as { stage: string };
  expect(updated.stage).toBe("exported");
});

// ─── E shortcut ─────────────────────────────────────────────────────────────

test("E key uses the proposed rewrite on the first unresolved conflict", async ({ page }) => {
  // This test uses its own server with ScriptedClassifier so block IDs are known
  srv.close();
  const scClassifier = new ScriptedClassifier();
  const scWriting = new ScriptedWritingModel();
  srv = await startBrowserTestServer({ speechToText, classifier: scClassifier, writingModel: scWriting });

  const lectureId = await seedToReview(srv.url, scClassifier, scWriting);

  await page.goto(`${srv.url}/#/review/${lectureId}`);
  await page.waitForSelector("[data-testid='review-screen']", { timeout: 10000 });
  await page.waitForSelector("[data-testid='merged-block-conflict']", { timeout: 10000 });

  // E resolves first conflict as "edited" (applies proposedRewrite)
  await page.keyboard.press("e");
  await page.waitForFunction(
    () => !document.querySelector("[data-testid='edit-button']"),
    { timeout: 5000 },
  );

  const body = await fetch(`${srv.url}/api/lectures/${lectureId}/merged-note`)
    .then((r) => r.json() as Promise<{ blocks: MergedBlock[] }>);
  const conflict = body.blocks.find((b) => b.origin === "conflict");
  expect(conflict?.reviewState).toBe("edited");
  expect(conflict?.text).toBe("corrected note text");
});

// ─── Reopen routing ──────────────────────────────────────────────────────────

test("reopening a lecture at 'sources' stage from Library lands on Sources screen", async ({ page }) => {
  const lectureRes = await fetch(`${srv.url}/api/lectures`, { method: "POST" });
  const { id } = await lectureRes.json() as { id: string };

  const blockId = "X01";
  const t = Date.now();
  const notesData = {
    blocks: [{ id: blockId, type: "paragraph", content: [{ type: "text", text: "notes" }], children: [] }],
    meta: { [blockId]: { firstEditTime: t, lastEditTime: t } },
  };
  await fetch(`${srv.url}/api/lectures/${id}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesData: JSON.stringify(notesData) }),
  });

  const form = new FormData();
  form.append("subjectName", "Test");
  form.append("presentation", SLIDE_PDF, { filename: "slides.pdf", contentType: "application/pdf" });
  await fetch(`${srv.url}/api/lectures/${id}/sources`, {
    method: "POST",
    headers: form.getHeaders() as Record<string, string>,
    body: form.getBuffer(),
  });

  await page.goto(srv.url);
  await page.waitForSelector("[data-testid='open-lecture-button']");
  await page.click("[data-testid='open-lecture-button']");
  await page.waitForSelector("[data-testid='sources-screen']", { timeout: 5000 });
  expect(page.url()).toContain("sources");
});

test("reopening a lecture at 'transcript-check' stage from Library lands on TranscriptCheck screen", async ({ page }) => {
  const lectureRes = await fetch(`${srv.url}/api/lectures`, { method: "POST" });
  const { id } = await lectureRes.json() as { id: string };

  const blockId = "X01";
  const notesData = {
    blocks: [{ id: blockId, type: "paragraph", content: [{ type: "text", text: "notes" }], children: [] }],
    meta: { [blockId]: { firstEditTime: RECORDING_START + 500, lastEditTime: RECORDING_START + 500 } },
  };
  await fetch(`${srv.url}/api/lectures/${id}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesData: JSON.stringify(notesData) }),
  });

  const form = new FormData();
  form.append("subjectName", "Test");
  form.append("presentation", SLIDE_PDF, { filename: "slides.pdf", contentType: "application/pdf" });
  form.append("audio1", SHORT_AUDIO, { filename: "lecture.wav", contentType: "audio/wav" });
  form.append("audio1StartTime", String(RECORDING_START));
  await fetch(`${srv.url}/api/lectures/${id}/sources`, {
    method: "POST",
    headers: form.getHeaders() as Record<string, string>,
    body: form.getBuffer(),
  });
  await fetch(`${srv.url}/api/lectures/${id}/transcribe`, { method: "POST" });

  await page.goto(srv.url);
  await page.waitForSelector("[data-testid='open-lecture-button']");
  await page.click("[data-testid='open-lecture-button']");
  await page.waitForSelector("[data-testid='transcript-check-screen']", { timeout: 5000 });
  expect(page.url()).toContain("transcript-check");
});

test("reopening a lecture at 'review' stage from Library lands on Review screen", async ({ page }) => {
  srv.close();
  const scClassifier = new ScriptedClassifier();
  const scWriting = new ScriptedWritingModel();
  srv = await startBrowserTestServer({ speechToText, classifier: scClassifier, writingModel: scWriting });

  const lectureId = await seedToReview(srv.url, scClassifier, scWriting);

  await page.goto(srv.url);
  await page.waitForSelector("[data-testid='open-lecture-button']");
  await page.click("[data-testid='open-lecture-button']");
  await page.waitForSelector("[data-testid='review-screen']", { timeout: 10000 });
  expect(page.url()).toContain("review");
});

test("reopening a lecture at 'exported' stage from Library lands on Review screen", async ({ page }) => {
  srv.close();
  const scClassifier = new ScriptedClassifier();
  const scWriting = new ScriptedWritingModel();
  srv = await startBrowserTestServer({ speechToText, classifier: scClassifier, writingModel: scWriting });

  const lectureId = await seedToReview(srv.url, scClassifier, scWriting);

  // Resolve conflict and export so stage becomes 'exported'
  const body = await fetch(`${srv.url}/api/lectures/${lectureId}/merged-note`)
    .then((r) => r.json() as Promise<{ blocks: MergedBlock[] }>);
  const conflict = body.blocks.find((b) => b.origin === "conflict");
  if (conflict) {
    await fetch(`${srv.url}/api/lectures/${lectureId}/merged-note/${conflict.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewState: "kept" }),
    });
  }
  await fetch(`${srv.url}/api/lectures/${lectureId}/export/pdf`, { method: "POST" });

  await page.goto(srv.url);
  await page.waitForSelector("[data-testid='open-lecture-button']");
  await page.click("[data-testid='open-lecture-button']");
  await page.waitForSelector("[data-testid='review-screen']", { timeout: 10000 });
  expect(page.url()).toContain("review");
});
