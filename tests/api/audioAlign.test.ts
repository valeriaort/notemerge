import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture } from "../../src/shared/types.js";

let server: TestServer;

async function createLecture(): Promise<Lecture> {
  const res = await fetch(`${server.url}/api/lectures`, { method: "POST" });
  return res.json() as Promise<Lecture>;
}

async function addMarker(
  lectureId: string,
  timestamp: number,
): Promise<{ id: string; timestamp: number }> {
  const res = await fetch(`${server.url}/api/lectures/${lectureId}/markers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestamp, blockId: "block-1" }),
  });
  return res.json() as Promise<{ id: string; timestamp: number }>;
}

async function deriveStart(
  lectureId: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${server.url}/api/lectures/${lectureId}/derive-audio-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(() => {
  server.close();
});

describe("derive-audio-start", () => {
  // Spec example: audio 04:20 = marker 09:14:20 → ~09:10:00
  // 09:14:20 Europe/Madrid on 2024-01-15 = 08:14:20 UTC = 1705306460000 ms
  // 09:10:00 Europe/Madrid on 2024-01-15 = 08:10:00 UTC = 1705306200000 ms
  // audioOffset = 4*60*1000 + 20*1000 = 260000 ms
  const MARKER_TIMESTAMP = 1705306460000; // 09:14:20 Madrid (UTC+1)
  const AUDIO_OFFSET_MS = 4 * 60 * 1000 + 20 * 1000; // 04:20 = 260000 ms
  const EXPECTED_START_MS = 1705306200000; // 09:10:00 Madrid

  it("derives start time from spec example: audio 04:20 at marker 09:14:20 → 09:10:00", async () => {
    const lecture = await createLecture();
    const marker = await addMarker(lecture.id, MARKER_TIMESTAMP);

    const res = await deriveStart(lecture.id, {
      markerId: marker.id,
      audioOffsetMs: AUDIO_OFFSET_MS,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { derivedStartMs: number };
    expect(body.derivedStartMs).toBe(EXPECTED_START_MS);
  });

  it("derivation formula: derivedStartMs = markerTimestamp - audioOffsetMs", async () => {
    const lecture = await createLecture();
    const markerTs = 1_700_000_000_000;
    const offset = 90_000; // 1 min 30 sec
    const marker = await addMarker(lecture.id, markerTs);

    const res = await deriveStart(lecture.id, {
      markerId: marker.id,
      audioOffsetMs: offset,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { derivedStartMs: number };
    expect(body.derivedStartMs).toBe(markerTs - offset);
  });

  it("returns 404 for unknown lecture", async () => {
    const res = await deriveStart("nonexistent-id", {
      markerId: "any",
      audioOffsetMs: 1000,
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when markerId is missing", async () => {
    const lecture = await createLecture();
    const res = await deriveStart(lecture.id, { audioOffsetMs: 1000 });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/marker/i);
  });

  it("returns 400 when audioOffsetMs is missing", async () => {
    const lecture = await createLecture();
    const marker = await addMarker(lecture.id, MARKER_TIMESTAMP);
    const res = await deriveStart(lecture.id, { markerId: marker.id });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/audioOffsetMs/i);
  });

  it("returns 400 when audioOffsetMs is negative", async () => {
    const lecture = await createLecture();
    const marker = await addMarker(lecture.id, MARKER_TIMESTAMP);
    const res = await deriveStart(lecture.id, {
      markerId: marker.id,
      audioOffsetMs: -1000,
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when marker does not belong to the lecture", async () => {
    const lecture1 = await createLecture();
    const lecture2 = await createLecture();
    const marker = await addMarker(lecture1.id, MARKER_TIMESTAMP);

    const res = await deriveStart(lecture2.id, {
      markerId: marker.id,
      audioOffsetMs: AUDIO_OFFSET_MS,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/marker/i);
  });

  it("zero audio offset: derived start equals marker timestamp", async () => {
    const lecture = await createLecture();
    const marker = await addMarker(lecture.id, MARKER_TIMESTAMP);

    const res = await deriveStart(lecture.id, {
      markerId: marker.id,
      audioOffsetMs: 0,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { derivedStartMs: number };
    expect(body.derivedStartMs).toBe(MARKER_TIMESTAMP);
  });
});
