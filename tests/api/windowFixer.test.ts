import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture, SlideWindow } from "../../src/shared/types.js";

type WindowsResponse = { windows: SlideWindow[]; notice?: string };
type FixerResponse = { windows: SlideWindow[] };

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(() => {
  server.close();
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function createLecture(): Promise<Lecture> {
  const res = await fetch(`${server.url}/api/lectures`, { method: "POST" });
  return res.json() as Promise<Lecture>;
}

async function putNotes(
  lectureId: string,
  blocks: Array<{ id: string; firstEditTime: number; lastEditTime?: number }>,
): Promise<void> {
  const meta: Record<string, { firstEditTime: number; lastEditTime: number }> = {};
  const blockArr = blocks.map((b) => {
    meta[b.id] = { firstEditTime: b.firstEditTime, lastEditTime: b.lastEditTime ?? b.firstEditTime };
    return { id: b.id, type: "paragraph", content: [{ type: "text", text: `Block ${b.id}` }], children: [] };
  });
  const notesData = JSON.stringify({ blocks: blockArr, meta });
  await fetch(`${server.url}/api/lectures/${lectureId}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesData }),
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

async function reassignWindow(
  lectureId: string,
  windowId: string,
  mappedSlides: string[],
): Promise<{ status: number; body: FixerResponse | { error: string } }> {
  const res = await fetch(`${server.url}/api/lectures/${lectureId}/windows/${windowId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mappedSlides }),
  });
  return { status: res.status, body: await res.json() as FixerResponse | { error: string } };
}

async function mergeWindows(
  lectureId: string,
  windowIds: [string, string],
): Promise<{ status: number; body: FixerResponse | { error: string } }> {
  const res = await fetch(`${server.url}/api/lectures/${lectureId}/windows/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ windowIds }),
  });
  return { status: res.status, body: await res.json() as FixerResponse | { error: string } };
}

async function deleteWindow(
  lectureId: string,
  windowId: string,
): Promise<{ status: number; body: FixerResponse | { error: string } }> {
  const res = await fetch(`${server.url}/api/lectures/${lectureId}/windows/${windowId}`, {
    method: "DELETE",
  });
  return { status: res.status, body: await res.json() as FixerResponse | { error: string } };
}

// Creates a lecture with 3 windows: W001[1000-4000], W002[4000-7000], W003[7000-10000]
async function lectureWithThreeWindows(): Promise<{ lectureId: string; windows: SlideWindow[] }> {
  const lecture = await createLecture();
  await putNotes(lecture.id, [
    { id: "B1", firstEditTime: 1000, lastEditTime: 10000 },
  ]);
  await postMarker(lecture.id, 4000);
  await postMarker(lecture.id, 7000);
  const { body } = await getWindows(lecture.id);
  return { lectureId: lecture.id, windows: body.windows };
}

// ── reassign ──────────────────────────────────────────────────────────────────

describe("PATCH /api/lectures/:id/windows/:windowId — reassign slides", () => {
  it("returns 404 for unknown lecture", async () => {
    const { status } = await reassignWindow("no-such-lecture", "W001", ["S002"]);
    expect(status).toBe(404);
  });

  it("returns 404 for unknown window ID", async () => {
    const lecture = await createLecture();
    await putNotes(lecture.id, [{ id: "B1", firstEditTime: 1000, lastEditTime: 5000 }]);
    await postMarker(lecture.id, 3000);
    const { status } = await reassignWindow(lecture.id, "W999", ["S001"]);
    expect(status).toBe(404);
  });

  it("returns 400 when mappedSlides is not an array", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    const res = await fetch(`${server.url}/api/lectures/${lectureId}/windows/${windows[0]!.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mappedSlides: "S002" }),
    });
    expect(res.status).toBe(400);
  });

  it("updates a window's mappedSlides", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    const { status, body } = await reassignWindow(lectureId, windows[0]!.id, ["S005", "S006"]);
    expect(status).toBe(200);
    const updated = (body as FixerResponse).windows.find(w => w.id === windows[0]!.id);
    expect(updated!.mappedSlides).toEqual(["S005", "S006"]);
  });

  it("persists the reassignment across GET calls", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    await reassignWindow(lectureId, windows[1]!.id, ["S010"]);
    const { body } = await getWindows(lectureId);
    const w = body.windows.find(w => w.id === windows[1]!.id);
    expect(w!.mappedSlides).toEqual(["S010"]);
  });

  it("time ranges and blockIds are preserved after reassign", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    const before = windows[0]!;
    await reassignWindow(lectureId, before.id, ["S099"]);
    const { body } = await getWindows(lectureId);
    const after = body.windows.find(w => w.id === before.id)!;
    expect(after.startMs).toBe(before.startMs);
    expect(after.endMs).toBe(before.endMs);
    expect(after.blockIds).toEqual(before.blockIds);
  });

  it("clears mappedSlides when set to empty array", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    await reassignWindow(lectureId, windows[0]!.id, []);
    const { body } = await getWindows(lectureId);
    expect(body.windows.find(w => w.id === windows[0]!.id)!.mappedSlides).toEqual([]);
  });
});

// ── many-to-many ──────────────────────────────────────────────────────────────

describe("Many-to-many slide mapping", () => {
  it("a window can map to multiple slides", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    const { status, body } = await reassignWindow(lectureId, windows[0]!.id, ["S001", "S002", "S003"]);
    expect(status).toBe(200);
    const w = (body as FixerResponse).windows.find(w => w.id === windows[0]!.id);
    expect(w!.mappedSlides).toEqual(["S001", "S002", "S003"]);
  });

  it("the same slide can be assigned to multiple windows", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    await reassignWindow(lectureId, windows[0]!.id, ["S001"]);
    await reassignWindow(lectureId, windows[1]!.id, ["S001"]);
    const { body } = await getWindows(lectureId);
    expect(body.windows.find(w => w.id === windows[0]!.id)!.mappedSlides).toContain("S001");
    expect(body.windows.find(w => w.id === windows[1]!.id)!.mappedSlides).toContain("S001");
  });
});

// ── merge ─────────────────────────────────────────────────────────────────────

describe("POST /api/lectures/:id/windows/merge — merge windows", () => {
  it("returns 404 for unknown lecture", async () => {
    const { status } = await mergeWindows("no-such-lecture", ["W001", "W002"]);
    expect(status).toBe(404);
  });

  it("returns 404 when a window ID does not exist", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    const { status } = await mergeWindows(lectureId, [windows[0]!.id, "W999"]);
    expect(status).toBe(404);
  });

  it("returns 400 when windows are not adjacent", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    const { status } = await mergeWindows(lectureId, [windows[0]!.id, windows[2]!.id]);
    expect(status).toBe(400);
  });

  it("returns 400 when windowIds is not an array of two strings", async () => {
    const { lectureId } = await lectureWithThreeWindows();
    const res = await fetch(`${server.url}/api/lectures/${lectureId}/windows/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ windowIds: ["W001"] }),
    });
    expect(res.status).toBe(400);
  });

  it("merging two adjacent windows reduces window count by 1", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    const { status, body } = await mergeWindows(lectureId, [windows[0]!.id, windows[1]!.id]);
    expect(status).toBe(200);
    expect((body as FixerResponse).windows).toHaveLength(2);
  });

  it("merged window spans the combined time range", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    const w1 = windows[0]!;
    const w2 = windows[1]!;
    const { body } = await mergeWindows(lectureId, [w1.id, w2.id]);
    const merged = (body as FixerResponse).windows[0]!;
    expect(merged.startMs).toBe(w1.startMs);
    expect(merged.endMs).toBe(w2.endMs);
  });

  it("merged window has the union of both windows' mappedSlides", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    await reassignWindow(lectureId, windows[0]!.id, ["S001"]);
    await reassignWindow(lectureId, windows[1]!.id, ["S002"]);
    const { body } = await mergeWindows(lectureId, [windows[0]!.id, windows[1]!.id]);
    const merged = (body as FixerResponse).windows[0]!;
    expect(merged.mappedSlides).toContain("S001");
    expect(merged.mappedSlides).toContain("S002");
  });

  it("windows still tile with no gaps after merge", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    await mergeWindows(lectureId, [windows[0]!.id, windows[1]!.id]);
    const { body } = await getWindows(lectureId);
    const ws = body.windows;
    for (let i = 0; i < ws.length - 1; i++) {
      expect(ws[i]!.endMs).toBe(ws[i + 1]!.startMs);
    }
  });

  it("blocks from both windows are in the merged window", async () => {
    const lecture = await createLecture();
    await putNotes(lecture.id, [
      { id: "B1", firstEditTime: 1000 },
      { id: "B2", firstEditTime: 5000 },
      { id: "B3", firstEditTime: 8000 },
    ]);
    await postMarker(lecture.id, 4000);
    await postMarker(lecture.id, 7000);
    const { body: before } = await getWindows(lecture.id);
    const [w1, w2] = before.windows;
    await mergeWindows(lecture.id, [w1!.id, w2!.id]);
    const { body: after } = await getWindows(lecture.id);
    const merged = after.windows[0]!;
    expect(merged.blockIds).toContain("B1");
    expect(merged.blockIds).toContain("B2");
    expect(after.windows[1]!.blockIds).toContain("B3");
  });

  it("merge works with IDs given in reverse order", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    const { status, body } = await mergeWindows(lectureId, [windows[1]!.id, windows[0]!.id]);
    expect(status).toBe(200);
    expect((body as FixerResponse).windows).toHaveLength(2);
    expect((body as FixerResponse).windows[0]!.startMs).toBe(windows[0]!.startMs);
    expect((body as FixerResponse).windows[0]!.endMs).toBe(windows[1]!.endMs);
  });

  it("merge persists across GET calls", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    await mergeWindows(lectureId, [windows[0]!.id, windows[1]!.id]);
    const { body } = await getWindows(lectureId);
    expect(body.windows).toHaveLength(2);
  });
});

// ── delete ────────────────────────────────────────────────────────────────────

describe("DELETE /api/lectures/:id/windows/:windowId — delete window", () => {
  it("returns 404 for unknown lecture", async () => {
    const { status } = await deleteWindow("no-such-lecture", "W001");
    expect(status).toBe(404);
  });

  it("returns 404 for unknown window ID", async () => {
    const { lectureId } = await lectureWithThreeWindows();
    const { status } = await deleteWindow(lectureId, "W999");
    expect(status).toBe(404);
  });

  it("refuses to delete the only window", async () => {
    const lecture = await createLecture();
    await putNotes(lecture.id, [{ id: "B1", firstEditTime: 1000, lastEditTime: 5000 }]);
    // No markers → one window (or 4-min windows). Force to single window.
    await postMarker(lecture.id, 3000);
    const { body: wb } = await getWindows(lecture.id);
    // Merge all windows down to one
    while (wb.windows.length > 1) {
      const [a, b] = wb.windows;
      await mergeWindows(lecture.id, [a!.id, b!.id]);
      const { body: fresh } = await getWindows(lecture.id);
      wb.windows = fresh.windows;
    }
    const { status } = await deleteWindow(lecture.id, wb.windows[0]!.id);
    expect(status).toBe(403);
  });

  it("deleting a middle window: previous window extends to cover deleted range", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    const [w1, w2, w3] = windows;
    // Delete middle window W002
    const { body } = await deleteWindow(lectureId, w2!.id);
    const result = (body as FixerResponse).windows;
    expect(result).toHaveLength(2);
    // W001 now extends to W002's original end
    const newW1 = result.find(w => w.id === w1!.id)!;
    expect(newW1.startMs).toBe(w1!.startMs);
    expect(newW1.endMs).toBe(w2!.endMs);
    // W003 is unchanged
    const newW3 = result.find(w => w.id === w3!.id)!;
    expect(newW3.startMs).toBe(w2!.endMs); // immediately after where W002 ended
    expect(newW3.endMs).toBe(w3!.endMs);
  });

  it("deleting the first window: next window extends back to lecture start", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    const [w1, w2, w3] = windows;
    const { body } = await deleteWindow(lectureId, w1!.id);
    const result = (body as FixerResponse).windows;
    expect(result).toHaveLength(2);
    // W002 now starts at lecture start (W001's startMs)
    const newW2 = result[0]!;
    expect(newW2.id).toBe(w2!.id);
    expect(newW2.startMs).toBe(w1!.startMs);
    expect(newW2.endMs).toBe(w2!.endMs);
    // W003 unchanged
    const newW3 = result[1]!;
    expect(newW3.id).toBe(w3!.id);
    expect(newW3.endMs).toBe(w3!.endMs);
  });

  it("deleting the last window: previous window extends to lecture end", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    const [w1, w2, w3] = windows;
    const { body } = await deleteWindow(lectureId, w3!.id);
    const result = (body as FixerResponse).windows;
    expect(result).toHaveLength(2);
    // W002 now extends to lecture end (W003's endMs)
    const newW2 = result.find(w => w.id === w2!.id)!;
    expect(newW2.startMs).toBe(w2!.startMs);
    expect(newW2.endMs).toBe(w3!.endMs);
    // W001 unchanged
    expect(result.find(w => w.id === w1!.id)!.endMs).toBe(w1!.endMs);
  });

  it("deleted window's slides are dropped (not transferred to adjacent window)", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    const [w1, w2] = windows;
    await reassignWindow(lectureId, w2!.id, ["S010"]);
    const { body } = await deleteWindow(lectureId, w2!.id);
    const result = (body as FixerResponse).windows;
    const newW1 = result.find(w => w.id === w1!.id)!;
    // W002's slides (S010) must not appear in W001
    expect(newW1.mappedSlides).not.toContain("S010");
  });

  it("other windows' mappings are unchanged by delete", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    const [w1, w2, w3] = windows;
    await reassignWindow(lectureId, w1!.id, ["S001"]);
    await reassignWindow(lectureId, w3!.id, ["S007"]);
    await deleteWindow(lectureId, w2!.id);
    const { body } = await getWindows(lectureId);
    expect(body.windows.find(w => w.id === w1!.id)!.mappedSlides).toEqual(["S001"]);
    expect(body.windows.find(w => w.id === w3!.id)!.mappedSlides).toEqual(["S007"]);
  });

  it("notes in the deleted window now belong to the previous window", async () => {
    const lecture = await createLecture();
    await putNotes(lecture.id, [
      { id: "B1", firstEditTime: 1000 },
      { id: "B2", firstEditTime: 5000 }, // in W002
    ]);
    await postMarker(lecture.id, 4000);
    await postMarker(lecture.id, 7000);
    const { body: before } = await getWindows(lecture.id);
    const [w1, w2] = before.windows;
    expect(w2!.blockIds).toContain("B2");
    // Delete W002; B2 should now be in W001
    await deleteWindow(lecture.id, w2!.id);
    const { body: after } = await getWindows(lecture.id);
    const newW1 = after.windows.find(w => w.id === w1!.id)!;
    expect(newW1.blockIds).toContain("B2");
  });

  it("windows still tile after delete", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    await deleteWindow(lectureId, windows[1]!.id);
    const { body } = await getWindows(lectureId);
    const ws = body.windows;
    for (let i = 0; i < ws.length - 1; i++) {
      expect(ws[i]!.endMs).toBe(ws[i + 1]!.startMs);
    }
  });

  it("delete persists across GET calls", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    await deleteWindow(lectureId, windows[1]!.id);
    const { body } = await getWindows(lectureId);
    expect(body.windows).toHaveLength(2);
    expect(body.windows.find(w => w.id === windows[1]!.id)).toBeUndefined();
  });
});

// ── markers untouched ─────────────────────────────────────────────────────────

describe("Markers are untouched by fixer operations", () => {
  it("slide markers are unchanged after delete/merge/reassign", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    const markersBefore = await fetch(`${server.url}/api/lectures/${lectureId}/markers`).then(r => r.json()) as object[];

    await reassignWindow(lectureId, windows[0]!.id, ["S099"]);
    await mergeWindows(lectureId, [windows[1]!.id, windows[2]!.id]);
    await deleteWindow(lectureId, windows[0]!.id);

    const markersAfter = await fetch(`${server.url}/api/lectures/${lectureId}/markers`).then(r => r.json()) as object[];
    expect(markersAfter).toEqual(markersBefore);
  });
});

// ── gating ────────────────────────────────────────────────────────────────────

describe("Mapping edits are blocked after merge starts", () => {
  async function advanceToMerge(lectureId: string): Promise<void> {
    server.db.prepare("UPDATE lectures SET stage = 'merge' WHERE id = ?").run(lectureId);
  }

  it("reassign returns 403 when stage is 'merge'", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    await advanceToMerge(lectureId);
    const { status } = await reassignWindow(lectureId, windows[0]!.id, ["S001"]);
    expect(status).toBe(403);
  });

  it("merge returns 403 when stage is 'merge'", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    await advanceToMerge(lectureId);
    const { status } = await mergeWindows(lectureId, [windows[0]!.id, windows[1]!.id]);
    expect(status).toBe(403);
  });

  it("delete returns 403 when stage is 'merge'", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    await advanceToMerge(lectureId);
    const { status } = await deleteWindow(lectureId, windows[0]!.id);
    expect(status).toBe(403);
  });

  it("reassign returns 403 when stage is 'review'", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    server.db.prepare("UPDATE lectures SET stage = 'review' WHERE id = ?").run(lectureId);
    const { status } = await reassignWindow(lectureId, windows[0]!.id, ["S001"]);
    expect(status).toBe(403);
  });

  it("fixer works when stage is 'sealed'", async () => {
    const { lectureId, windows } = await lectureWithThreeWindows();
    server.db.prepare("UPDATE lectures SET stage = 'sealed' WHERE id = ?").run(lectureId);
    const { status } = await reassignWindow(lectureId, windows[0]!.id, ["S001"]);
    expect(status).toBe(200);
  });
});
