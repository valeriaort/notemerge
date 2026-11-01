import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { readFileSync } from "fs";
import FormData from "form-data";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import { ScriptedSpeechToText } from "../../src/providers/fakes.js";
import type { AudioFile, Lecture, Sentence, Subject } from "../../src/shared/types.js";

const FIXTURES = path.resolve("tests/fixtures");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name));
const SHORT_AUDIO = fixture("short_audio.wav");
const SLIDES = fixture("text_slides.pdf");

let server: TestServer;
let speechToText: ScriptedSpeechToText;

beforeEach(async () => {
  speechToText = new ScriptedSpeechToText();
  server = await startTestServer({ speechToText });
});
afterEach(() => server.close());

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createLecture(body?: object): Promise<Lecture> {
  const res = await fetch(`${server.url}/api/lectures`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return json<Lecture>(res);
}

async function createSubject(): Promise<Subject> {
  const res = await fetch(`${server.url}/api/subjects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Anatomy" }),
  });
  return json<Subject>(res);
}

function upload(
  lectureId: string,
  subjectId: string,
  files: {
    notes?: [string, Buffer];
    presentation?: Buffer;
    audio1?: Buffer;
    audio2?: Buffer;
    audio1StartTime?: number;
  },
): Promise<Response> {
  const form = new FormData();
  form.append("subjectId", subjectId);
  if (files.notes) form.append("notes", files.notes[1], { filename: files.notes[0] });
  if (files.presentation) form.append("presentation", files.presentation, { filename: "slides.pdf" });
  if (files.audio1) form.append("audio1", files.audio1, { filename: "a1.wav", contentType: "audio/wav" });
  if (files.audio2) form.append("audio2", files.audio2, { filename: "a2.wav", contentType: "audio/wav" });
  if (files.audio1StartTime !== undefined) form.append("audio1StartTime", String(files.audio1StartTime));
  return fetch(`${server.url}/api/lectures/${lectureId}/sources`, {
    method: "POST",
    headers: form.getHeaders() as Record<string, string>,
    body: form.getBuffer(),
  });
}

const TEST_TIMEOUT = 30_000;

describe("lecture mode", () => {
  it("defaults to live and is persisted and returned", async () => {
    const lecture = await createLecture();
    expect(lecture.mode).toBe("live");
    const fetched = await json<Lecture>(await fetch(`${server.url}/api/lectures/${lecture.id}`));
    expect(fetched.mode).toBe("live");
  });

  it("stores the untimed mode chosen at creation", async () => {
    const lecture = await createLecture({ mode: "untimed" });
    expect(lecture.mode).toBe("untimed");
    const list = await json<Lecture[]>(await fetch(`${server.url}/api/lectures`));
    expect(list.find((l) => l.id === lecture.id)?.mode).toBe("untimed");
  });

  it("rejects an unknown mode", async () => {
    const res = await fetch(`${server.url}/api/lectures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects the editor save and marker endpoints for untimed lectures", async () => {
    const lecture = await createLecture({ mode: "untimed" });
    const put = await fetch(`${server.url}/api/lectures/${lecture.id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notesData: '{"blocks":[],"meta":{}}' }),
    });
    expect(put.status).toBe(409);

    const marker = await fetch(`${server.url}/api/lectures/${lecture.id}/markers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timestamp: 1, blockId: "b" }),
    });
    expect(marker.status).toBe(409);
    const del = await fetch(`${server.url}/api/lectures/${lecture.id}/markers/x`, { method: "DELETE" });
    expect(del.status).toBe(409);
  });

  it("still accepts the editor save for live lectures", async () => {
    const lecture = await createLecture();
    const put = await fetch(`${server.url}/api/lectures/${lecture.id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notesData: '{"blocks":[],"meta":{}}' }),
    });
    expect(put.status).toBe(200);
  });
});

describe("untimed notes upload", () => {
  it.each([
    "notes.md",
    "notes.docx",
    "notes.pdf",
  ])("converts %s into sealed note blocks with empty meta", async (file) => {
    const lecture = await createLecture({ mode: "untimed" });
    const subject = await createSubject();
    const res = await upload(lecture.id, subject.id, {
      notes: [file, fixture(file)],
      presentation: SLIDES,
    });
    expect(res.status).toBe(200);
    const { lecture: sealed } = await json<{ lecture: Lecture }>(res);
    expect(sealed.stage).toBe("sealed");
    expect(sealed.subjectId).toBe(subject.id);

    const doc = JSON.parse(sealed.notesData) as {
      blocks: Array<{ type: string; props?: { level: number }; children: unknown[] }>;
      meta: object;
    };
    expect(doc.meta).toEqual({});
    expect(doc.blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "bulletListItem",
      "bulletListItem",
      "heading",
      "numberedListItem",
      "numberedListItem",
      "paragraph",
    ]);
    expect(doc.blocks[0]!.props?.level).toBe(1);
    expect(doc.blocks[3]!.children).toHaveLength(2);
  });

  it("needs the notes file", async () => {
    const lecture = await createLecture({ mode: "untimed" });
    const subject = await createSubject();
    const res = await upload(lecture.id, subject.id, { presentation: SLIDES });
    expect(res.status).toBe(400);
    const after = await json<Lecture>(await fetch(`${server.url}/api/lectures/${lecture.id}`));
    expect(after.stage).toBe("writing");
  });

  it("rejects notes with neither presentation nor audio", async () => {
    const lecture = await createLecture({ mode: "untimed" });
    const subject = await createSubject();
    const res = await upload(lecture.id, subject.id, { notes: ["notes.md", fixture("notes.md")] });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toMatch(/notes alone/);
  });

  it("rejects a scanned PDF of notes with a clear message and seals nothing", async () => {
    const lecture = await createLecture({ mode: "untimed" });
    const subject = await createSubject();
    const res = await upload(lecture.id, subject.id, {
      notes: ["notes-scanned.pdf", fixture("notes-scanned.pdf")],
      presentation: SLIDES,
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toMatch(/scanned/i);
    const after = await json<Lecture>(await fetch(`${server.url}/api/lectures/${lecture.id}`));
    expect(after.stage).toBe("writing");
  });

  it("rejects an unsupported notes file type", async () => {
    const lecture = await createLecture({ mode: "untimed" });
    const subject = await createSubject();
    const res = await upload(lecture.id, subject.id, {
      notes: ["notes.txt", Buffer.from("hola")],
      presentation: SLIDES,
    });
    expect(res.status).toBe(400);
  });

  it("accepts notes + audio without a presentation", async () => {
    const lecture = await createLecture({ mode: "untimed" });
    const subject = await createSubject();
    const res = await upload(lecture.id, subject.id, {
      notes: ["notes.md", fixture("notes.md")],
      audio1: SHORT_AUDIO,
    });
    expect(res.status).toBe(200);
  }, TEST_TIMEOUT);

  it("cannot be replaced once sealed", async () => {
    const lecture = await createLecture({ mode: "untimed" });
    const subject = await createSubject();
    await upload(lecture.id, subject.id, { notes: ["notes.md", fixture("notes.md")], presentation: SLIDES });
    const again = await upload(lecture.id, subject.id, {
      notes: ["notes.docx", fixture("notes.docx")],
      presentation: SLIDES,
    });
    expect(again.status).toBe(409);
    const put = await fetch(`${server.url}/api/lectures/${lecture.id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notesData: '{"blocks":[],"meta":{}}' }),
    });
    expect(put.status).toBe(409);
  });

  it("rejects a notes file for a live lecture", async () => {
    const lecture = await createLecture();
    const subject = await createSubject();
    const res = await upload(lecture.id, subject.id, {
      notes: ["notes.md", fixture("notes.md")],
      presentation: SLIDES,
    });
    expect(res.status).toBe(400);
  });

  it("lists unknown tokens found in the uploaded notes", async () => {
    const lecture = await createLecture({ mode: "untimed" });
    const subject = await createSubject();
    await upload(lecture.id, subject.id, {
      notes: ["notes.md", Buffer.from("# Clínica\n\nEl pc tiene disnea.\n")],
      presentation: SLIDES,
    });
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/unknown-tokens`);
    const tokens = await json<Array<{ text: string }>>(res);
    expect(tokens.map((t) => t.text)).toContain("pc");
  });
});

describe("untimed audio", () => {
  it("needs no recording start time, and sentences get audio-relative times", async () => {
    speechToText.setDefaultSegments([
      { startMs: 1000, endMs: 3000, text: "Primera oración.", avgLogprob: -0.3, noSpeechProb: 0.1, compressionRatio: 1.0 },
    ]);
    const lecture = await createLecture({ mode: "untimed" });
    const subject = await createSubject();
    const res = await upload(lecture.id, subject.id, {
      notes: ["notes.md", fixture("notes.md")],
      audio1: SHORT_AUDIO,
      audio1StartTime: 1_700_000_000_000, // ignored
    });
    expect(res.status).toBe(200);

    const files = await json<{ audioFiles: AudioFile[] }>(
      await fetch(`${server.url}/api/lectures/${lecture.id}/audio-files`),
    );
    expect(files.audioFiles[0]!.recordingStartMs).toBe(0);

    const t = await fetch(`${server.url}/api/lectures/${lecture.id}/transcribe`, { method: "POST" });
    expect(t.status).toBeLessThan(300);
    const { sentences } = await json<{ sentences: Sentence[] }>(
      await fetch(`${server.url}/api/lectures/${lecture.id}/sentences`),
    );
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.clockStartTimeMs).toBe(1000);
    expect(sentences[0]!.clockEndTimeMs).toBe(3000);
  }, TEST_TIMEOUT);

  it("places a second audio file after the first on the same timeline", async () => {
    const lecture = await createLecture({ mode: "untimed" });
    const subject = await createSubject();
    const res = await upload(lecture.id, subject.id, {
      notes: ["notes.md", fixture("notes.md")],
      audio1: SHORT_AUDIO,
      audio2: SHORT_AUDIO,
    });
    expect(res.status).toBe(200);
    const { audioFiles } = await json<{ audioFiles: AudioFile[] }>(
      await fetch(`${server.url}/api/lectures/${lecture.id}/audio-files`),
    );
    const [first, second] = [...audioFiles].sort((a, b) => a.fileIndex - b.fileIndex);
    expect(first!.recordingStartMs).toBe(0);
    expect(second!.recordingStartMs).toBe(first!.durationMs);
  }, TEST_TIMEOUT);

  it("returns 409 from every start-time endpoint", async () => {
    const lecture = await createLecture({ mode: "untimed" });
    const subject = await createSubject();
    await upload(lecture.id, subject.id, { notes: ["notes.md", fixture("notes.md")], audio1: SHORT_AUDIO });
    const { audioFiles } = await json<{ audioFiles: AudioFile[] }>(
      await fetch(`${server.url}/api/lectures/${lecture.id}/audio-files`),
    );
    const fileId = audioFiles[0]!.id;
    const base = `${server.url}/api/lectures/${lecture.id}`;
    const jsonInit = (method: string, body: object) => ({
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect((await fetch(`${base}/audio-start-suggestion`)).status).toBe(409);
    expect((await fetch(`${base}/derive-audio-start`, jsonInit("POST", { markerId: "m", audioOffsetMs: 0 }))).status).toBe(409);
    expect((await fetch(`${base}/audio-files/${fileId}/recording-start`, jsonInit("PATCH", { recordingStartMs: 5 }))).status).toBe(409);
    expect((await fetch(`${base}/audio/${fileId}/recording-start`, jsonInit("PATCH", { recordingStartMs: 5 }))).status).toBe(409);
  }, TEST_TIMEOUT);
});
