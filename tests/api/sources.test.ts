import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createReadStream, writeFileSync } from "fs";
import path from "path";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture } from "../../src/shared/types.js";
import type { Subject } from "../../src/shared/types.js";
import FormData from "form-data";

// Minimal valid PDF bytes (a real minimal PDF that passes multer's file type check)
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

async function uploadSources(
  lectureId: string,
  opts: { subjectId?: string; subjectName?: string; presentation?: Buffer },
): Promise<Response> {
  const form = new FormData();
  if (opts.subjectId) form.append("subjectId", opts.subjectId);
  if (opts.subjectName) form.append("subjectName", opts.subjectName);
  if (opts.presentation) {
    form.append("presentation", opts.presentation, {
      filename: "slides.pdf",
      contentType: "application/pdf",
    });
  }
  const headers = form.getHeaders() as Record<string, string>;
  const body = form.getBuffer();
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

describe("POST /api/lectures/:id/sources — notes-only rejection", () => {
  it("rejects notes alone (no presentation) with 400 and a clear message", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");

    const res = await uploadSources(lecture.id, { subjectId: subject.id });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBeTruthy();
    expect(body.error.toLowerCase()).toMatch(/presentation|notes.?alone/);
  });

  it("lecture remains in writing stage after rejection", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");

    await uploadSources(lecture.id, { subjectId: subject.id });

    const refetched = await fetch(`${server.url}/api/lectures/${lecture.id}`);
    const updated = await refetched.json() as Lecture;
    expect(updated.stage).toBe("writing");
  });

  it("notes remain writable after rejection", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");

    await uploadSources(lecture.id, { subjectId: subject.id });

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notesData: '{"blocks":[],"meta":{}}' }),
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/lectures/:id/sources — accepted upload seals", () => {
  it("accepts notes + PDF and seals the lecture", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");

    const res = await uploadSources(lecture.id, {
      subjectId: subject.id,
      presentation: MINIMAL_PDF,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { lecture: Lecture };
    expect(body.lecture.stage).toBe("sealed");
    expect(body.lecture.subjectId).toBe(subject.id);
  });

  it("sealed lecture has a presentationPath set", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");

    const res = await uploadSources(lecture.id, {
      subjectId: subject.id,
      presentation: MINIMAL_PDF,
    });
    const body = await res.json() as { lecture: Lecture };
    expect(body.lecture.presentationPath).toBeTruthy();
  });

  it("accepts a new subject created inline (subjectName instead of subjectId)", async () => {
    const lecture = await createLecture();

    const res = await uploadSources(lecture.id, {
      subjectName: "New Biology Course",
      presentation: MINIMAL_PDF,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { lecture: Lecture; subject: Subject };
    expect(body.lecture.stage).toBe("sealed");
    expect(body.subject.name).toBe("New Biology Course");
  });
});

describe("sealed notes immutability", () => {
  it("refuses to update notes on a sealed lecture with 403", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");

    // Seal the lecture
    await uploadSources(lecture.id, {
      subjectId: subject.id,
      presentation: MINIMAL_PDF,
    });

    // Attempt to edit notes after sealing
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/notes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notesData: '{"blocks":[],"meta":{}}' }),
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/subjects/last-used", () => {
  it("returns null when no lecture has been sealed yet", async () => {
    const res = await fetch(`${server.url}/api/subjects/last-used`);
    expect(res.status).toBe(200);
    const body = await res.json() as { subject: Subject | null };
    expect(body.subject).toBeNull();
  });

  it("returns the subject from the most recently sealed lecture", async () => {
    const subject = await createSubject("Anatomy");
    const lecture = await createLecture();

    await uploadSources(lecture.id, {
      subjectId: subject.id,
      presentation: MINIMAL_PDF,
    });

    const res = await fetch(`${server.url}/api/subjects/last-used`);
    const body = await res.json() as { subject: Subject };
    expect(body.subject.id).toBe(subject.id);
    expect(body.subject.name).toBe("Anatomy");
  });

  it("updates to the latest sealed subject", async () => {
    const subjectA = await createSubject("Anatomy");
    const subjectB = await createSubject("Physiology");

    const lectureA = await createLecture();
    await uploadSources(lectureA.id, {
      subjectId: subjectA.id,
      presentation: MINIMAL_PDF,
    });

    const lectureB = await createLecture();
    await uploadSources(lectureB.id, {
      subjectId: subjectB.id,
      presentation: MINIMAL_PDF,
    });

    const res = await fetch(`${server.url}/api/subjects/last-used`);
    const body = await res.json() as { subject: Subject };
    expect(body.subject.id).toBe(subjectB.id);
  });
});

describe("GET /api/subjects", () => {
  it("returns all subjects", async () => {
    await createSubject("Anatomy");
    await createSubject("Physiology");

    const res = await fetch(`${server.url}/api/subjects`);
    expect(res.status).toBe(200);
    const subjects = await res.json() as Subject[];
    expect(subjects.length).toBe(2);
  });

  it("returns empty array when no subjects", async () => {
    const res = await fetch(`${server.url}/api/subjects`);
    const subjects = await res.json() as Subject[];
    expect(subjects).toEqual([]);
  });
});

describe("POST /api/subjects", () => {
  it("creates a subject with a name", async () => {
    const res = await fetch(`${server.url}/api/subjects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Biochemistry" }),
    });
    expect(res.status).toBe(201);
    const subject = await res.json() as Subject;
    expect(subject.id).toBeTruthy();
    expect(subject.name).toBe("Biochemistry");
  });

  it("returns 400 when name is missing", async () => {
    const res = await fetch(`${server.url}/api/subjects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
