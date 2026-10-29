import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "fs";
import path from "path";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture } from "../../src/shared/types.js";
import { notionCallbackUri } from "../../src/server/config.js";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { createFakeProviders } from "../../src/providers/fakes.js";
import type { AddressInfo } from "net";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(() => {
  server.close();
});

describe("POST /api/lectures", () => {
  it("creates a lecture with no subject", async () => {
    const res = await fetch(`${server.url}/api/lectures`, { method: "POST" });
    expect(res.status).toBe(201);
    const lecture: Lecture = await res.json();
    expect(lecture.id).toBeTruthy();
    expect(lecture.stage).toBe("writing");
    expect(lecture.subjectId).toBeNull();
    expect(lecture.notesData).toBe('{"blocks":[],"meta":{}}');
  });

  it("creates a per-lecture folder on disk", async () => {
    const res = await fetch(`${server.url}/api/lectures`, { method: "POST" });
    const lecture: Lecture = await res.json();
    const lectureDir = path.join(server.dataDir, lecture.id);
    expect(existsSync(lectureDir)).toBe(true);
  });

  it("creates a user row that owns the lecture", async () => {
    const res = await fetch(`${server.url}/api/lectures`, { method: "POST" });
    const lecture: Lecture = await res.json();
    expect(lecture.userId).toBeTruthy();
  });
});

describe("GET /api/lectures", () => {
  it("lists created lectures", async () => {
    await fetch(`${server.url}/api/lectures`, { method: "POST" });
    await fetch(`${server.url}/api/lectures`, { method: "POST" });

    const res = await fetch(`${server.url}/api/lectures`);
    const lectures: Lecture[] = await res.json();
    expect(lectures.length).toBe(2);
  });

  it("returns empty array when no lectures", async () => {
    const res = await fetch(`${server.url}/api/lectures`);
    const lectures: Lecture[] = await res.json();
    expect(lectures).toEqual([]);
  });
});

describe("GET /api/lectures/:id", () => {
  it("returns a lecture by id", async () => {
    const created: Lecture = await (
      await fetch(`${server.url}/api/lectures`, { method: "POST" })
    ).json();

    const res = await fetch(`${server.url}/api/lectures/${created.id}`);
    expect(res.status).toBe(200);
    const lecture: Lecture = await res.json();
    expect(lecture.id).toBe(created.id);
  });

  it("returns 404 for unknown id", async () => {
    const res = await fetch(`${server.url}/api/lectures/does-not-exist`);
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/lectures/:id/notes", () => {
  it("saves notes and returns the updated lecture", async () => {
    const created: Lecture = await (
      await fetch(`${server.url}/api/lectures`, { method: "POST" })
    ).json();

    const notes = JSON.stringify([{ id: "b1", text: "First note" }]);
    const res = await fetch(`${server.url}/api/lectures/${created.id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notesData: notes }),
    });
    expect(res.status).toBe(200);
    const updated: Lecture = await res.json();
    expect(updated.notesData).toBe(notes);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it("returns 404 for unknown lecture", async () => {
    const res = await fetch(`${server.url}/api/lectures/nope/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notesData: "[]" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when notesData is missing", async () => {
    const created: Lecture = await (
      await fetch(`${server.url}/api/lectures`, { method: "POST" })
    ).json();

    const res = await fetch(`${server.url}/api/lectures/${created.id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("notes persistence across restart", () => {
  it("create → save → restart → reopen returns saved notes", async () => {
    // Create and save notes
    const created: Lecture = await (
      await fetch(`${server.url}/api/lectures`, { method: "POST" })
    ).json();

    const notes = JSON.stringify([{ id: "b1", text: "Persisted content" }]);
    await fetch(`${server.url}/api/lectures/${created.id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notesData: notes }),
    });

    // Simulate restart: close the server and open a new one on the same data dir
    server.close();

    const dbPath = path.join(server.dataDir, "notemerge.db");
    const db2 = openDb(dbPath);
    const app2 = createApp(db2, server.dataDir, createFakeProviders());
    const server2 = await new Promise<{ url: string; close: () => void }>((resolve) => {
      const s = app2.listen(0, () => {
        const { port } = s.address() as AddressInfo;
        resolve({ url: `http://localhost:${port}`, close: () => { s.close(); db2.close(); } });
      });
    });

    try {
      const res = await fetch(`${server2.url}/api/lectures/${created.id}`);
      expect(res.status).toBe(200);
      const reopened: Lecture = await res.json();
      expect(reopened.notesData).toBe(notes);
    } finally {
      server2.close();
    }
  });
});

describe("block IDs and metadata persistence", () => {
  it("saves and reloads a NotesDocument with stable block IDs and edit times", async () => {
    const created: Lecture = await (
      await fetch(`${server.url}/api/lectures`, { method: "POST" })
    ).json();

    const notesDoc = JSON.stringify({
      blocks: [
        {
          id: "block-abc",
          type: "paragraph",
          props: {},
          content: [{ type: "text", text: "First note", styles: {} }],
          children: [],
        },
      ],
      meta: {
        "block-abc": { firstEditTime: 1700000000000, lastEditTime: 1700000001000 },
      },
    });

    const res = await fetch(`${server.url}/api/lectures/${created.id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notesData: notesDoc }),
    });
    expect(res.status).toBe(200);

    // Reload from the API — block ID and times must survive round-trip
    const reloaded: Lecture = await (
      await fetch(`${server.url}/api/lectures/${created.id}`)
    ).json();

    const doc = JSON.parse(reloaded.notesData);
    expect(doc.blocks[0].id).toBe("block-abc");
    expect(doc.meta["block-abc"].firstEditTime).toBe(1700000000000);
    expect(doc.meta["block-abc"].lastEditTime).toBe(1700000001000);
  });

  it("a new lecture starts with an empty blocks array", async () => {
    const res = await fetch(`${server.url}/api/lectures`, { method: "POST" });
    const lecture: Lecture = await res.json();
    const doc = JSON.parse(lecture.notesData);
    expect(doc.blocks).toEqual([]);
    expect(doc.meta).toEqual({});
  });
});

describe("config", () => {
  it("Notion redirect URI from default config is http://localhost:3000/api/notion/callback", () => {
    expect(notionCallbackUri(3000)).toBe("http://localhost:3000/api/notion/callback");
  });
});

describe("GET /api/notion/callback", () => {
  it("returns 400 when no code is provided", async () => {
    const res = await fetch(`${server.url}/api/notion/callback`);
    expect(res.status).toBe(400);
  });
});
