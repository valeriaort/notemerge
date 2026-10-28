import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";
import { readFileSync } from "fs";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture } from "../../src/shared/types.js";
import type { Subject } from "../../src/shared/types.js";
import FormData from "form-data";

const FIXTURES = path.resolve("tests/fixtures");

// Minimal valid PDF bytes (a real minimal PDF that passes multer's file type check)
const MINIMAL_PDF = Buffer.from(
  "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
);

// A 4-page PDF with no extractable text — triggers scanned-PDF rejection
function buildScannedPdf(): Buffer {
  const n = 4;
  const numObjs = 3 + n * 2;
  const objBodies: string[] = [""];
  const kids = Array.from({ length: n }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
  objBodies.push(`<</Type /Catalog /Pages 2 0 R>>`);
  objBodies.push(`<</Type /Pages /Kids [${kids}] /Count ${n}>>`);
  objBodies.push(`<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>`);
  for (let i = 0; i < n; i++) {
    const contentObjNum = 5 + i * 2;
    objBodies.push(
      `<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNum} 0 R /Resources <</Font <</F1 3 0 R>>>>>>`,
    );
    objBodies.push(`<</Length 0>>\nstream\nendstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = new Array(numObjs + 1).fill(0) as number[];
  for (let i = 1; i <= numObjs; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objBodies[i]}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${numObjs + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= numObjs; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<</Size ${numObjs + 1} /Root 1 0 R>>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

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

describe("POST /api/lectures/:id/sources — PDF text extraction", () => {
  it("rejects a scanned PDF (no extractable text) with 400 and a clear message", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");

    const res = await uploadSources(lecture.id, {
      subjectId: subject.id,
      presentation: buildScannedPdf(),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error.toLowerCase()).toMatch(/scanned|ocr|no extractable text/);
  });

  it("scanned PDF upload leaves lecture in writing stage", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");

    await uploadSources(lecture.id, {
      subjectId: subject.id,
      presentation: buildScannedPdf(),
    });

    const refetched = await fetch(`${server.url}/api/lectures/${lecture.id}`);
    const updated = await refetched.json() as Lecture;
    expect(updated.stage).toBe("writing");
  });

  it("successful upload returns slides array in the response", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");

    const textSlidesPdf = readFileSync(
      `${FIXTURES}/text_slides.pdf`,
    );
    const res = await uploadSources(lecture.id, {
      subjectId: subject.id,
      presentation: textSlidesPdf,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { lecture: Lecture; subject: Subject; slides: unknown[] };
    expect(Array.isArray(body.slides)).toBe(true);
    expect(body.slides.length).toBeGreaterThan(0);
  });

  it("returned slides have correct IDs (S001, S002, …)", async () => {
    const lecture = await createLecture();
    const subject = await createSubject("Anatomy");

    const textSlidesPdf = readFileSync(
      `${FIXTURES}/text_slides.pdf`,
    );
    const res = await uploadSources(lecture.id, {
      subjectId: subject.id,
      presentation: textSlidesPdf,
    });
    const body = await res.json() as {
      slides: Array<{ id: string; title: string | null; bullets: unknown[] }>;
    };
    expect(body.slides[0]!.id).toBe("S001");
    expect(body.slides[0]!.title).toBe("Slide Title One");
  });
});
