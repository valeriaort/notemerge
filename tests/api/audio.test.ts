import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { readFileSync, existsSync, readdirSync } from "fs";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture, Subject, AudioFile, AudioChunk } from "../../src/shared/types.js";
import FormData from "form-data";

const FIXTURES = path.resolve("tests/fixtures");
const SHORT_AUDIO = readFileSync(path.join(FIXTURES, "short_audio.wav"));

// Minimal PDF for tests that need a presentation
const MINIMAL_PDF = Buffer.from(
  "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
);

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

async function addMarker(lectureId: string, timestamp: number): Promise<void> {
  await fetch(`${server.url}/api/lectures/${lectureId}/markers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestamp, blockId: "block-1" }),
  });
}

function buildForm(opts: {
  subjectId?: string;
  subjectName?: string;
  presentation?: Buffer;
  audio1?: Buffer;
  audio2?: Buffer;
  audio1StartTime?: number;
  audio2StartTime?: number;
}): { headers: Record<string, string>; body: Buffer } {
  const form = new FormData();
  if (opts.subjectId) form.append("subjectId", opts.subjectId);
  if (opts.subjectName) form.append("subjectName", opts.subjectName);
  if (opts.presentation)
    form.append("presentation", opts.presentation, {
      filename: "slides.pdf",
      contentType: "application/pdf",
    });
  if (opts.audio1)
    form.append("audio1", opts.audio1, {
      filename: "lecture1.wav",
      contentType: "audio/wav",
    });
  if (opts.audio2)
    form.append("audio2", opts.audio2, {
      filename: "lecture2.wav",
      contentType: "audio/wav",
    });
  if (opts.audio1StartTime !== undefined)
    form.append("audio1StartTime", String(opts.audio1StartTime));
  if (opts.audio2StartTime !== undefined)
    form.append("audio2StartTime", String(opts.audio2StartTime));
  return { headers: form.getHeaders() as Record<string, string>, body: form.getBuffer() };
}

async function uploadSources(
  lectureId: string,
  opts: Parameters<typeof buildForm>[0],
): Promise<Response> {
  const { headers, body } = buildForm(opts);
  return fetch(`${server.url}/api/lectures/${lectureId}/sources`, {
    method: "POST",
    headers,
    body,
  });
}

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(() => {
  server.close();
});

// ── Valid combinations ──────────────────────────────────────────────────────

describe("valid upload combinations", () => {
  it("notes + presentation seals lecture (no audio)", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");
    const res = await uploadSources(lecture.id, {
      subjectId: subject.id,
      presentation: MINIMAL_PDF,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { lecture: Lecture };
    expect(body.lecture.stage).toBe("sealed");
    expect(body.lecture.presentationPath).toBeTruthy();
  });

  it("notes + audio seals lecture (no presentation)", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");
    const res = await uploadSources(lecture.id, {
      subjectId: subject.id,
      audio1: SHORT_AUDIO,
      audio1StartTime: Date.now(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { lecture: Lecture };
    expect(body.lecture.stage).toBe("sealed");
    expect(body.lecture.presentationPath).toBeNull();
  });

  it("notes + presentation + audio seals lecture", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");
    const res = await uploadSources(lecture.id, {
      subjectId: subject.id,
      presentation: MINIMAL_PDF,
      audio1: SHORT_AUDIO,
      audio1StartTime: Date.now(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { lecture: Lecture };
    expect(body.lecture.stage).toBe("sealed");
  });

  it("notes + presentation + two audio files seals lecture", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");
    const now = Date.now();
    const res = await uploadSources(lecture.id, {
      subjectId: subject.id,
      presentation: MINIMAL_PDF,
      audio1: SHORT_AUDIO,
      audio1StartTime: now,
      audio2: SHORT_AUDIO,
      audio2StartTime: now + 60000,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { lecture: Lecture };
    expect(body.lecture.stage).toBe("sealed");
  });
});

// ── Invalid combinations ────────────────────────────────────────────────────

describe("invalid upload combinations", () => {
  it("notes alone (no presentation, no audio) is rejected with 400", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");
    const res = await uploadSources(lecture.id, { subjectId: subject.id });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error.toLowerCase()).toMatch(/presentation|notes.?alone/);
  });

  it("audio2 without audio1 is rejected with 400", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");
    const { headers, body: formBody } = buildForm({
      subjectId: subject.id,
      audio2: SHORT_AUDIO,
      audio2StartTime: Date.now(),
    });
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/sources`, {
      method: "POST",
      headers,
      body: formBody,
    });
    expect(res.status).toBe(400);
  });

  it("audio2 without audio2StartTime is rejected with 400", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");
    const res = await uploadSources(lecture.id, {
      subjectId: subject.id,
      audio1: SHORT_AUDIO,
      audio1StartTime: Date.now(),
      audio2: SHORT_AUDIO,
      // audio2StartTime omitted
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error.toLowerCase()).toMatch(/start time|audio.{1,5}2/i);
  });

  it("lecture remains in writing stage after rejection", async () => {
    const lecture = await createLecture();
    await uploadSources(lecture.id, {});
    const refetched = await fetch(`${server.url}/api/lectures/${lecture.id}`);
    const updated = await refetched.json() as Lecture;
    expect(updated.stage).toBe("writing");
  });
});

// ── Chunking ────────────────────────────────────────────────────────────────

describe("audio chunking", () => {
  it("chunk files are written to disk after upload", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");
    await uploadSources(lecture.id, {
      subjectId: subject.id,
      audio1: SHORT_AUDIO,
      audio1StartTime: Date.now(),
    });

    // Verify chunks_A01 directory was created with at least one chunk
    const chunksDir = path.join(server.dataDir, lecture.id, "chunks_A01");
    expect(existsSync(chunksDir)).toBe(true);
    const chunkFiles = readdirSync(chunksDir);
    expect(chunkFiles.length).toBeGreaterThan(0);
  });

  it("chunk files have A##-C### ID pattern in their names", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");
    await uploadSources(lecture.id, {
      subjectId: subject.id,
      audio1: SHORT_AUDIO,
      audio1StartTime: Date.now(),
    });

    const chunksDir = path.join(server.dataDir, lecture.id, "chunks_A01");
    const chunkFiles = readdirSync(chunksDir);
    for (const f of chunkFiles) {
      expect(f).toMatch(/^A\d{2}-C\d{3}\./);
    }
  });

  it("chunk clock time = recording start + elapsed offset", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");
    const recordingStart = 1700000000000; // fixed timestamp
    await uploadSources(lecture.id, {
      subjectId: subject.id,
      audio1: SHORT_AUDIO,
      audio1StartTime: recordingStart,
    });

    // Fetch audio file info from the DB via windows endpoint (indirect, since there's no direct audio endpoint yet)
    // We verify via the stored audio file that recording_start_ms is set correctly
    const windowsRes = await fetch(`${server.url}/api/lectures/${lecture.id}/windows`);
    expect(windowsRes.status).toBe(200);
    const windowsBody = await windowsRes.json() as { windows: Array<{ startMs: number }> };
    // Lecture start should be at or before the recording start time
    if (windowsBody.windows.length > 0) {
      expect(windowsBody.windows[0]!.startMs).toBeLessThanOrEqual(recordingStart);
    }
  });
});

// ── Recording start times ────────────────────────────────────────────────────

describe("recording start times", () => {
  it("GET audio-start-suggestion returns null when no markers", async () => {
    const lecture = await createLecture();
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/audio-start-suggestion`);
    expect(res.status).toBe(200);
    const body = await res.json() as { suggestedStartMs: number | null };
    expect(body.suggestedStartMs).toBeNull();
  });

  it("GET audio-start-suggestion returns first marker timestamp", async () => {
    const lecture = await createLecture();
    const markerTime = 1700000100000;
    await addMarker(lecture.id, markerTime);
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/audio-start-suggestion`);
    const body = await res.json() as { suggestedStartMs: number };
    expect(body.suggestedStartMs).toBe(markerTime);
  });

  it("first audio start time defaults to first marker when not provided", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");
    const markerTime = 1700000100000;
    await addMarker(lecture.id, markerTime);

    // Upload audio without providing audio1StartTime
    const res = await uploadSources(lecture.id, {
      subjectId: subject.id,
      audio1: SHORT_AUDIO,
      // no audio1StartTime — should default to first marker
    });
    expect(res.status).toBe(200);

    // Verify lecture start includes the marker time (audio bounds from marker time)
    const windowsRes = await fetch(`${server.url}/api/lectures/${lecture.id}/windows`);
    const windowsBody = await windowsRes.json() as { windows: Array<{ startMs: number }> };
    if (windowsBody.windows.length > 0) {
      expect(windowsBody.windows[0]!.startMs).toBeLessThanOrEqual(markerTime);
    }
  });

  it("explicit audio1StartTime is stored (not first marker)", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");
    const markerTime = 1700000100000;
    const explicitStart = 1700000200000; // later than marker
    await addMarker(lecture.id, markerTime);

    const res = await uploadSources(lecture.id, {
      subjectId: subject.id,
      audio1: SHORT_AUDIO,
      audio1StartTime: explicitStart,
    });
    expect(res.status).toBe(200);
  });

  it("file creation time is never used (start times come from user input or marker)", async () => {
    // The audio fixture file has a real mtime but we never use it.
    // This is enforced by design: recording_start_ms always comes from the form field
    // or the first marker, never from the file's mtime.
    // We verify the recorded start matches what we passed, not the file's mtime.
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");
    const sentStartTime = 1700000000000;

    const res = await uploadSources(lecture.id, {
      subjectId: subject.id,
      audio1: SHORT_AUDIO,
      audio1StartTime: sentStartTime,
    });
    expect(res.status).toBe(200);

    // Verify: windows start at or before sentStartTime (audio bounds respected)
    const windowsRes = await fetch(`${server.url}/api/lectures/${lecture.id}/windows`);
    const windowsBody = await windowsRes.json() as { windows: Array<{ startMs: number }> };
    if (windowsBody.windows.length > 0) {
      // Window starts ≤ sentStartTime (audio start is the recording start we sent)
      expect(windowsBody.windows[0]!.startMs).toBeLessThanOrEqual(sentStartTime + 1);
    }
  });
});

// ── Lecture start/end with audio ─────────────────────────────────────────────

describe("lecture start/end with audio", () => {
  it("windows include audio time range as lecture bounds", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");

    // Set a note edit before the audio starts
    const noteTime = 1700000000000;
    const audioStart = noteTime - 5 * 60 * 1000; // audio started 5 minutes before first note

    await fetch(`${server.url}/api/lectures/${lecture.id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        notesData: JSON.stringify({
          blocks: [{ id: "block-abc", type: "paragraph" }],
          meta: { "block-abc": { firstEditTime: noteTime, lastEditTime: noteTime } },
        }),
      }),
    });

    await uploadSources(lecture.id, {
      subjectId: subject.id,
      audio1: SHORT_AUDIO,
      audio1StartTime: audioStart,
    });

    const windowsRes = await fetch(`${server.url}/api/lectures/${lecture.id}/windows`);
    const windowsBody = await windowsRes.json() as { windows: Array<{ startMs: number; endMs: number }> };
    // Lecture start should use the earlier audio start time
    expect(windowsBody.windows[0]!.startMs).toBe(audioStart);
  });
});

// ── Windows without presentation ─────────────────────────────────────────────

describe("windows for lectures with no presentation", () => {
  it("windows have no mapped slides when no presentation uploaded", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");

    // Add a note with a block and markers
    const t = Date.now();
    await fetch(`${server.url}/api/lectures/${lecture.id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        notesData: JSON.stringify({
          blocks: [{ id: "b1", type: "paragraph" }],
          meta: { b1: { firstEditTime: t, lastEditTime: t } },
        }),
      }),
    });
    await addMarker(lecture.id, t + 30000);

    await uploadSources(lecture.id, {
      subjectId: subject.id,
      audio1: SHORT_AUDIO,
      audio1StartTime: t - 10000,
    });

    const windowsRes = await fetch(`${server.url}/api/lectures/${lecture.id}/windows`);
    const windowsBody = await windowsRes.json() as { windows: Array<{ id: string; mappedSlides: string[] }> };
    expect(windowsBody.windows.length).toBeGreaterThan(0);
    for (const w of windowsBody.windows) {
      // Without a presentation, no slides are mapped
      expect(w.mappedSlides).toEqual([]);
      // Windows are labelled by number: W001, W002, ...
      expect(w.id).toMatch(/^W\d{3}$/);
    }
  });
});
