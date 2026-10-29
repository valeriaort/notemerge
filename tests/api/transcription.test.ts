import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { readFileSync } from "fs";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture, Subject, Sentence, TranscriptRun } from "../../src/shared/types.js";
import { ScriptedSpeechToText } from "../../src/providers/fakes.js";
import FormData from "form-data";

const FIXTURES = path.resolve("tests/fixtures");
const SHORT_AUDIO = readFileSync(path.join(FIXTURES, "short_audio.wav"));

// Minimal single-page presentation PDF
const MINIMAL_PDF = Buffer.from(
  "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
);
void MINIMAL_PDF; // referenced by upload helpers in other tests

const TEST_TIMEOUT = 30_000;

// Stable epoch used as recording start for predictable chunk clock ranges
const RECORDING_START = 1_700_000_000_000;

let server: TestServer;

async function createLecture(): Promise<Lecture> {
  const res = await fetch(`${server.url}/api/lectures`, { method: "POST" });
  return res.json() as Promise<Lecture>;
}

async function createSubject(name: string): Promise<Subject> {
  const res = await fetch(`${server.url}/api/subjects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return res.json() as Promise<Subject>;
}

async function putNotes(lectureId: string, notesData: object): Promise<void> {
  await fetch(`${server.url}/api/lectures/${lectureId}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesData: JSON.stringify(notesData) }),
  });
}

async function uploadAudio(lectureId: string, subjectId: string, recordingStartMs: number): Promise<void> {
  const form = new FormData();
  form.append("subjectId", subjectId);
  form.append("audio1", SHORT_AUDIO, { filename: "lecture.wav", contentType: "audio/wav" });
  form.append("audio1StartTime", String(recordingStartMs));
  await fetch(`${server.url}/api/lectures/${lectureId}/sources`, {
    method: "POST",
    headers: form.getHeaders() as Record<string, string>,
    body: form.getBuffer(),
  });
}

async function triggerTranscription(
  lectureId: string,
): Promise<{ status: number; body: { transcriptRun?: TranscriptRun; error?: string } }> {
  const res = await fetch(`${server.url}/api/lectures/${lectureId}/transcribe`, {
    method: "POST",
  });
  const body = await res.json() as { transcriptRun?: TranscriptRun; error?: string };
  return { status: res.status, body };
}

// Build a notes document with one block in the chunk's clock range.
// SHORT_AUDIO is 10s; chunk covers [RECORDING_START, RECORDING_START+10000).
function notesWithBlockInRange(termText: string): object {
  const blockId = "test-block-1";
  return {
    blocks: [
      { id: blockId, type: "paragraph", content: [{ type: "text", text: termText }], children: [] },
    ],
    meta: {
      [blockId]: { firstEditTime: RECORDING_START + 5000, lastEditTime: RECORDING_START + 5000 },
    },
  };
}

// Build a notes document with no blocks in the chunk's clock range.
// The block has no firstEditTime so it doesn't contribute to lecture bounds.
function notesWithNoBlockInRange(): object {
  const blockId = "test-block-2";
  return {
    blocks: [
      { id: blockId, type: "paragraph", content: [{ type: "text", text: "some text" }], children: [] },
    ],
    meta: {},
  };
}

// ── Prompt selection ──────────────────────────────────────────────────────────

describe("prompt selection", () => {
  let speechToText: ScriptedSpeechToText;

  beforeEach(async () => {
    speechToText = new ScriptedSpeechToText();
    server = await startTestServer({ speechToText });
  });

  afterEach(() => server.close());

  it("uses mini glossary when notes exist in chunk's time range", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");
    // "cóndilo" is retained as an anatomic term by retainTerms
    await putNotes(lecture.id, notesWithBlockInRange("cóndilo mandibular"));
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    await triggerTranscription(lecture.id);

    expect(speechToText.capturedPrompts.length).toBeGreaterThan(0);
    const prompt = speechToText.capturedPrompts[0]!.prompt;
    expect(prompt).not.toBe("");
    expect(prompt).toContain("cóndilo");
  }, TEST_TIMEOUT);

  it("falls back to subject glossary when no notes in chunk's time range", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");

    server.db
      .prepare("UPDATE subjects SET glossary_terms = ? WHERE id = ?")
      .run(JSON.stringify(["periodontitis", "osificación"]), subject.id);

    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    await triggerTranscription(lecture.id);

    const prompt = speechToText.capturedPrompts[0]!.prompt;
    expect(prompt).toContain("periodontitis");
  }, TEST_TIMEOUT);

  it("uses empty prompt when no notes in range and no subject glossary", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    await triggerTranscription(lecture.id);

    expect(speechToText.capturedPrompts[0]!.prompt).toBe("");
  }, TEST_TIMEOUT);

  it("caps prompt at 224 words", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");

    const manyTerms = Array.from({ length: 400 }, (_, i) => `glossaryterm${i}`);
    server.db
      .prepare("UPDATE subjects SET glossary_terms = ? WHERE id = ?")
      .run(JSON.stringify(manyTerms), subject.id);

    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    await triggerTranscription(lecture.id);

    const prompt = speechToText.capturedPrompts[0]!.prompt;
    const wordCount = prompt.split(/\s+/).filter(Boolean).length;
    expect(wordCount).toBeLessThanOrEqual(224);
    expect(wordCount).toBeGreaterThan(0);
  }, TEST_TIMEOUT);
});

// ── Sentence IDs and metrics ──────────────────────────────────────────────────

describe("sentence IDs and metrics", () => {
  let speechToText: ScriptedSpeechToText;

  beforeEach(async () => {
    speechToText = new ScriptedSpeechToText();
    server = await startTestServer({ speechToText });
  });

  afterEach(() => server.close());

  it("produces sentence IDs continuous across all chunks with A##-T#### format", async () => {
    speechToText.setDefaultSegments([
      { startMs: 0, endMs: 2000, text: "Primera oración.", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
      { startMs: 2000, endMs: 4000, text: "Segunda oración.", avgLogprob: -0.4, noSpeechProb: 0.2, compressionRatio: 1.1 },
    ]);

    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    const { status } = await triggerTranscription(lecture.id);
    expect(status).toBe(201);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const sentBody = await sentRes.json() as { sentences: Array<Sentence & { windowId: string | null }> };

    const ids = sentBody.sentences.map((s) => s.id);
    expect(ids).toContain("A01-T0001");
    expect(ids).toContain("A01-T0002");
    for (let i = 0; i < ids.length; i++) {
      expect(ids[i]).toBe(`A01-T${String(i + 1).padStart(4, "0")}`);
    }
  }, TEST_TIMEOUT);

  it("assigns worst-of-overlapped-segments metrics to sentences", async () => {
    // Two segments with no terminal punct on first → one combined sentence
    speechToText.setDefaultSegments([
      { startMs: 0, endMs: 1000, text: "Primera parte", avgLogprob: -0.2, noSpeechProb: 0.05, compressionRatio: 1.0 },
      { startMs: 1000, endMs: 2000, text: " segunda parte.", avgLogprob: -0.8, noSpeechProb: 0.4, compressionRatio: 1.5 },
    ]);

    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    await triggerTranscription(lecture.id);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const sentBody = await sentRes.json() as { sentences: Sentence[] };

    expect(sentBody.sentences).toHaveLength(1);
    const sent = sentBody.sentences[0]!;
    // Worst avgLogprob = min(-0.2, -0.8) = -0.8
    expect(sent.avgLogprob).toBeCloseTo(-0.8);
    // Worst noSpeechProb = max(0.05, 0.4) = 0.4
    expect(sent.noSpeechProb).toBeCloseTo(0.4);
    // Worst compressionRatio = max(1.0, 1.5) = 1.5
    expect(sent.compressionRatio).toBeCloseTo(1.5);
    expect(sent.audioStartOffsetMs).toBe(0);
    expect(sent.clockStartTimeMs).toBe(RECORDING_START + 0);
  }, TEST_TIMEOUT);
});

// ── Window assignment ─────────────────────────────────────────────────────────

describe("sentence window assignment", () => {
  beforeEach(async () => {
    const speechToText = new ScriptedSpeechToText();
    speechToText.setDefaultSegments([
      { startMs: 3000, endMs: 5000, text: "Una oración.", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    server = await startTestServer({ speechToText });
  });

  afterEach(() => server.close());

  it("assigns sentence to window containing its clock start time", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());

    // Add a marker at RECORDING_START + 5000 — splits into two windows
    await fetch(`${server.url}/api/lectures/${lecture.id}/markers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timestamp: RECORDING_START + 5000, blockId: "block-marker" }),
    });

    await uploadAudio(lecture.id, subject.id, RECORDING_START);
    await triggerTranscription(lecture.id);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const sentBody = await sentRes.json() as {
      sentences: Array<Sentence & { windowId: string | null }>;
      windows: Array<{ id: string; startMs: number; endMs: number }>;
    };

    expect(sentBody.sentences).toHaveLength(1);
    const sent = sentBody.sentences[0]!;
    expect(sent.windowId).not.toBeNull();

    // Sentence at RECORDING_START+3000 belongs to the first window (ends at RECORDING_START+5000)
    const win = sentBody.windows.find((w) => w.id === sent.windowId);
    expect(win).toBeDefined();
    expect(win!.startMs).toBeLessThanOrEqual(RECORDING_START + 3000);
    expect(win!.endMs).toBeGreaterThan(RECORDING_START + 3000);
  }, TEST_TIMEOUT);
});

// ── Stage and persistence ─────────────────────────────────────────────────────

describe("stage and persistence", () => {
  beforeEach(async () => {
    server = await startTestServer({ speechToText: new ScriptedSpeechToText() });
  });

  afterEach(() => server.close());

  it("stage becomes transcript-check after all chunks succeed", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    const { status, body } = await triggerTranscription(lecture.id);
    expect(status).toBe(201);
    expect(body.transcriptRun!.state).toBe("done");

    const updatedLecture = await fetch(`${server.url}/api/lectures/${lecture.id}`).then((r) => r.json()) as Lecture;
    expect(updatedLecture.stage).toBe("transcript-check");
  }, TEST_TIMEOUT);

  it("transcript run records the model from config", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    const { body } = await triggerTranscription(lecture.id);
    expect(body.transcriptRun!.model).toBe("whisper-large-v3");
  }, TEST_TIMEOUT);

  it("GET /transcribe returns existing run after transcription", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    await triggerTranscription(lecture.id);

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/transcribe`);
    expect(res.status).toBe(200);
    const body = await res.json() as { transcriptRun: TranscriptRun };
    expect(body.transcriptRun.state).toBe("done");
  }, TEST_TIMEOUT);

  it("POST /transcribe on non-sealed lecture returns 409", async () => {
    const lecture = await createLecture();
    const { status } = await triggerTranscription(lecture.id);
    expect(status).toBe(409);
  });

  it("GET /transcribe before any run returns 404", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/transcribe`);
    expect(res.status).toBe(404);
  }, TEST_TIMEOUT);

  it("sentences are persisted with textRaw, text, status and flagState", async () => {
    const speechToText = new ScriptedSpeechToText();
    speechToText.setDefaultSegments([
      { startMs: 1000, endMs: 3000, text: "Contenido del audio.", avgLogprob: -0.5, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    server.close();
    server = await startTestServer({ speechToText });

    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    await triggerTranscription(lecture.id);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    expect(sentRes.status).toBe(200);
    const sentBody = await sentRes.json() as { sentences: Sentence[] };
    expect(sentBody.sentences).toHaveLength(1);
    const s = sentBody.sentences[0]!;
    expect(s.textRaw).toBe("Contenido del audio.");
    expect(s.text).toBe("Contenido del audio.");
    expect(s.status).toBe("active");
    expect(s.flagState).toBe("unflagged");
    expect(s.stitchedInto).toBeNull();
    expect(s.correctedText).toBeNull();
  }, TEST_TIMEOUT);
});
