import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { readFileSync } from "fs";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture, Subject, Sentence, MergeRun } from "../../src/shared/types.js";
import { ScriptedSpeechToText, ScriptedClassifier, ScriptedWritingModel } from "../../src/providers/fakes.js";
import FormData from "form-data";

const FIXTURES = path.resolve("tests/fixtures");
const SHORT_AUDIO = readFileSync(path.join(FIXTURES, "short_audio.wav"));
const TEST_TIMEOUT = 30_000;
const RECORDING_START = 1_700_000_000_000;

// Minimal single-slide PDF for merge to have slides
function buildMinimalSlidePdf(): Buffer {
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

const SLIDE_PDF = buildMinimalSlidePdf();

// Helper: create lecture + transcribe with one flagged sentence and a presentation
async function setupFlaggedLecture(
  server: TestServer,
  speechToText: ScriptedSpeechToText,
): Promise<{ lecture: Lecture; subject: Subject }> {
  // avgLogprob < -1.0 triggers the flag
  speechToText.setDefaultSegments([
    { startMs: 0, endMs: 2000, text: "Posible error auditivo.", avgLogprob: -1.5, noSpeechProb: 0.1, compressionRatio: 1.0 },
  ]);

  const lectureRes = await fetch(`${server.url}/api/lectures`, { method: "POST" });
  const lecture = await lectureRes.json() as Lecture;

  const subjectRes = await fetch(`${server.url}/api/subjects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Anatomy" }),
  });
  const subject = await subjectRes.json() as Subject;

  const blockId = "test-block-1";
  const notesData = {
    blocks: [{ id: blockId, type: "paragraph", content: [{ type: "text", text: "notes" }], children: [] }],
    meta: { [blockId]: { firstEditTime: RECORDING_START + 500, lastEditTime: RECORDING_START + 500 } },
  };
  await fetch(`${server.url}/api/lectures/${lecture.id}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesData: JSON.stringify(notesData) }),
  });

  const form = new FormData();
  form.append("subjectId", subject.id);
  form.append("presentation", SLIDE_PDF, { filename: "slides.pdf", contentType: "application/pdf" });
  form.append("audio1", SHORT_AUDIO, { filename: "lecture.wav", contentType: "audio/wav" });
  form.append("audio1StartTime", String(RECORDING_START));
  await fetch(`${server.url}/api/lectures/${lecture.id}/sources`, {
    method: "POST",
    headers: form.getHeaders() as Record<string, string>,
    body: form.getBuffer(),
  });

  await fetch(`${server.url}/api/lectures/${lecture.id}/transcribe`, { method: "POST" });

  return { lecture, subject };
}

describe("GET /transcript-check — queue status", () => {
  let speechToText: ScriptedSpeechToText;
  let server: TestServer;

  beforeEach(async () => {
    speechToText = new ScriptedSpeechToText();
    server = await startTestServer({ speechToText });
  });
  afterEach(() => server.close());

  it("returns flagged sentences in the queue", async () => {
    const { lecture } = await setupFlaggedLecture(server, speechToText);

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    expect(res.status).toBe(200);
    const body = await res.json() as { queue: Sentence[]; handled: number; total: number };
    expect(body.queue).toHaveLength(1);
    expect(body.queue[0]!.flagState).toBe("flagged_unhandled");
    expect(body.total).toBe(1);
    expect(body.handled).toBe(0);
  }, TEST_TIMEOUT);

  it("returns empty queue when no flagged sentences", async () => {
    // Good sentence — no flags (terms match what's in notes so no unknown-medical-term flag)
    speechToText.setDefaultSegments([
      { startMs: 500, endMs: 2000, text: "El cielo es azul.", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    const lectureRes = await fetch(`${server.url}/api/lectures`, { method: "POST" });
    const lecture = await lectureRes.json() as Lecture;
    const subjectRes = await fetch(`${server.url}/api/subjects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test" }),
    });
    const subject = await subjectRes.json() as Subject;
    const blockId = "b1";
    // Notes contain the sentence terms so mini glossary is seeded
    const notesData = {
      blocks: [{ id: blockId, type: "paragraph", content: [{ type: "text", text: "El cielo es azul" }], children: [] }],
      meta: { [blockId]: { firstEditTime: RECORDING_START + 500, lastEditTime: RECORDING_START + 500 } },
    };
    await fetch(`${server.url}/api/lectures/${lecture.id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notesData: JSON.stringify(notesData) }),
    });
    const form = new FormData();
    form.append("subjectId", subject.id);
    form.append("audio1", SHORT_AUDIO, { filename: "lecture.wav", contentType: "audio/wav" });
    form.append("audio1StartTime", String(RECORDING_START));
    await fetch(`${server.url}/api/lectures/${lecture.id}/sources`, {
      method: "POST",
      headers: form.getHeaders() as Record<string, string>,
      body: form.getBuffer(),
    });
    await fetch(`${server.url}/api/lectures/${lecture.id}/transcribe`, { method: "POST" });

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    expect(res.status).toBe(200);
    const body = await res.json() as { queue: Sentence[]; total: number };
    expect(body.queue).toHaveLength(0);
    expect(body.total).toBe(0);
  }, TEST_TIMEOUT);

  it("returns 409 when lecture is not in transcript-check stage", async () => {
    const lectureRes = await fetch(`${server.url}/api/lectures`, { method: "POST" });
    const lecture = await lectureRes.json() as Lecture;
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    expect(res.status).toBe(409);
  });
});

describe("PATCH /sentences/:sentenceId — advance", () => {
  let speechToText: ScriptedSpeechToText;
  let server: TestServer;

  beforeEach(async () => {
    speechToText = new ScriptedSpeechToText();
    server = await startTestServer({ speechToText });
  });
  afterEach(() => server.close());

  it("advance sets flagState to advanced", async () => {
    const { lecture } = await setupFlaggedLecture(server, speechToText);

    // Get the flagged sentence
    const checkRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    const { queue } = await checkRes.json() as { queue: Sentence[] };
    const sentenceId = queue[0]!.id;

    // Advance it
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences/${sentenceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "advance" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { sentence: Sentence };
    expect(body.sentence.flagState).toBe("advanced");
    expect(body.sentence.correctedText).toBeNull();
  }, TEST_TIMEOUT);

  it("advanced sentence is removed from the queue (partial: 2 flags, advance 1)", async () => {
    // Set 2 flagged segments before creating the lecture
    speechToText.setDefaultSegments([
      { startMs: 0, endMs: 1000, text: "Primera duda.", avgLogprob: -1.5, noSpeechProb: 0.1, compressionRatio: 1.0 },
      { startMs: 1000, endMs: 2000, text: "Segunda duda.", avgLogprob: -1.5, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    // Create lecture manually so speechToText segments aren't overwritten by setupFlaggedLecture
    const lectureRes = await fetch(`${server.url}/api/lectures`, { method: "POST" });
    const lecture = await lectureRes.json() as Lecture;
    const subjectRes = await fetch(`${server.url}/api/subjects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test" }),
    });
    const subject = await subjectRes.json() as Subject;
    const blockId = "b1";
    const notesData = {
      blocks: [{ id: blockId, type: "paragraph", content: [{ type: "text", text: "notas" }], children: [] }],
      meta: { [blockId]: { firstEditTime: RECORDING_START + 500, lastEditTime: RECORDING_START + 500 } },
    };
    await fetch(`${server.url}/api/lectures/${lecture.id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notesData: JSON.stringify(notesData) }),
    });
    const form = new FormData();
    form.append("subjectId", subject.id);
    form.append("audio1", SHORT_AUDIO, { filename: "lecture.wav", contentType: "audio/wav" });
    form.append("audio1StartTime", String(RECORDING_START));
    await fetch(`${server.url}/api/lectures/${lecture.id}/sources`, {
      method: "POST",
      headers: form.getHeaders() as Record<string, string>,
      body: form.getBuffer(),
    });
    await fetch(`${server.url}/api/lectures/${lecture.id}/transcribe`, { method: "POST" });

    const checkRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    const { queue } = await checkRes.json() as { queue: Sentence[] };
    expect(queue).toHaveLength(2);
    const sentenceId = queue[0]!.id;

    const advRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences/${sentenceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "advance" }),
    });
    const advBody = await advRes.json() as { mergeStarted: boolean };
    // Queue not yet empty — merge not started
    expect(advBody.mergeStarted).toBe(false);

    const check2Res = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    const { queue: queue2, handled } = await check2Res.json() as { queue: Sentence[]; handled: number };
    expect(queue2).toHaveLength(1);
    expect(handled).toBe(1);
  }, TEST_TIMEOUT);

  it("returns 409 when sentence is not flagged_unhandled", async () => {
    const { lecture } = await setupFlaggedLecture(server, speechToText);

    const checkRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    const { queue } = await checkRes.json() as { queue: Sentence[] };
    const sentenceId = queue[0]!.id;

    // Advance once
    await fetch(`${server.url}/api/lectures/${lecture.id}/sentences/${sentenceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "advance" }),
    });

    // Try again
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences/${sentenceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "advance" }),
    });
    expect(res.status).toBe(409);
  }, TEST_TIMEOUT);
});

describe("PATCH /sentences/:sentenceId — correct", () => {
  let speechToText: ScriptedSpeechToText;
  let server: TestServer;

  beforeEach(async () => {
    speechToText = new ScriptedSpeechToText();
    server = await startTestServer({ speechToText });
  });
  afterEach(() => server.close());

  it("correct sets flagState to corrected and stores correctedText", async () => {
    const { lecture } = await setupFlaggedLecture(server, speechToText);

    const checkRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    const { queue } = await checkRes.json() as { queue: Sentence[] };
    const sentenceId = queue[0]!.id;

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences/${sentenceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "correct", correctedText: "Corrección manual del texto." }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { sentence: Sentence };
    expect(body.sentence.flagState).toBe("corrected");
    expect(body.sentence.correctedText).toBe("Corrección manual del texto.");
  }, TEST_TIMEOUT);

  it("corrected text is persisted and survives a re-fetch", async () => {
    const { lecture } = await setupFlaggedLecture(server, speechToText);

    const checkRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    const { queue } = await checkRes.json() as { queue: Sentence[] };
    const sentenceId = queue[0]!.id;

    await fetch(`${server.url}/api/lectures/${lecture.id}/sentences/${sentenceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "correct", correctedText: "Texto corregido persistente." }),
    });

    // Verify via sentences endpoint
    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const { sentences } = await sentRes.json() as { sentences: Sentence[] };
    const s = sentences.find((s) => s.id === sentenceId);
    expect(s).toBeDefined();
    expect(s!.correctedText).toBe("Texto corregido persistente.");
    expect(s!.flagState).toBe("corrected");
  }, TEST_TIMEOUT);

  it("returns 400 when correctedText is missing", async () => {
    const { lecture } = await setupFlaggedLecture(server, speechToText);

    const checkRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    const { queue } = await checkRes.json() as { queue: Sentence[] };
    const sentenceId = queue[0]!.id;

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences/${sentenceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "correct" }),
    });
    expect(res.status).toBe(400);
  }, TEST_TIMEOUT);
});

describe("merge auto-starts when queue is empty", () => {
  let speechToText: ScriptedSpeechToText;
  let server: TestServer;

  beforeEach(async () => {
    speechToText = new ScriptedSpeechToText();
    const classifier = new ScriptedClassifier();
    const writingModel = new ScriptedWritingModel();
    server = await startTestServer({ speechToText, classifier, writingModel });
  });
  afterEach(() => server.close());

  it("advancing the last flag auto-starts the merge and returns mergeRun", async () => {
    const { lecture } = await setupFlaggedLecture(server, speechToText);

    const checkRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    const { queue } = await checkRes.json() as { queue: Sentence[] };
    const sentenceId = queue[0]!.id;

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences/${sentenceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "advance" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { sentence: Sentence; mergeStarted: boolean; mergeRun?: MergeRun };
    expect(body.mergeStarted).toBe(true);
    expect(body.mergeRun).toBeDefined();
    expect(body.mergeRun!.state).toBe("done");
  }, TEST_TIMEOUT);

  it("lecture stage becomes review after merge auto-starts", async () => {
    const { lecture } = await setupFlaggedLecture(server, speechToText);

    const checkRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    const { queue } = await checkRes.json() as { queue: Sentence[] };
    const sentenceId = queue[0]!.id;

    await fetch(`${server.url}/api/lectures/${lecture.id}/sentences/${sentenceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "advance" }),
    });

    const lectureRes = await fetch(`${server.url}/api/lectures/${lecture.id}`);
    const updated = await lectureRes.json() as Lecture;
    expect(updated.stage).toBe("review");
  }, TEST_TIMEOUT);
});

describe("POST /transcript-check/skip", () => {
  let speechToText: ScriptedSpeechToText;
  let server: TestServer;

  beforeEach(async () => {
    speechToText = new ScriptedSpeechToText();
    const classifier = new ScriptedClassifier();
    const writingModel = new ScriptedWritingModel();
    server = await startTestServer({ speechToText, classifier, writingModel });
  });
  afterEach(() => server.close());

  it("skip starts the merge and returns mergeRun", async () => {
    const { lecture } = await setupFlaggedLecture(server, speechToText);

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check/skip`, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { mergeRun: MergeRun };
    expect(body.mergeRun).toBeDefined();
    expect(body.mergeRun.state).toBe("done");
  }, TEST_TIMEOUT);

  it("skipped flags retain flagged_unhandled state", async () => {
    const { lecture } = await setupFlaggedLecture(server, speechToText);

    // Get flagged sentence
    const checkRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    const { queue } = await checkRes.json() as { queue: Sentence[] };
    const sentenceId = queue[0]!.id;

    await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check/skip`, { method: "POST" });

    // Sentence should still be flagged_unhandled
    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const { sentences } = await sentRes.json() as { sentences: Sentence[] };
    const s = sentences.find((s) => s.id === sentenceId);
    expect(s).toBeDefined();
    expect(s!.flagState).toBe("flagged_unhandled");
  }, TEST_TIMEOUT);

  it("skip with no flags still starts the merge", async () => {
    // Lecture with no flags
    speechToText.setDefaultSegments([
      { startMs: 0, endMs: 2000, text: "Oración normal.", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    const lectureRes = await fetch(`${server.url}/api/lectures`, { method: "POST" });
    const lecture = await lectureRes.json() as Lecture;
    const subjectRes = await fetch(`${server.url}/api/subjects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test" }),
    });
    const subject = await subjectRes.json() as Subject;
    const blockId = "b1";
    const notesData = {
      blocks: [{ id: blockId, type: "paragraph", content: [{ type: "text", text: "notas" }], children: [] }],
      meta: { [blockId]: { firstEditTime: RECORDING_START + 500, lastEditTime: RECORDING_START + 500 } },
    };
    await fetch(`${server.url}/api/lectures/${lecture.id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notesData: JSON.stringify(notesData) }),
    });
    const form = new FormData();
    form.append("subjectId", subject.id);
    form.append("presentation", SLIDE_PDF, { filename: "slides.pdf", contentType: "application/pdf" });
    form.append("audio1", SHORT_AUDIO, { filename: "lecture.wav", contentType: "audio/wav" });
    form.append("audio1StartTime", String(RECORDING_START));
    await fetch(`${server.url}/api/lectures/${lecture.id}/sources`, {
      method: "POST",
      headers: form.getHeaders() as Record<string, string>,
      body: form.getBuffer(),
    });
    await fetch(`${server.url}/api/lectures/${lecture.id}/transcribe`, { method: "POST" });

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check/skip`, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { mergeRun: MergeRun };
    expect(body.mergeRun.state).toBe("done");
  }, TEST_TIMEOUT);

  it("returns 409 when lecture is not in transcript-check stage", async () => {
    const lectureRes = await fetch(`${server.url}/api/lectures`, { method: "POST" });
    const lecture = await lectureRes.json() as Lecture;
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check/skip`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });
});

describe("flag handling state persisted", () => {
  let speechToText: ScriptedSpeechToText;
  let server: TestServer;

  beforeEach(async () => {
    speechToText = new ScriptedSpeechToText();
    server = await startTestServer({ speechToText });
  });
  afterEach(() => server.close());

  it("advanced flag state persists across re-fetch", async () => {
    const { lecture } = await setupFlaggedLecture(server, speechToText);

    const checkRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    const { queue } = await checkRes.json() as { queue: Sentence[] };
    const sentenceId = queue[0]!.id;

    // Advance the flag
    await fetch(`${server.url}/api/lectures/${lecture.id}/sentences/${sentenceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "advance" }),
    });

    // Re-fetch sentences — flag state should be persisted
    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const { sentences } = await sentRes.json() as { sentences: Sentence[] };
    const s = sentences.find((s) => s.id === sentenceId);
    expect(s!.flagState).toBe("advanced");
  }, TEST_TIMEOUT);

  it("partial progress is resumable: handled count reflects already-advanced flags", async () => {
    // Create a lecture with 2 flagged sentences
    speechToText.setDefaultSegments([
      { startMs: 0, endMs: 1000, text: "Primera oración dudosa.", avgLogprob: -1.5, noSpeechProb: 0.1, compressionRatio: 1.0 },
      { startMs: 1000, endMs: 2000, text: "Segunda oración dudosa.", avgLogprob: -1.5, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    const lectureRes = await fetch(`${server.url}/api/lectures`, { method: "POST" });
    const lecture = await lectureRes.json() as Lecture;
    const subjectRes = await fetch(`${server.url}/api/subjects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test" }),
    });
    const subject = await subjectRes.json() as Subject;
    const blockId = "b1";
    const notesData = {
      blocks: [{ id: blockId, type: "paragraph", content: [{ type: "text", text: "notas" }], children: [] }],
      meta: { [blockId]: { firstEditTime: RECORDING_START + 500, lastEditTime: RECORDING_START + 500 } },
    };
    await fetch(`${server.url}/api/lectures/${lecture.id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notesData: JSON.stringify(notesData) }),
    });
    const form = new FormData();
    form.append("subjectId", subject.id);
    form.append("audio1", SHORT_AUDIO, { filename: "lecture.wav", contentType: "audio/wav" });
    form.append("audio1StartTime", String(RECORDING_START));
    await fetch(`${server.url}/api/lectures/${lecture.id}/sources`, {
      method: "POST",
      headers: form.getHeaders() as Record<string, string>,
      body: form.getBuffer(),
    });
    await fetch(`${server.url}/api/lectures/${lecture.id}/transcribe`, { method: "POST" });

    // Should have 2 flags
    const check1 = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    const { queue: queue1, total } = await check1.json() as { queue: Sentence[]; total: number };
    expect(total).toBe(2);
    expect(queue1).toHaveLength(2);

    // Advance one
    const firstId = queue1[0]!.id;
    await fetch(`${server.url}/api/lectures/${lecture.id}/sentences/${firstId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "advance" }),
    });

    // Queue should now have 1 remaining, 1 handled
    const check2 = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    const { queue: queue2, handled } = await check2.json() as { queue: Sentence[]; handled: number };
    expect(queue2).toHaveLength(1);
    expect(handled).toBe(1);
  }, TEST_TIMEOUT);
});

describe("audio-clip endpoint", () => {
  let speechToText: ScriptedSpeechToText;
  let server: TestServer;

  beforeEach(async () => {
    speechToText = new ScriptedSpeechToText();
    server = await startTestServer({ speechToText });
  });
  afterEach(() => server.close());

  it("returns audio bytes for a flagged sentence", async () => {
    const { lecture } = await setupFlaggedLecture(server, speechToText);

    const checkRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcript-check`);
    const { queue } = await checkRes.json() as { queue: Sentence[] };
    const sentenceId = queue[0]!.id;

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences/${sentenceId}/audio-clip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("audio/");

    const sentStartMs = res.headers.get("x-sentence-start-ms");
    expect(sentStartMs).not.toBeNull();
    expect(Number(sentStartMs)).toBeGreaterThanOrEqual(0);
  }, TEST_TIMEOUT);
});
