import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture, SlideMarker } from "../../src/shared/types.js";

let server: TestServer;

async function createLecture(): Promise<Lecture> {
  const res = await fetch(`${server.url}/api/lectures`, { method: "POST" });
  return res.json() as Promise<Lecture>;
}

async function postMarker(
  lectureId: string,
  timestamp: number,
  blockId: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${server.url}/api/lectures/${lectureId}/markers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestamp, blockId }),
  });
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(() => {
  server.close();
});

describe("GET /api/lectures/:id/markers", () => {
  it("returns an empty array when no markers exist", async () => {
    const lecture = await createLecture();
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/markers`);
    expect(res.status).toBe(200);
    const markers: SlideMarker[] = await res.json();
    expect(markers).toEqual([]);
  });

  it("returns 404 for unknown lecture", async () => {
    const res = await fetch(`${server.url}/api/lectures/does-not-exist/markers`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/lectures/:id/markers", () => {
  it("creates a marker and returns it", async () => {
    const lecture = await createLecture();
    const ts = Date.now();
    const { status, body } = await postMarker(lecture.id, ts, "block-1");
    expect(status).toBe(201);
    const marker = body as SlideMarker;
    expect(marker.id).toBeTruthy();
    expect(marker.lectureId).toBe(lecture.id);
    expect(marker.timestamp).toBe(ts);
    expect(marker.blockId).toBe("block-1");
  });

  it("returns 404 for unknown lecture", async () => {
    const { status } = await postMarker("no-such-lecture", Date.now(), "b1");
    expect(status).toBe(404);
  });

  it("returns 400 when timestamp is missing", async () => {
    const lecture = await createLecture();
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/markers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blockId: "b1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when blockId is missing", async () => {
    const lecture = await createLecture();
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/markers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timestamp: Date.now() }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/lectures/:id/markers (ordering)", () => {
  it("returns markers ordered by timestamp ascending", async () => {
    const lecture = await createLecture();
    await postMarker(lecture.id, 3000, "b3");
    await postMarker(lecture.id, 1000, "b1");
    await postMarker(lecture.id, 2000, "b2");

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/markers`);
    const markers: SlideMarker[] = await res.json();
    expect(markers.map((m) => m.timestamp)).toEqual([1000, 2000, 3000]);
  });
});

describe("DELETE /api/lectures/:id/markers/:markerId", () => {
  it("deletes a marker and returns 204", async () => {
    const lecture = await createLecture();
    const { body } = await postMarker(lecture.id, Date.now(), "block-1");
    const marker = body as SlideMarker;

    const del = await fetch(
      `${server.url}/api/lectures/${lecture.id}/markers/${marker.id}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(204);

    const list = await fetch(`${server.url}/api/lectures/${lecture.id}/markers`);
    const markers: SlideMarker[] = await list.json();
    expect(markers).toHaveLength(0);
  });

  it("returns 404 for unknown marker", async () => {
    const lecture = await createLecture();
    const del = await fetch(
      `${server.url}/api/lectures/${lecture.id}/markers/no-such-marker`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(404);
  });
});

describe("slide markers survive restart", () => {
  it("create a marker → restart → marker still returned", async () => {
    const { openDb } = await import("../../src/server/db.js");
    const { createApp } = await import("../../src/server/app.js");
    const { createFakeProviders } = await import("../../src/providers/fakes.js");
    const path = await import("path");
    const { AddressInfo } = await import("net");

    const lecture = await createLecture();
    const ts = Date.now();
    await postMarker(lecture.id, ts, "block-xyz");

    server.close();

    const dbPath = path.join(server.dataDir, "notemerge.db");
    const db2 = openDb(dbPath);
    const app2 = createApp(db2, server.dataDir, createFakeProviders());
    const server2 = await new Promise<{ url: string; close: () => void }>((resolve) => {
      const s = app2.listen(0, () => {
        const info = s.address() as typeof AddressInfo;
        const port = (info as unknown as { port: number }).port;
        resolve({ url: `http://localhost:${port}`, close: () => { s.close(); db2.close(); } });
      });
    });

    try {
      const res = await fetch(`${server2.url}/api/lectures/${lecture.id}/markers`);
      expect(res.status).toBe(200);
      const markers: SlideMarker[] = await res.json();
      expect(markers).toHaveLength(1);
      expect(markers[0]!.timestamp).toBe(ts);
    } finally {
      server2.close();
    }
  });
});
