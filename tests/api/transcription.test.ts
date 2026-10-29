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
    // Use "Contenido del audio." but put those terms in the notes so they are
    // known and do not trigger the unrecognized-medical-term flag.
    speechToText.setDefaultSegments([
      { startMs: 1000, endMs: 3000, text: "Contenido del audio.", avgLogprob: -0.5, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    server.close();
    server = await startTestServer({ speechToText });

    const lecture = await createLecture();
    const subject = await createSubject("Test");
    // Notes contain the sentence's terms so they are in the mini glossary
    await putNotes(lecture.id, notesWithBlockInRange("Contenido del audio."));
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

// ── Transcript clean-up: stitching ────────────────────────────────────────────

// Multi-chunk tests use a very short chunk target (3 s) so that a 10 s audio
// file is split into several chunks by ffmpeg. Chunk paths are read from the
// DB after upload so the ScriptedSpeechToText fake can be keyed by path.

describe("transcript stitching across chunk boundaries", () => {
  let speechToText: ScriptedSpeechToText;

  beforeEach(async () => {
    speechToText = new ScriptedSpeechToText();
    server = await startTestServer({ speechToText }, { chunkTargetMs: 3000 });
  });

  afterEach(() => server.close());

  it("stitches when last sentence lacks terminal punct and next starts lowercase", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    // Query chunk paths in order so we can script each one
    const chunkRows = server.db
      .prepare<[], { file_path: string }>(
        `SELECT ac.file_path FROM audio_chunks ac
         JOIN audio_files af ON ac.audio_file_id = af.id
         WHERE af.lecture_id = ?
         ORDER BY ac.chunk_index`,
      )
      .all(lecture.id);

    expect(chunkRows.length).toBeGreaterThan(1);

    // Chunk 0: last sentence has no terminal punctuation
    speechToText.setSegments(chunkRows[0]!.file_path, [
      { startMs: 0, endMs: 1500, text: "Primera parte de la oración", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    // Chunk 1: first sentence starts lowercase → should be stitched into chunk 0's sentence
    speechToText.setSegments(chunkRows[1]!.file_path, [
      { startMs: 0, endMs: 1500, text: "que continúa aquí.", avgLogprob: -0.5, noSpeechProb: 0.2, compressionRatio: 1.8 },
    ]);
    // Remaining chunks return nothing
    for (let i = 2; i < chunkRows.length; i++) {
      speechToText.setSegments(chunkRows[i]!.file_path, []);
    }

    await triggerTranscription(lecture.id);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const sentBody = await sentRes.json() as { sentences: Sentence[] };

    const active = sentBody.sentences.filter((s) => s.status === "active");
    const retired = sentBody.sentences.filter((s) => s.status === "retired" && s.stitchedInto !== null);

    // One active stitched sentence, one retired
    expect(active).toHaveLength(1);
    expect(retired).toHaveLength(1);

    const stitched = active[0]!;
    // Keeps the earlier ID (A01-T0001)
    expect(stitched.id).toBe("A01-T0001");
    // Text is the joined result
    expect(stitched.text).toBe("Primera parte de la oración que continúa aquí.");
    // clockStartTimeMs comes from the first sentence
    expect(stitched.clockStartTimeMs).toBe(RECORDING_START + 0);
    // audioEndOffsetMs covers the second sentence's end
    expect(stitched.audioEndOffsetMs).toBe(1500);
    // Metrics are worst-of: min avgLogprob, max noSpeechProb, max compressionRatio
    expect(stitched.avgLogprob).toBeCloseTo(-0.5);
    expect(stitched.noSpeechProb).toBeCloseTo(0.2);
    expect(stitched.compressionRatio).toBeCloseTo(1.8);

    // Retired sentence points back to the kept sentence
    expect(retired[0]!.stitchedInto).toBe("A01-T0001");
  }, TEST_TIMEOUT);

  it("does not stitch when last sentence has terminal punctuation", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    const chunkRows = server.db
      .prepare<[], { file_path: string }>(
        `SELECT ac.file_path FROM audio_chunks ac
         JOIN audio_files af ON ac.audio_file_id = af.id
         WHERE af.lecture_id = ?
         ORDER BY ac.chunk_index`,
      )
      .all(lecture.id);

    expect(chunkRows.length).toBeGreaterThan(1);

    speechToText.setSegments(chunkRows[0]!.file_path, [
      { startMs: 0, endMs: 1500, text: "Primera oración completa.", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    speechToText.setSegments(chunkRows[1]!.file_path, [
      { startMs: 0, endMs: 1500, text: "segunda oración.", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    for (let i = 2; i < chunkRows.length; i++) {
      speechToText.setSegments(chunkRows[i]!.file_path, []);
    }

    await triggerTranscription(lecture.id);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const sentBody = await sentRes.json() as { sentences: Sentence[] };
    const active = sentBody.sentences.filter((s) => s.status === "active");
    // No stitch → both sentences remain active
    expect(active).toHaveLength(2);
  }, TEST_TIMEOUT);

  it("does not stitch when next sentence starts uppercase", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    const chunkRows = server.db
      .prepare<[], { file_path: string }>(
        `SELECT ac.file_path FROM audio_chunks ac
         JOIN audio_files af ON ac.audio_file_id = af.id
         WHERE af.lecture_id = ?
         ORDER BY ac.chunk_index`,
      )
      .all(lecture.id);

    expect(chunkRows.length).toBeGreaterThan(1);

    speechToText.setSegments(chunkRows[0]!.file_path, [
      { startMs: 0, endMs: 1500, text: "Primera parte sin punto", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    speechToText.setSegments(chunkRows[1]!.file_path, [
      { startMs: 0, endMs: 1500, text: "Segunda parte con mayúscula.", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    for (let i = 2; i < chunkRows.length; i++) {
      speechToText.setSegments(chunkRows[i]!.file_path, []);
    }

    await triggerTranscription(lecture.id);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const sentBody = await sentRes.json() as { sentences: Sentence[] };
    const active = sentBody.sentences.filter((s) => s.status === "active");
    // No stitch → both sentences remain active (uppercase start)
    expect(active).toHaveLength(2);
  }, TEST_TIMEOUT);
});

// ── Transcript clean-up: filler removal ──────────────────────────────────────

describe("transcript filler removal", () => {
  let speechToText: ScriptedSpeechToText;

  beforeEach(async () => {
    speechToText = new ScriptedSpeechToText();
    server = await startTestServer({ speechToText });
  });

  afterEach(() => server.close());

  it("removes '¿ya lo tenéis?' as filler", async () => {
    speechToText.setDefaultSegments([
      { startMs: 0, endMs: 1000, text: "¿ya lo tenéis?", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);

    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);
    await triggerTranscription(lecture.id);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const sentBody = await sentRes.json() as { sentences: Sentence[] };

    const active = sentBody.sentences.filter((s) => s.status === "active");
    expect(active).toHaveLength(0);

    const retired = sentBody.sentences.filter((s) => s.status === "retired");
    expect(retired).toHaveLength(1);
  }, TEST_TIMEOUT);

  it("removes '¿ya está copiado?' as filler", async () => {
    speechToText.setDefaultSegments([
      { startMs: 0, endMs: 1000, text: "¿ya está copiado?", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);

    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);
    await triggerTranscription(lecture.id);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const sentBody = await sentRes.json() as { sentences: Sentence[] };

    const active = sentBody.sentences.filter((s) => s.status === "active");
    expect(active).toHaveLength(0);
  }, TEST_TIMEOUT);
});

// ── Transcript clean-up: flagging ────────────────────────────────────────────

describe("transcript flagging", () => {
  let speechToText: ScriptedSpeechToText;

  beforeEach(async () => {
    speechToText = new ScriptedSpeechToText();
    server = await startTestServer({ speechToText });
  });

  afterEach(() => server.close());

  it("flags sentence when avg_logprob < -1.0", async () => {
    speechToText.setDefaultSegments([
      { startMs: 0, endMs: 1000, text: "Algo dicho.", avgLogprob: -1.5, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);

    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);
    await triggerTranscription(lecture.id);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const sentBody = await sentRes.json() as { sentences: Sentence[] };
    const s = sentBody.sentences[0]!;
    expect(s.flagState).toBe("flagged_unhandled");
    expect((s.flagReasons as string[])).toContain("avg_logprob");
  }, TEST_TIMEOUT);

  it("flags sentence when no_speech_prob > 0.6", async () => {
    speechToText.setDefaultSegments([
      { startMs: 0, endMs: 1000, text: "Algo dicho.", avgLogprob: -0.3, noSpeechProb: 0.7, compressionRatio: 1.0 },
    ]);

    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);
    await triggerTranscription(lecture.id);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const sentBody = await sentRes.json() as { sentences: Sentence[] };
    const s = sentBody.sentences[0]!;
    expect(s.flagState).toBe("flagged_unhandled");
    expect((s.flagReasons as string[])).toContain("no_speech_prob");
  }, TEST_TIMEOUT);

  it("flags sentence when compression_ratio > 2.4", async () => {
    speechToText.setDefaultSegments([
      { startMs: 0, endMs: 1000, text: "Algo dicho.", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 2.5 },
    ]);

    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);
    await triggerTranscription(lecture.id);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const sentBody = await sentRes.json() as { sentences: Sentence[] };
    const s = sentBody.sentences[0]!;
    expect(s.flagState).toBe("flagged_unhandled");
    expect((s.flagReasons as string[])).toContain("compression_ratio");
  }, TEST_TIMEOUT);

  it("flags sentence containing a medical-looking term absent from mini glossary", async () => {
    // "periodontitis" is medical-looking; no notes in range → empty mini glossary
    speechToText.setDefaultSegments([
      { startMs: 0, endMs: 1000, text: "El paciente tiene periodontitis.", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);

    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);
    await triggerTranscription(lecture.id);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const sentBody = await sentRes.json() as { sentences: Sentence[] };
    const s = sentBody.sentences[0]!;
    expect(s.flagState).toBe("flagged_unhandled");
    expect((s.flagReasons as string[])).toContain("unrecognized_medical_term");
  }, TEST_TIMEOUT);

  it("does not flag sentence when medical term is in the mini glossary", async () => {
    // "cóndilo" is medical-looking; notes in range contain it → it is known
    speechToText.setDefaultSegments([
      { startMs: 1000, endMs: 3000, text: "El cóndilo es importante.", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);

    const lecture = await createLecture();
    const subject = await createSubject("Test");
    // Notes contain "cóndilo" so it lands in the mini glossary
    await putNotes(lecture.id, notesWithBlockInRange("cóndilo mandibular"));
    await uploadAudio(lecture.id, subject.id, RECORDING_START);
    await triggerTranscription(lecture.id);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const sentBody = await sentRes.json() as { sentences: Sentence[] };
    const s = sentBody.sentences[0]!;
    expect(s.flagState).toBe("unflagged");
  }, TEST_TIMEOUT);
});

// ── Transcript clean-up: ordering (stitch → filler → flag) ───────────────────

describe("transcript cleanup ordering", () => {
  let speechToText: ScriptedSpeechToText;

  beforeEach(async () => {
    speechToText = new ScriptedSpeechToText();
    server = await startTestServer({ speechToText }, { chunkTargetMs: 3000 });
  });

  afterEach(() => server.close());

  it("stitches across boundary first, then filler removes the combined sentence", async () => {
    // Split filler phrase across two chunks: "¿ya lo" / "tenéis?"
    // Stitching must run before filler so the combined text is matched.
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    const chunkRows = server.db
      .prepare<[], { file_path: string }>(
        `SELECT ac.file_path FROM audio_chunks ac
         JOIN audio_files af ON ac.audio_file_id = af.id
         WHERE af.lecture_id = ?
         ORDER BY ac.chunk_index`,
      )
      .all(lecture.id);

    expect(chunkRows.length).toBeGreaterThan(1);

    speechToText.setSegments(chunkRows[0]!.file_path, [
      { startMs: 0, endMs: 1500, text: "¿ya lo", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    speechToText.setSegments(chunkRows[1]!.file_path, [
      { startMs: 0, endMs: 1500, text: "tenéis?", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    for (let i = 2; i < chunkRows.length; i++) {
      speechToText.setSegments(chunkRows[i]!.file_path, []);
    }

    await triggerTranscription(lecture.id);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const sentBody = await sentRes.json() as { sentences: Sentence[] };

    // No active sentences: stitched result "¿ya lo tenéis?" was removed as filler
    const active = sentBody.sentences.filter((s) => s.status === "active");
    expect(active).toHaveLength(0);

    // Both sentences retired (chunk 2's by stitching, chunk 1's by filler)
    expect(sentBody.sentences.filter((s) => s.status === "retired")).toHaveLength(2);
  }, TEST_TIMEOUT);

  it("retired sentences from stitching are not additionally flagged", async () => {
    // The sentence that gets retired by stitching should not get flagState = flagged_unhandled
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    const chunkRows = server.db
      .prepare<[], { file_path: string }>(
        `SELECT ac.file_path FROM audio_chunks ac
         JOIN audio_files af ON ac.audio_file_id = af.id
         WHERE af.lecture_id = ?
         ORDER BY ac.chunk_index`,
      )
      .all(lecture.id);

    expect(chunkRows.length).toBeGreaterThan(1);

    // Chunk 0: ends without terminal punct
    speechToText.setSegments(chunkRows[0]!.file_path, [
      { startMs: 0, endMs: 1500, text: "Primera parte", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    // Chunk 1: starts lowercase, bad metrics that would normally trigger flagging
    speechToText.setSegments(chunkRows[1]!.file_path, [
      { startMs: 0, endMs: 1500, text: "segunda parte.", avgLogprob: -2.0, noSpeechProb: 0.8, compressionRatio: 3.0 },
    ]);
    for (let i = 2; i < chunkRows.length; i++) {
      speechToText.setSegments(chunkRows[i]!.file_path, []);
    }

    await triggerTranscription(lecture.id);

    const sentRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`);
    const sentBody = await sentRes.json() as { sentences: Sentence[] };

    const stitchedRetired = sentBody.sentences.find(
      (s) => s.status === "retired" && s.stitchedInto !== null,
    );
    expect(stitchedRetired).toBeDefined();
    // The retired-by-stitching sentence is never flagged (flagging only runs on active)
    expect(stitchedRetired!.flagState).toBe("unflagged");
  }, TEST_TIMEOUT);
});

// ── Retry / backoff / per-chunk failures ─────────────────────────────────────

describe("retry and backoff", () => {
  let speechToText: ScriptedSpeechToText;

  beforeEach(async () => {
    speechToText = new ScriptedSpeechToText();
    server = await startTestServer({ speechToText });
  });

  afterEach(() => server.close());

  it("fails a specific chunk N times then succeeds within MAX_RETRIES", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    const chunkRows = server.db.prepare(
      `SELECT ac.file_path, ac.id FROM audio_chunks ac
       JOIN audio_files af ON ac.audio_file_id = af.id WHERE af.lecture_id = ?`,
    ).all(lecture.id) as { file_path: string; id: string }[];
    expect(chunkRows.length).toBeGreaterThan(0);
    const { file_path: chunkPath, id: chunkId } = chunkRows[0]!;

    // Fail twice (within MAX_RETRIES=3, so eventually succeeds)
    speechToText.setChunkFailCount(chunkPath, 2, 429);

    const { status, body } = await triggerTranscription(lecture.id);
    expect(status).toBe(201);
    expect(body.transcriptRun!.state).toBe("done");

    // Provider was called 3 times: 2 fails + 1 success
    const callsForChunk = speechToText.capturedPrompts.filter((p) => p.chunkPath === chunkPath);
    expect(callsForChunk.length).toBe(3);
    // DB records a single successful completion
    const row = server.db.prepare("SELECT attempts, status FROM audio_chunks WHERE id = ?").get(chunkId) as { attempts: number; status: string };
    expect(row.status).toBe("done");
    expect(row.attempts).toBe(1);
  }, TEST_TIMEOUT);

  it("pauses with named failed chunk when retries are exhausted", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    const chunkRows = server.db.prepare(
      `SELECT ac.file_path, ac.id FROM audio_chunks ac
       JOIN audio_files af ON ac.audio_file_id = af.id WHERE af.lecture_id = ?`,
    ).all(lecture.id) as { file_path: string; id: string }[];
    const { file_path: chunkPath, id: chunkId } = chunkRows[0]!;

    speechToText.setChunkFailCount(chunkPath, 10, 429);

    const { body } = await triggerTranscription(lecture.id);
    expect(body.transcriptRun!.state).toBe("paused");
    expect(body.transcriptRun!.failedChunkIds).toContain(chunkId);

    // GET /transcribe should include named failed chunk
    const statusRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcribe`);
    const statusBody = await statusRes.json() as {
      transcriptRun: TranscriptRun;
      failedChunks: Array<{ id: string; chunkName: string; lastError: string | null }>;
    };
    expect(statusBody.failedChunks).toHaveLength(1);
    expect(statusBody.failedChunks[0]!.chunkName).toBe("A01-C001");
    expect(statusBody.failedChunks[0]!.lastError).toContain("429");
  }, TEST_TIMEOUT);

  it("retry re-sends only failed chunks; skips done chunks", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    const audioFileRows = server.db.prepare(
      "SELECT id FROM audio_files WHERE lecture_id = ?",
    ).all(lecture.id) as { id: string }[];
    const audioFileId = audioFileRows[0]!.id;

    // Insert a fake "done" chunk to simulate an already-transcribed chunk
    server.db.prepare(
      `INSERT INTO audio_chunks (id, audio_file_id, chunk_index, file_path, start_offset_ms, duration_ms, status, attempts)
       VALUES (?, ?, 99, '/fake/done.wav', 0, 1000, 'done', 1)`,
    ).run("fake-done-chunk", audioFileId);

    // Fail the real chunk permanently
    const chunkRows = server.db.prepare(
      `SELECT ac.file_path, ac.id FROM audio_chunks ac
       JOIN audio_files af ON ac.audio_file_id = af.id
       WHERE af.lecture_id = ? AND ac.id != 'fake-done-chunk'`,
    ).all(lecture.id) as { file_path: string; id: string }[];
    const { file_path: chunkPath, id: chunkId } = chunkRows[0]!;

    speechToText.setChunkFailCount(chunkPath, 10, 429);
    await triggerTranscription(lecture.id); // first run: real chunk fails

    const attemptsAfterFirst = (server.db.prepare("SELECT attempts FROM audio_chunks WHERE id = ?").get(chunkId) as { attempts: number }).attempts;
    const doneAttemptsAfterFirst = (server.db.prepare("SELECT attempts FROM audio_chunks WHERE id = 'fake-done-chunk'").get() as { attempts: number }).attempts;
    expect(doneAttemptsAfterFirst).toBe(1); // done chunk never re-sent

    // Reset fail count and retry
    speechToText.setChunkFailCount(chunkPath, 0);
    const { body } = await triggerTranscription(lecture.id);
    expect(body.transcriptRun!.state).toBe("done");

    const attemptsAfterRetry = (server.db.prepare("SELECT attempts FROM audio_chunks WHERE id = ?").get(chunkId) as { attempts: number }).attempts;
    expect(attemptsAfterRetry).toBe(attemptsAfterFirst + 1); // one more attempt on retry

    // Done chunk still not re-sent
    const doneAttemptsAfterRetry = (server.db.prepare("SELECT attempts FROM audio_chunks WHERE id = 'fake-done-chunk'").get() as { attempts: number }).attempts;
    expect(doneAttemptsAfterRetry).toBe(1);
  }, TEST_TIMEOUT);

  it("resumes mid-run transcript when server restarts (running state)", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    // Simulate server restart mid-run: insert a transcript_run in "running" state
    server.db.prepare(
      `INSERT INTO transcript_runs (id, lecture_id, state, model, failed_chunk_ids, created_at)
       VALUES (?, ?, 'running', ?, '[]', ?)`,
    ).run("mid-run-id", lecture.id, "whisper-large-v3", Date.now());

    // POST /transcribe should resume
    const { status, body } = await triggerTranscription(lecture.id);
    expect(status).toBe(201);
    expect(body.transcriptRun!.state).toBe("done");
  }, TEST_TIMEOUT);

  it("stage cannot reach transcript-check with a missing chunk", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    const chunkRows = server.db.prepare(
      `SELECT ac.file_path FROM audio_chunks ac
       JOIN audio_files af ON ac.audio_file_id = af.id WHERE af.lecture_id = ?`,
    ).all(lecture.id) as { file_path: string }[];
    speechToText.setChunkFailCount(chunkRows[0]!.file_path, 10, 500);

    await triggerTranscription(lecture.id);

    const updatedLecture = await fetch(`${server.url}/api/lectures/${lecture.id}`).then((r) => r.json()) as Lecture;
    expect(updatedLecture.stage).toBe("sealed");
  }, TEST_TIMEOUT);
});

// ── Transcription model change ────────────────────────────────────────────────

describe("transcription model change", () => {
  beforeEach(async () => {
    server = await startTestServer({ speechToText: new ScriptedSpeechToText() });
  });

  afterEach(() => server.close());

  it("warns before discarding existing transcript (no confirm)", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);
    await triggerTranscription(lecture.id);

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/transcription-model`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "whisper-large-v3-turbo" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { warning?: string };
    expect(body.warning).toBeDefined();
    expect(body.warning).toContain("confirm");

    // Transcript must be untouched
    const runRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcribe`);
    expect(runRes.status).toBe(200);
    const runBody = await runRes.json() as { transcriptRun: TranscriptRun };
    expect(runBody.transcriptRun.state).toBe("done");
  }, TEST_TIMEOUT);

  it("discards transcript and sets new model when confirm=true", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);
    await triggerTranscription(lecture.id);

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/transcription-model`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "whisper-large-v3-turbo", confirm: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    // Transcript is discarded
    const runRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcribe`);
    expect(runRes.status).toBe(404);

    // Stage reset to sealed
    const lec = await fetch(`${server.url}/api/lectures/${lecture.id}`).then((r) => r.json()) as Lecture;
    expect(lec.stage).toBe("sealed");

    // Re-running uses new model
    const { body: runBody } = await triggerTranscription(lecture.id);
    expect(runBody.transcriptRun!.model).toBe("whisper-large-v3-turbo");
  }, TEST_TIMEOUT);

  it("sets model without warning when no transcript exists", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/transcription-model`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "whisper-large-v3-turbo" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    // Next transcription uses new model
    const { body: runBody } = await triggerTranscription(lecture.id);
    expect(runBody.transcriptRun!.model).toBe("whisper-large-v3-turbo");
  }, TEST_TIMEOUT);

  it("rejects model change with 409 after review has begun", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);
    await triggerTranscription(lecture.id);

    // Snapshot transcript state
    const sentencesBefore = server.db.prepare(
      `SELECT * FROM sentences WHERE chunk_id IN
       (SELECT ac.id FROM audio_chunks ac JOIN audio_files af ON ac.audio_file_id = af.id WHERE af.lecture_id = ?)
       ORDER BY id`,
    ).all(lecture.id);

    // Simulate review has begun
    server.db.prepare("UPDATE lectures SET stage = 'review' WHERE id = ?").run(lecture.id);

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/transcription-model`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "whisper-large-v3-turbo", confirm: true }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBeTruthy();

    // Transcript data unchanged
    const sentencesAfter = server.db.prepare(
      `SELECT * FROM sentences WHERE chunk_id IN
       (SELECT ac.id FROM audio_chunks ac JOIN audio_files af ON ac.audio_file_id = af.id WHERE af.lecture_id = ?)
       ORDER BY id`,
    ).all(lecture.id);
    expect(sentencesAfter).toEqual(sentencesBefore);
  }, TEST_TIMEOUT);
});

// ── Recording start time change ───────────────────────────────────────────────

describe("recording start time change", () => {
  beforeEach(async () => {
    server = await startTestServer({ speechToText: new ScriptedSpeechToText() });
  });

  afterEach(() => server.close());

  it("warns before discarding transcript when changing recording start (no confirm)", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);
    await triggerTranscription(lecture.id);

    const audioFiles = server.db.prepare(
      "SELECT id FROM audio_files WHERE lecture_id = ?",
    ).all(lecture.id) as { id: string }[];
    const audioFileId = audioFiles[0]!.id;

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/audio-files/${audioFileId}/recording-start`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingStartMs: RECORDING_START + 60000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { warning?: string };
    expect(body.warning).toBeDefined();
    expect(body.warning).toContain("confirm");

    // Transcript must be untouched
    const runRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcribe`);
    expect(runRes.status).toBe(200);
  }, TEST_TIMEOUT);

  it("discards transcript and updates recording start when confirm=true", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);
    await triggerTranscription(lecture.id);

    const audioFiles = server.db.prepare(
      "SELECT id FROM audio_files WHERE lecture_id = ?",
    ).all(lecture.id) as { id: string }[];
    const audioFileId = audioFiles[0]!.id;

    const newStart = RECORDING_START + 60000;
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/audio-files/${audioFileId}/recording-start`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingStartMs: newStart, confirm: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);

    // Transcript discarded
    const runRes = await fetch(`${server.url}/api/lectures/${lecture.id}/transcribe`);
    expect(runRes.status).toBe(404);

    // Stage reset to sealed
    const lec = await fetch(`${server.url}/api/lectures/${lecture.id}`).then((r) => r.json()) as Lecture;
    expect(lec.stage).toBe("sealed");

    // Recording start updated
    const af = server.db.prepare("SELECT recording_start_ms FROM audio_files WHERE id = ?").get(audioFileId) as { recording_start_ms: number };
    expect(af.recording_start_ms).toBe(newStart);
  }, TEST_TIMEOUT);

  it("updates recording start without warning when no transcript exists", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);

    const audioFiles = server.db.prepare(
      "SELECT id FROM audio_files WHERE lecture_id = ?",
    ).all(lecture.id) as { id: string }[];
    const audioFileId = audioFiles[0]!.id;

    const newStart = RECORDING_START + 30000;
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/audio-files/${audioFileId}/recording-start`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingStartMs: newStart }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);

    const af = server.db.prepare("SELECT recording_start_ms FROM audio_files WHERE id = ?").get(audioFileId) as { recording_start_ms: number };
    expect(af.recording_start_ms).toBe(newStart);
  }, TEST_TIMEOUT);

  it("rejects recording-start change with 409 after review has begun", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Test");
    await putNotes(lecture.id, notesWithNoBlockInRange());
    await uploadAudio(lecture.id, subject.id, RECORDING_START);
    await triggerTranscription(lecture.id);

    const audioFiles = server.db.prepare(
      "SELECT id FROM audio_files WHERE lecture_id = ?",
    ).all(lecture.id) as { id: string }[];
    const audioFileId = audioFiles[0]!.id;

    // Snapshot state
    const runBefore = server.db.prepare(
      "SELECT * FROM transcript_runs WHERE lecture_id = ?",
    ).get(lecture.id);

    // Simulate review has begun
    server.db.prepare("UPDATE lectures SET stage = 'review' WHERE id = ?").run(lecture.id);

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/audio-files/${audioFileId}/recording-start`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingStartMs: RECORDING_START + 60000, confirm: true }),
    });
    expect(res.status).toBe(409);

    // State unchanged
    const runAfter = server.db.prepare(
      "SELECT * FROM transcript_runs WHERE lecture_id = ?",
    ).get(lecture.id);
    expect(runAfter).toEqual(runBefore);

    // Recording start unchanged
    const af = server.db.prepare("SELECT recording_start_ms FROM audio_files WHERE id = ?").get(audioFileId) as { recording_start_ms: number };
    expect(af.recording_start_ms).toBe(RECORDING_START);
  }, TEST_TIMEOUT);
});
