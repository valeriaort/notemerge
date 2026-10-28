import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Subject } from "../../src/shared/types.js";
import FormData from "form-data";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal valid PDF with no text content
const NO_TEXT_PDF = Buffer.from(
  "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
);

// Real PDF with extractable text
const TEXT_PDF = readFileSync(path.join(__dirname, "../fixtures/minimal-text.pdf"));

let server: TestServer;

async function createSubject(name: string): Promise<Subject> {
  const res = await fetch(`${server.url}/api/subjects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return res.json() as Promise<Subject>;
}

async function uploadGuia(subjectId: string, pdf: Buffer): Promise<Response> {
  const form = new FormData();
  form.append("guia", pdf, { filename: "guia.pdf", contentType: "application/pdf" });
  return fetch(`${server.url}/api/subjects/${subjectId}/guia`, {
    method: "POST",
    headers: form.getHeaders() as Record<string, string>,
    body: form.getBuffer(),
  });
}

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(() => {
  server.close();
});

describe("POST /api/subjects/:id/guia — no extractable text", () => {
  it("rejects a PDF with no extractable text with 400", async () => {
    const subject = await createSubject("Anatomy");
    const res = await uploadGuia(subject.id, NO_TEXT_PDF);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error.toLowerCase()).toMatch(/no extractable text|no.*text|extract/);
  });

  it("previous glossary is unchanged after rejection", async () => {
    const subject = await createSubject("Anatomy");

    // First upload a real PDF to set a glossary
    const res1 = await uploadGuia(subject.id, TEXT_PDF);
    expect(res1.status).toBe(200);
    const updated = await res1.json() as Subject;
    expect(updated.glossaryTerms.length).toBeGreaterThan(0);

    // Now try to replace with a no-text PDF
    const res2 = await uploadGuia(subject.id, NO_TEXT_PDF);
    expect(res2.status).toBe(400);

    // Glossary should still have terms
    const subjectsRes = await fetch(`${server.url}/api/subjects`);
    const subjects = await subjectsRes.json() as Subject[];
    const found = subjects.find((s) => s.id === subject.id);
    expect(found!.glossaryTerms.length).toBeGreaterThan(0);
  });
});

describe("POST /api/subjects/:id/guia — valid PDF", () => {
  it("accepts a PDF with text and returns the updated subject", async () => {
    const subject = await createSubject("Anatomy");
    const res = await uploadGuia(subject.id, TEXT_PDF);
    expect(res.status).toBe(200);
    const updated = await res.json() as Subject;
    expect(updated.id).toBe(subject.id);
    expect(updated.glossaryTerms).toBeDefined();
    expect(Array.isArray(updated.glossaryTerms)).toBe(true);
  });

  it("glossary is non-empty for a PDF with anatomy text", async () => {
    const subject = await createSubject("Odontology");
    const res = await uploadGuia(subject.id, TEXT_PDF);
    expect(res.status).toBe(200);
    const updated = await res.json() as Subject;
    // The PDF contains "ATM periodontitis osteoartrosis esmalte dentina"
    // At least some should be retained
    expect(updated.glossaryTerms.length).toBeGreaterThan(0);
  });

  it("rebuilds glossary from scratch on replace (previous terms gone)", async () => {
    const subject = await createSubject("Anatomy");

    // First upload
    const res1 = await uploadGuia(subject.id, TEXT_PDF);
    const first = await res1.json() as Subject;
    const firstTerms = first.glossaryTerms;

    // Second upload (same PDF — glossary rebuilt from scratch, deduped → same result)
    const res2 = await uploadGuia(subject.id, TEXT_PDF);
    const second = await res2.json() as Subject;

    // Both should have the same terms (rebuilt from scratch produces same output)
    expect(second.glossaryTerms).toEqual(firstTerms);
    expect(res2.status).toBe(200);
  });

  it("returns 404 for non-existent subject", async () => {
    const form = new FormData();
    form.append("guia", TEXT_PDF, { filename: "guia.pdf", contentType: "application/pdf" });
    const res = await fetch(`${server.url}/api/subjects/nonexistent/guia`, {
      method: "POST",
      headers: form.getHeaders() as Record<string, string>,
      body: form.getBuffer(),
    });
    expect(res.status).toBe(404);
  });
});

describe("Subject without a glossary", () => {
  it("subject starts with empty glossaryTerms", async () => {
    const subject = await createSubject("NoGlossary");
    expect(subject.glossaryTerms).toEqual([]);
    expect(subject.guiaDocente).toBeNull();
  });

  it("GET /api/subjects returns subjects with glossaryTerms field", async () => {
    await createSubject("SubjectA");
    await createSubject("SubjectB");
    const res = await fetch(`${server.url}/api/subjects`);
    expect(res.status).toBe(200);
    const subjects = await res.json() as Subject[];
    expect(subjects.length).toBeGreaterThanOrEqual(2);
    for (const s of subjects) {
      expect(Array.isArray(s.glossaryTerms)).toBe(true);
    }
  });

  it("subject without glossary works normally (can still be used in sources)", async () => {
    const subject = await createSubject("NoGlossary");
    // Create a lecture and seal it with this subject
    const lectureRes = await fetch(`${server.url}/api/lectures`, { method: "POST" });
    const lecture = await lectureRes.json() as { id: string };

    const FormDataNode = (await import("form-data")).default;
    const MINIMAL_PDF = Buffer.from(
      "%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 3 3]>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n0000000115 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF",
    );
    const form = new FormDataNode();
    form.append("subjectId", subject.id);
    form.append("presentation", MINIMAL_PDF, { filename: "slides.pdf", contentType: "application/pdf" });
    const sealRes = await fetch(`${server.url}/api/lectures/${lecture.id}/sources`, {
      method: "POST",
      headers: form.getHeaders() as Record<string, string>,
      body: form.getBuffer(),
    });
    expect(sealRes.status).toBe(200);
  });
});
