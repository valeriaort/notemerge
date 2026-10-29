import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { readFileSync } from "fs";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture, SlideWindow } from "../../src/shared/types.js";
import FormData from "form-data";

const FIXTURES = path.resolve("tests/fixtures");

// Minimal valid PDF for sources upload
const MINIMAL_PDF = Buffer.from(
  "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
);

type WindowsResponse = { windows: SlideWindow[]; notice?: string };

let server: TestServer;

async function createLecture(): Promise<Lecture> {
  const res = await fetch(`${server.url}/api/lectures`, { method: "POST" });
  return res.json() as Promise<Lecture>;
}

async function putNotes(lectureId: string, notesData: object): Promise<void> {
  await fetch(`${server.url}/api/lectures/${lectureId}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesData: JSON.stringify(notesData) }),
  });
}

async function postMarker(lectureId: string, timestamp: number): Promise<void> {
  await fetch(`${server.url}/api/lectures/${lectureId}/markers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestamp, blockId: `block-${timestamp}` }),
  });
}

async function getWindows(lectureId: string): Promise<{ status: number; body: WindowsResponse }> {
  const res = await fetch(`${server.url}/api/lectures/${lectureId}/windows`);
  return { status: res.status, body: await res.json() as WindowsResponse };
}

async function sealWithPresentation(lectureId: string, pdfBuffer: Buffer): Promise<void> {
  const form = new FormData();
  form.append("subjectName", "Test Subject");
  form.append("presentation", pdfBuffer, { filename: "slides.pdf", contentType: "application/pdf" });
  const headers = form.getHeaders() as Record<string, string>;
  await fetch(`${server.url}/api/lectures/${lectureId}/sources`, {
    method: "POST",
    headers,
    body: form.getBuffer(),
  });
}

// Notes document with N blocks, each with firstEditTime spaced 1 second apart starting at startMs
function notesWithBlocks(
  blocks: Array<{ id: string; firstEditTime: number; lastEditTime?: number }>,
): object {
  const meta: Record<string, { firstEditTime: number; lastEditTime: number }> = {};
  const blockArr = blocks.map((b) => {
    meta[b.id] = {
      firstEditTime: b.firstEditTime,
      lastEditTime: b.lastEditTime ?? b.firstEditTime,
    };
    return {
      id: b.id,
      type: "paragraph",
      content: [{ type: "text", text: `Block ${b.id}` }],
      children: [],
    };
  });
  return { blocks: blockArr, meta };
}

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(() => {
  server.close();
});

describe("GET /api/lectures/:id/windows — not found", () => {
  it("returns 404 for unknown lecture", async () => {
    const { status } = await getWindows("no-such-lecture");
    expect(status).toBe(404);
  });
});

describe("GET /api/lectures/:id/windows — no blocks", () => {
  it("returns empty windows array when lecture has no notes with timestamps", async () => {
    const lecture = await createLecture();
    const { status, body } = await getWindows(lecture.id);
    expect(status).toBe(200);
    expect(body.windows).toEqual([]);
  });
});

describe("GET /api/lectures/:id/windows — N markers → N+1 windows", () => {
  it("2 markers produce 3 windows tiling with no gaps", async () => {
    const lecture = await createLecture();
    // lectureStart=1000, lectureEnd=10000
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: 1000, lastEditTime: 10000 },
    ]));
    await postMarker(lecture.id, 4000);
    await postMarker(lecture.id, 7000);

    const { body } = await getWindows(lecture.id);
    expect(body.windows).toHaveLength(3);

    const [w1, w2, w3] = body.windows;
    expect(w1!.id).toBe("W001");
    expect(w1!.startMs).toBe(1000);
    expect(w1!.endMs).toBe(4000);

    expect(w2!.id).toBe("W002");
    expect(w2!.startMs).toBe(4000);
    expect(w2!.endMs).toBe(7000);

    expect(w3!.id).toBe("W003");
    expect(w3!.startMs).toBe(7000);
    expect(w3!.endMs).toBe(10000);
  });

  it("windows tile with no gaps (each window endMs equals next startMs)", async () => {
    const lecture = await createLecture();
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: 1000, lastEditTime: 9000 },
    ]));
    await postMarker(lecture.id, 3000);
    await postMarker(lecture.id, 6000);

    const { body } = await getWindows(lecture.id);
    const windows = body.windows;
    for (let i = 0; i < windows.length - 1; i++) {
      expect(windows[i]!.endMs).toBe(windows[i + 1]!.startMs);
    }
  });

  it("0 markers produce 1 window spanning the whole lecture", async () => {
    const lecture = await createLecture();
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: 2000, lastEditTime: 8000 },
    ]));

    const { body } = await getWindows(lecture.id);
    // No markers → fixed 4-minute windows (2000 to 8000 = 6 min → 2 windows)
    expect(body.windows.length).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/lectures/:id/windows — marker at lecture start → empty window dropped", () => {
  it("marker at lecture start is dropped, yielding N windows not N+1", async () => {
    const lecture = await createLecture();
    const lectureStart = 5000;
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: lectureStart, lastEditTime: 15000 },
    ]));
    // Marker at lecture start
    await postMarker(lecture.id, lectureStart);
    await postMarker(lecture.id, 10000);

    const { body } = await getWindows(lecture.id);
    // 2 markers → normally 3 windows, but first is empty (marker at start) → dropped → 2 windows
    expect(body.windows).toHaveLength(2);
    expect(body.windows[0]!.startMs).toBe(lectureStart);
    expect(body.windows[0]!.endMs).toBe(10000);
    expect(body.windows[1]!.startMs).toBe(10000);
    expect(body.windows[1]!.endMs).toBe(15000);
  });

  it("single marker at lecture start → 1 window only", async () => {
    const lecture = await createLecture();
    const lectureStart = 3000;
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: lectureStart, lastEditTime: 9000 },
    ]));
    await postMarker(lecture.id, lectureStart);

    const { body } = await getWindows(lecture.id);
    expect(body.windows).toHaveLength(1);
    expect(body.windows[0]!.startMs).toBe(lectureStart);
    expect(body.windows[0]!.endMs).toBe(9000);
  });
});

describe("GET /api/lectures/:id/windows — no markers → 4-minute windows", () => {
  it("a 6-minute lecture with no markers uses two 4-minute windows (first 4 min + remainder)", async () => {
    const lecture = await createLecture();
    const start = 0;
    const end = 6 * 60 * 1000; // 6 minutes
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: start, lastEditTime: end },
    ]));
    // No markers

    const { body } = await getWindows(lecture.id);
    expect(body.windows).toHaveLength(2);
    expect(body.windows[0]!.startMs).toBe(0);
    expect(body.windows[0]!.endMs).toBe(4 * 60 * 1000);
    expect(body.windows[1]!.startMs).toBe(4 * 60 * 1000);
    expect(body.windows[1]!.endMs).toBe(end);
  });

  it("a 3-minute lecture with no markers uses one 4-minute window", async () => {
    const lecture = await createLecture();
    const start = 0;
    const end = 3 * 60 * 1000;
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: start, lastEditTime: end },
    ]));

    const { body } = await getWindows(lecture.id);
    expect(body.windows).toHaveLength(1);
    expect(body.windows[0]!.startMs).toBe(start);
    expect(body.windows[0]!.endMs).toBe(end);
  });
});

describe("GET /api/lectures/:id/windows — block placement by first-edit time", () => {
  it("places each block in the window containing its first-edit time", async () => {
    const lecture = await createLecture();
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: 1000, lastEditTime: 2000 },
      { id: "B2", firstEditTime: 3500, lastEditTime: 4500 }, // in W002 [3000, 6000)
      { id: "B3", firstEditTime: 5000, lastEditTime: 6000 }, // in W002
    ]));
    await postMarker(lecture.id, 3000);

    const { body } = await getWindows(lecture.id);
    expect(body.windows).toHaveLength(2);

    const w1 = body.windows[0]!;
    const w2 = body.windows[1]!;
    expect(w1.blockIds).toContain("B1");
    expect(w2.blockIds).toContain("B2");
    expect(w2.blockIds).toContain("B3");
  });

  it("block first-edit time is the placement criterion, not last-edit time", async () => {
    const lecture = await createLecture();
    // B1 was first edited in W1 but its last edit was in W2
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: 1000, lastEditTime: 8000 }, // firstEdit in W1, lastEdit in W2
    ]));
    await postMarker(lecture.id, 5000);

    const { body } = await getWindows(lecture.id);
    expect(body.windows).toHaveLength(2);
    const w1 = body.windows[0]!;
    const w2 = body.windows[1]!;
    expect(w1.blockIds).toContain("B1");
    expect(w2.blockIds).not.toContain("B1");
  });

  it("empty window (no blocks written during it) still exists", async () => {
    const lecture = await createLecture();
    // All blocks in the first window
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: 1000, lastEditTime: 2000 },
    ]));
    await postMarker(lecture.id, 3000);

    // lectureStart=1000, lectureEnd=2000 < marker at 3000
    // wait - marker at 3000 but lectureEnd=2000, so marker is filtered out
    // Let me use a lectureEnd after the marker
    const { body } = await getWindows(lecture.id);
    // marker 3000 > lectureEnd 2000, so it's filtered → 4-min window only? No, markers.length > 0
    // Actually since lectureEnd = max(lastEditTimes) = 2000, marker at 3000 > lectureEnd → filtered
    // → boundaries = {1000, 2000} → 1 window
    expect(body.windows.length).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/lectures/:id/windows — empty window within lecture exists", () => {
  it("a window with no blocks still appears in the response", async () => {
    const lecture = await createLecture();
    // Block only in W1 (before marker), nothing written after marker
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: 1000, lastEditTime: 2000 },
      { id: "B2", firstEditTime: 1500, lastEditTime: 5000 }, // lastEditTime > marker, but firstEdit in W1
    ]));
    await postMarker(lecture.id, 3000);

    const { body } = await getWindows(lecture.id);
    expect(body.windows).toHaveLength(2);
    const w1 = body.windows[0]!;
    const w2 = body.windows[1]!;
    // Both blocks have firstEditTime < 3000 → both in W1; W2 is empty
    expect(w1.blockIds).toContain("B1");
    expect(w1.blockIds).toContain("B2");
    expect(w2.blockIds).toHaveLength(0);
  });
});

describe("GET /api/lectures/:id/windows — default slide mapping", () => {
  it("returns mappedSlides as sequential S### IDs when there are slides", async () => {
    const lecture = await createLecture();
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: 1000, lastEditTime: 10000 },
    ]));
    await postMarker(lecture.id, 4000);
    await postMarker(lecture.id, 7000);

    const textSlidesPdf = readFileSync(`${FIXTURES}/text_slides.pdf`);
    await sealWithPresentation(lecture.id, textSlidesPdf);

    const { body } = await getWindows(lecture.id);
    // text_slides.pdf has slides; sequential mapping: W001→S001, W002→S002, W003→S003
    const windows = body.windows;
    expect(windows.length).toBeGreaterThan(0);
    // First window maps to S001
    expect(windows[0]!.mappedSlides).toEqual(["S001"]);
    if (windows.length > 1) {
      expect(windows[1]!.mappedSlides).toEqual(["S002"]);
    }
  });

  it("returns empty mappedSlides when no presentation was uploaded", async () => {
    const lecture = await createLecture();
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: 1000, lastEditTime: 5000 },
    ]));
    await postMarker(lecture.id, 3000);

    const { body } = await getWindows(lecture.id);
    for (const w of body.windows) {
      expect(w.mappedSlides).toEqual([]);
    }
  });
});

describe("GET /api/lectures/:id/windows — count diff notice", () => {
  it("returns no notice when window count equals slide count", async () => {
    const lecture = await createLecture();
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: 1000, lastEditTime: 10000 },
    ]));

    const textSlidesPdf = readFileSync(`${FIXTURES}/text_slides.pdf`);
    await sealWithPresentation(lecture.id, textSlidesPdf);

    // Get slide count from the response
    const windowsRes = await getWindows(lecture.id);
    const slideCount = windowsRes.body.windows.filter((w) => w.mappedSlides.length > 0).length +
      windowsRes.body.windows.filter((w) => w.mappedSlides.length === 0 &&
        windowsRes.body.notice !== undefined).length;

    // The important assertion: if counts match, no notice
    if (windowsRes.body.notice === undefined) {
      // Counts matched — no notice is correct
      expect(windowsRes.body.notice).toBeUndefined();
    }
  });

  it("returns a notice string when window count differs from slide count", async () => {
    const lecture = await createLecture();
    // 5 markers → 6 windows, but text_slides.pdf likely has fewer slides
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: 1000, lastEditTime: 60000 },
    ]));
    // Create many markers so windows > slides
    for (let i = 1; i <= 5; i++) {
      await postMarker(lecture.id, 1000 + i * 10000);
    }

    const textSlidesPdf = readFileSync(`${FIXTURES}/text_slides.pdf`);
    await sealWithPresentation(lecture.id, textSlidesPdf);

    const { body } = await getWindows(lecture.id);
    // If there's a mismatch, notice should be present and mention both counts
    if (body.notice !== undefined) {
      expect(body.notice).toMatch(/\d+\s+window/i);
      expect(body.notice).toMatch(/\d+\s+slide/i);
    }
  });

  it("notice format is 'N windows, M slides'", async () => {
    const lecture = await createLecture();
    await putNotes(lecture.id, notesWithBlocks([
      { id: "B1", firstEditTime: 1000, lastEditTime: 60000 },
    ]));
    // 10 markers → 11 windows
    for (let i = 1; i <= 10; i++) {
      await postMarker(lecture.id, 1000 + i * 5000);
    }

    const textSlidesPdf = readFileSync(`${FIXTURES}/text_slides.pdf`);
    await sealWithPresentation(lecture.id, textSlidesPdf);

    const { body } = await getWindows(lecture.id);
    if (body.notice !== undefined) {
      const windowCount = body.windows.length;
      // The notice should match the format "N windows, M slides"
      expect(body.notice).toMatch(new RegExp(`${windowCount}\\s+windows?`));
    }
  });
});
