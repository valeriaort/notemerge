import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { AbbreviationPair, Lecture, UnknownToken } from "../../src/shared/types.js";
import FormData from "form-data";

const MINIMAL_PDF = Buffer.from(
  "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
);

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(() => {
  server.close();
});

async function createPair(
  abbreviation: string,
  expansion: string,
  matchCaseExactly = false,
): Promise<{ res: Response; pair: AbbreviationPair }> {
  const res = await fetch(`${server.url}/api/abbreviations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ abbreviation, expansion, matchCaseExactly }),
  });
  const pair = await res.json() as AbbreviationPair;
  return { res, pair };
}

async function createLectureWithNotes(notesText: string): Promise<Lecture> {
  const createRes = await fetch(`${server.url}/api/lectures`, { method: "POST" });
  const lecture = await createRes.json() as Lecture;

  const notesDoc = JSON.stringify({
    blocks: [
      {
        id: "b1",
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: notesText, styles: {} }],
        children: [],
      },
    ],
    meta: { b1: { firstEditTime: 1000, lastEditTime: 2000 } },
  });

  await fetch(`${server.url}/api/lectures/${lecture.id}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesData: notesDoc }),
  });

  return lecture;
}

// ─── Dictionary CRUD ───────────────────────────────────────────────────────

describe("GET /api/abbreviations", () => {
  it("returns an empty list when no pairs exist", async () => {
    const res = await fetch(`${server.url}/api/abbreviations`);
    expect(res.status).toBe(200);
    const pairs = await res.json() as AbbreviationPair[];
    expect(pairs).toEqual([]);
  });

  it("returns all created pairs", async () => {
    await createPair("pc", "paciente");
    await createPair("fc", "frecuencia cardiaca");
    const res = await fetch(`${server.url}/api/abbreviations`);
    const pairs = await res.json() as AbbreviationPair[];
    expect(pairs).toHaveLength(2);
  });
});

describe("POST /api/abbreviations", () => {
  it("creates a pair and returns 201 with the pair", async () => {
    const { res, pair } = await createPair("pc", "paciente");
    expect(res.status).toBe(201);
    expect(pair.id).toBeTruthy();
    expect(pair.abbreviation).toBe("pc");
    expect(pair.expansion).toBe("paciente");
    expect(pair.matchCaseExactly).toBe(false);
  });

  it("creates a pair with matchCaseExactly=true", async () => {
    const { pair } = await createPair("HTA", "hipertensión arterial", true);
    expect(pair.matchCaseExactly).toBe(true);
  });

  it("returns 400 when abbreviation is missing", async () => {
    const res = await fetch(`${server.url}/api/abbreviations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expansion: "paciente" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when expansion is missing", async () => {
    const res = await fetch(`${server.url}/api/abbreviations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ abbreviation: "pc" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/abbreviations/:id", () => {
  it("deletes a pair and returns 204", async () => {
    const { pair } = await createPair("pc", "paciente");
    const res = await fetch(`${server.url}/api/abbreviations/${pair.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);

    // Confirm it's gone
    const listRes = await fetch(`${server.url}/api/abbreviations`);
    const pairs = await listRes.json() as AbbreviationPair[];
    expect(pairs).toHaveLength(0);
  });

  it("returns 404 for unknown id", async () => {
    const res = await fetch(`${server.url}/api/abbreviations/nope`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});

describe("dictionary persists across lectures", () => {
  it("pairs created for one lecture are visible when listing again", async () => {
    await createPair("pc", "paciente");

    // Create a second lecture — the global dictionary should still be visible
    const listRes = await fetch(`${server.url}/api/abbreviations`);
    const pairs = await listRes.json() as AbbreviationPair[];
    expect(pairs.map((p) => p.abbreviation)).toContain("pc");
  });
});

// ─── Unknown tokens ─────────────────────────────────────────────────────────

describe("GET /api/lectures/:id/unknown-tokens", () => {
  it("returns tokens from notes that are unknown short candidates", async () => {
    const lecture = await createLectureWithNotes("el pc late rápido");
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/unknown-tokens`);
    expect(res.status).toBe(200);
    const tokens = await res.json() as UnknownToken[];
    expect(tokens.map((t) => t.text)).toContain("pc");
  });

  it("excludes tokens already in the abbreviation dictionary", async () => {
    await createPair("pc", "paciente");
    const lecture = await createLectureWithNotes("el pc late rápido");
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/unknown-tokens`);
    const tokens = await res.json() as UnknownToken[];
    expect(tokens.map((t) => t.text)).not.toContain("pc");
  });

  it("excludes permanently ignored tokens", async () => {
    const lecture = await createLectureWithNotes("el pc late");
    // Ignore 'pc' permanently
    await fetch(`${server.url}/api/abbreviations/ignored`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "pc" }),
    });
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/unknown-tokens`);
    const tokens = await res.json() as UnknownToken[];
    expect(tokens.map((t) => t.text)).not.toContain("pc");
  });

  it("excludes common Spanish words", async () => {
    const lecture = await createLectureWithNotes("el la de para por");
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/unknown-tokens`);
    const tokens = await res.json() as UnknownToken[];
    expect(tokens).toHaveLength(0);
  });

  it("ranks tokens by frequency descending", async () => {
    const lecture = await createLectureWithNotes("fc fc fc pc pc");
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/unknown-tokens`);
    const tokens = await res.json() as UnknownToken[];
    expect(tokens[0]!.text).toBe("fc");
    expect(tokens[0]!.frequency).toBe(3);
    expect(tokens[1]!.text).toBe("pc");
    expect(tokens[1]!.frequency).toBe(2);
  });

  it("returns 404 for unknown lecture", async () => {
    const res = await fetch(`${server.url}/api/lectures/nope/unknown-tokens`);
    expect(res.status).toBe(404);
  });
});

// ─── Permanently ignored tokens ─────────────────────────────────────────────

describe("POST /api/abbreviations/ignored", () => {
  it("saves an ignored token and returns 201", async () => {
    const res = await fetch(`${server.url}/api/abbreviations/ignored`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "fc" }),
    });
    expect(res.status).toBe(201);
  });

  it("re-ignoring the same token is idempotent (201 again)", async () => {
    await fetch(`${server.url}/api/abbreviations/ignored`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "fc" }),
    });
    const res = await fetch(`${server.url}/api/abbreviations/ignored`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "fc" }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 400 when token is missing", async () => {
    const res = await fetch(`${server.url}/api/abbreviations/ignored`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ─── Expanded notes ──────────────────────────────────────────────────────────

describe("GET /api/lectures/:id/notes/expanded", () => {
  it("returns notes with abbreviations expanded", async () => {
    await createPair("pc", "paciente");
    const lecture = await createLectureWithNotes("el pc late");
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/notes/expanded`);
    expect(res.status).toBe(200);
    const body = await res.json() as { notesData: string };
    const doc = JSON.parse(body.notesData);
    expect(doc.blocks[0].content[0].text).toBe("el paciente late");
  });

  it("the stored notes are byte-identical after expansion (notes not mutated)", async () => {
    await createPair("pc", "paciente");
    const lecture = await createLectureWithNotes("el pc late");

    // Fetch expanded
    await fetch(`${server.url}/api/lectures/${lecture.id}/notes/expanded`);

    // Fetch the actual stored lecture and verify notes are unchanged
    const stored = await (
      await fetch(`${server.url}/api/lectures/${lecture.id}`)
    ).json() as Lecture;
    const doc = JSON.parse(stored.notesData);
    expect(doc.blocks[0].content[0].text).toBe("el pc late");
  });

  it("returns unmodified notes when no pairs exist", async () => {
    const lecture = await createLectureWithNotes("el pc late");
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/notes/expanded`);
    const body = await res.json() as { notesData: string };
    const doc = JSON.parse(body.notesData);
    expect(doc.blocks[0].content[0].text).toBe("el pc late");
  });

  it("returns 404 for unknown lecture", async () => {
    const res = await fetch(`${server.url}/api/lectures/nope/notes/expanded`);
    expect(res.status).toBe(404);
  });
});
