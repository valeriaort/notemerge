import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { startBrowserTestServer } from "./helpers.js";
import type { BrowserTestServer } from "./helpers.js";
import { ScriptedSpeechToText } from "../../src/providers/fakes.js";
import FormData from "form-data";
import type { Sentence, CoverageQuestion, ConflictQuestion, CoverageAnswers, ConflictAnswers } from "../../src/shared/types.js";

const FIXTURES = path.resolve("tests/fixtures");
const SHORT_AUDIO = readFileSync(path.join(FIXTURES, "short_audio.wav"));
const RECORDING_START = 1_700_000_000_000;

// Builds a one-page PDF that pdfjs-dist can extract a title and bullet from.
function buildSlidePdf(): Buffer {
  const pages = [
    {
      texts: [
        { text: "Slide Title", y: 720, size: 24 },
        { text: "- Slide bullet", y: 670, size: 12 },
      ],
    },
  ];
  const n = pages.length;
  const numObjs = 3 + n * 2;
  const objBodies: string[] = [""];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objBodies.push(`<</Type /Catalog /Pages 2 0 R>>`);
  objBodies.push(`<</Type /Pages /Kids [${kids}] /Count ${n}>>`);
  objBodies.push(`<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>`);
  for (let i = 0; i < n; i++) {
    const contentObjNum = 5 + i * 2;
    let stream = "";
    for (const { text, y, size } of pages[i]!.texts) {
      const esc = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
      stream += `BT /F1 ${size} Tf 50 ${y} Td (${esc}) Tj ET\n`;
    }
    objBodies.push(
      `<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNum} 0 R /Resources <</Font <</F1 3 0 R>>>>>>`,
    );
    objBodies.push(`<</Length ${stream.length}>>\nstream\n${stream}endstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = new Array(numObjs + 1).fill(0) as number[];
  for (let i = 1; i <= numObjs; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objBodies[i]}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${numObjs + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= numObjs; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<</Size ${numObjs + 1} /Root 1 0 R>>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

const SLIDE_PDF = buildSlidePdf();

// Classifier that marks all transcript sentences as missing (key contains "-T")
// and returns "covered" for slide bullets. This produces fallback addition blocks
// with transcript citations in the merged note.
const transcriptMissingClassifier = {
  async classifyCoverage(_state: string, questions: CoverageQuestion[]): Promise<CoverageAnswers> {
    const answers: CoverageAnswers = {};
    for (const q of questions) {
      // Transcript sentence keys look like: coverage:A01-T0001
      if (q.key.includes("-T")) {
        answers[q.key] = { label: "missing", probability: 0.98 };
      } else {
        answers[q.key] = { label: "covered", probability: 0.99 };
      }
    }
    return answers;
  },
  async checkConflicts(_state: string, questions: ConflictQuestion[]): Promise<ConflictAnswers> {
    const answers: ConflictAnswers = {};
    for (const q of questions) {
      answers[q.key] = { label: "supported", probability: 0.99 };
    }
    return answers;
  },
};

// Classifier that marks all slide bullets as missing — produces slide-only citations
const slideMissingClassifier = {
  async classifyCoverage(_state: string, questions: CoverageQuestion[]): Promise<CoverageAnswers> {
    const answers: CoverageAnswers = {};
    for (const q of questions) {
      // Slide bullet keys look like: coverage:S001-B01
      if (q.key.includes("-B")) {
        answers[q.key] = { label: "missing", probability: 0.98 };
      } else {
        answers[q.key] = { label: "covered", probability: 0.99 };
      }
    }
    return answers;
  },
  async checkConflicts(_state: string, questions: ConflictQuestion[]): Promise<ConflictAnswers> {
    const answers: ConflictAnswers = {};
    for (const q of questions) {
      answers[q.key] = { label: "supported", probability: 0.99 };
    }
    return answers;
  },
};

async function seedReviewLectureWithAudio(apiUrl: string): Promise<string> {
  const lectureRes = await fetch(`${apiUrl}/api/lectures`, { method: "POST" });
  const lecture = await lectureRes.json() as { id: string };

  const subjectRes = await fetch(`${apiUrl}/api/subjects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test Subject" }),
  });
  const subject = await subjectRes.json() as { id: string };

  const blockId = "b1";
  // firstEditTime = RECORDING_START so the sentence at clockStartTimeMs = RECORDING_START is in-window.
  // lastEditTime far enough to create a non-zero window duration.
  const notesData = {
    blocks: [{ id: blockId, type: "paragraph", content: [{ type: "text", text: "notes" }], children: [] }],
    meta: { [blockId]: { firstEditTime: RECORDING_START, lastEditTime: RECORDING_START + 5 * 60 * 1000 } },
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

  // Skip transcript check → auto-starts merge → goes to review stage
  await fetch(`${apiUrl}/api/lectures/${lecture.id}/transcript-check/skip`, { method: "POST" });

  return lecture.id;
}

async function seedReviewLectureWithoutAudio(apiUrl: string): Promise<string> {
  const lectureRes = await fetch(`${apiUrl}/api/lectures`, { method: "POST" });
  const lecture = await lectureRes.json() as { id: string };

  const blockId = "b1";
  const t = Date.now();
  const notesData = {
    blocks: [{ id: blockId, type: "paragraph", content: [{ type: "text", text: "notes" }], children: [] }],
    meta: { [blockId]: { firstEditTime: t, lastEditTime: t + 5 * 60 * 1000 } },
  };
  await fetch(`${apiUrl}/api/lectures/${lecture.id}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesData: JSON.stringify(notesData) }),
  });

  const form = new FormData();
  form.append("subjectName", "Test Subject");
  form.append("presentation", SLIDE_PDF, { filename: "slides.pdf", contentType: "application/pdf" });
  const headers = form.getHeaders() as Record<string, string>;
  await fetch(`${apiUrl}/api/lectures/${lecture.id}/sources`, {
    method: "POST",
    headers,
    body: form.getBuffer(),
  });

  await fetch(`${apiUrl}/api/lectures/${lecture.id}/merge`, { method: "POST" });

  return lecture.id;
}

let srv: BrowserTestServer;
let speechToText: ScriptedSpeechToText;

test.beforeEach(async () => {
  speechToText = new ScriptedSpeechToText();
  speechToText.setDefaultSegments([
    { startMs: 0, endMs: 2000, text: "Posible error auditivo.", avgLogprob: -1.5, noSpeechProb: 0.1, compressionRatio: 1.0 },
  ]);
});

test.afterEach(() => {
  srv.close();
});

test("play button appears for transcript-citing blocks in a lecture with audio", async ({ page }) => {
  srv = await startBrowserTestServer({
    speechToText,
    classifier: transcriptMissingClassifier,
  });

  const lectureId = await seedReviewLectureWithAudio(srv.url);

  await page.goto(`${srv.url}/#/review/${lectureId}`);
  await page.waitForSelector("[data-testid='merged-block-fallback'], [data-testid='merged-block-addition']", { timeout: 10000 });

  // At least one play button should be present for the transcript-citing addition
  const playButtons = page.locator("[data-testid='review-play-button']");
  await expect(playButtons.first()).toBeVisible({ timeout: 5000 });
});

test("play button does not appear for student blocks (origin=student)", async ({ page }) => {
  srv = await startBrowserTestServer({
    speechToText,
    classifier: transcriptMissingClassifier,
  });

  const lectureId = await seedReviewLectureWithAudio(srv.url);

  await page.goto(`${srv.url}/#/review/${lectureId}`);
  await page.waitForSelector("[data-testid='merged-block-student']", { timeout: 10000 });

  // Student blocks (no citations) must not show a play button
  const studentBlock = page.locator("[data-testid='merged-block-student']");
  const playInStudentBlock = studentBlock.locator("[data-testid='review-play-button']");
  await expect(playInStudentBlock).toHaveCount(0);
});

test("play button does not appear for slide-only citation blocks", async ({ page }) => {
  srv = await startBrowserTestServer({
    speechToText,
    classifier: slideMissingClassifier,
  });

  const lectureId = await seedReviewLectureWithAudio(srv.url);

  await page.goto(`${srv.url}/#/review/${lectureId}`);
  // Wait for fallback/addition blocks (slide bullet marked missing → fallback block appears)
  await page.waitForSelector("[data-testid='merged-block-fallback'], [data-testid='merged-block-addition']", { timeout: 10000 });

  // Slide-only citations must not show a play button
  const playButtons = page.locator("[data-testid='review-play-button']");
  await expect(playButtons).toHaveCount(0);
});

test("play button does not appear when lecture has no audio", async ({ page }) => {
  srv = await startBrowserTestServer({
    classifier: slideMissingClassifier,
  });

  const lectureId = await seedReviewLectureWithoutAudio(srv.url);

  await page.goto(`${srv.url}/#/review/${lectureId}`);
  // Wait for the page to load and blocks to render
  await page.waitForFunction(
    () => document.querySelector("[data-testid^='merged-block-']") !== null,
    { timeout: 10000 },
  );

  // No play button should appear in a lecture without audio
  const playButtons = page.locator("[data-testid='review-play-button']");
  await expect(playButtons).toHaveCount(0);
});
