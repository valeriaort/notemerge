import { describe, it, expect, beforeEach, afterEach } from "vitest";
import FormData from "form-data";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture, MergedBlock, MergeRun } from "../../src/shared/types.js";
import { ScriptedClassifier, ScriptedWritingModel } from "../../src/providers/fakes.js";

// Minimal single-page PDF
function buildOneSlidePdf(title: string, bulletText: string): Buffer {
  const pages = [
    {
      texts: [
        { text: title, y: 720, size: 24 },
        { text: `- ${bulletText}`, y: 670, size: 12 },
      ],
    },
  ];
  const n = pages.length;
  const numObjs = 3 + n * 2;
  const objBodies: string[] = [""];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objBodies.push(`<</Type /Catalog /Pages 2 0 R>>`);
  objBodies.push(`<</Type /Pages /Kids [${kids}] /Count ${n}>>`);
  objBodies.push(`<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>`);
  for (let i = 0; i < n; i++) {
    const contentObjNum = 5 + i * 2;
    let stream = "";
    for (const { text, y, size } of pages[i]!.texts) {
      const esc = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
      stream += `BT /F1 ${size} Tf 50 ${y} Td (${esc}) Tj ET\n`;
    }
    objBodies.push(
      `<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNum} 0 R /Resources <</Font <</F1 3 0 R>>>>>>`,
    );
    objBodies.push(`<</Length ${stream.length}>>\nstream\n${stream}endstream`);
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

const SLIDE_PDF = buildOneSlidePdf("Slide Title", "Important fact about anatomy");

function oneBlockNotes(blockId: string, text: string, t: number): object {
  return {
    blocks: [
      { id: blockId, type: "paragraph", content: [{ type: "text", text }], children: [] },
    ],
    meta: { [blockId]: { firstEditTime: t, lastEditTime: t + 60000 } },
  };
}

function twoBlockNotes(
  b1: string, text1: string,
  b2: string, text2: string,
  t: number,
): object {
  return {
    blocks: [
      { id: b1, type: "paragraph", content: [{ type: "text", text: text1 }], children: [] },
      { id: b2, type: "paragraph", content: [{ type: "text", text: text2 }], children: [] },
    ],
    meta: {
      [b1]: { firstEditTime: t, lastEditTime: t + 60000 },
      [b2]: { firstEditTime: t + 30000, lastEditTime: t + 90000 },
    },
  };
}

async function createLecture(url: string): Promise<Lecture> {
  const res = await fetch(`${url}/api/lectures`, { method: "POST" });
  return res.json() as Promise<Lecture>;
}

async function putNotes(url: string, lectureId: string, notesData: object): Promise<void> {
  await fetch(`${url}/api/lectures/${lectureId}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesData: JSON.stringify(notesData) }),
  });
}

async function sealWithPdf(url: string, lectureId: string): Promise<void> {
  const form = new FormData();
  form.append("subjectName", "Anatomy 101");
  form.append("presentation", SLIDE_PDF, { filename: "slides.pdf", contentType: "application/pdf" });
  const headers = form.getHeaders() as Record<string, string>;
  await fetch(`${url}/api/lectures/${lectureId}/sources`, {
    method: "POST",
    headers,
    body: form.getBuffer(),
  });
}

async function postMerge(
  url: string,
  lectureId: string,
): Promise<{ mergeRun: MergeRun; mergedNote: MergedBlock[] }> {
  const res = await fetch(`${url}/api/lectures/${lectureId}/merge`, { method: "POST" });
  return res.json() as Promise<{ mergeRun: MergeRun; mergedNote: MergedBlock[] }>;
}

async function patchBlock(
  url: string,
  lectureId: string,
  blockId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; block?: MergedBlock }> {
  const res = await fetch(`${url}/api/lectures/${lectureId}/merged-note/${blockId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json() as { block?: MergedBlock };
  return { status: res.status, ...json };
}

async function getFinalNote(
  url: string,
  lectureId: string,
): Promise<{ status: number; blocks?: Array<{ id: string; text: string }>; error?: string }> {
  const res = await fetch(`${url}/api/lectures/${lectureId}/final-note`);
  const body = await res.json() as { blocks?: Array<{ id: string; text: string }>; error?: string };
  return { status: res.status, ...body };
}

async function postExportPdf(
  url: string,
  lectureId: string,
): Promise<{ status: number; lecture?: Lecture; error?: string }> {
  const res = await fetch(`${url}/api/lectures/${lectureId}/export/pdf`, { method: "POST" });
  const body = await res.json() as { lecture?: Lecture; error?: string };
  return { status: res.status, ...body };
}

let server: TestServer;
let classifier: ScriptedClassifier;
let writingModel: ScriptedWritingModel;

beforeEach(async () => {
  classifier = new ScriptedClassifier();
  writingModel = new ScriptedWritingModel();
  server = await startTestServer({ classifier, writingModel });
});

afterEach(() => {
  server.close();
});

describe("GET /api/lectures/:id/final-note — gating", () => {
  it("returns 409 while a conflict block is unresolved", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "student text", t));
    await sealWithPdf(server.url, lecture.id);

    classifier.addConflictAnswers({ "conflict:B01": { label: "conflicts", probability: 0.97 } });
    writingModel.setOperations([
      { type: "rewrite", blockId: "B01", text: "rewritten", sourceIds: ["S001-B01"] },
    ]);

    await postMerge(server.url, lecture.id);

    const { status, error } = await getFinalNote(server.url, lecture.id);
    expect(status).toBe(409);
    expect(error).toBeTruthy();
  });

  it("returns 200 after all conflicts are resolved (K)", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "student text", t));
    await sealWithPdf(server.url, lecture.id);

    classifier.addConflictAnswers({ "conflict:B01": { label: "conflicts", probability: 0.97 } });
    writingModel.setOperations([
      { type: "rewrite", blockId: "B01", text: "rewritten", sourceIds: ["S001-B01"] },
    ]);

    const { mergedNote } = await postMerge(server.url, lecture.id);
    const conflict = mergedNote.find((b) => b.origin === "conflict");
    expect(conflict).toBeDefined();

    await patchBlock(server.url, lecture.id, conflict!.id, { reviewState: "kept" });

    const { status } = await getFinalNote(server.url, lecture.id);
    expect(status).toBe(200);
  });

  it("returns 404 when lecture has no merge", async () => {
    const lecture = await createLecture(server.url);
    const { status } = await getFinalNote(server.url, lecture.id);
    expect(status).toBe(404);
  });

  it("returns 404 for unknown lecture", async () => {
    const { status } = await getFinalNote(server.url, "no-such-lecture");
    expect(status).toBe(404);
  });
});

describe("GET /api/lectures/:id/final-note — content", () => {
  it("includes student blocks", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "student text here", t));
    await sealWithPdf(server.url, lecture.id);
    writingModel.setOperations([]);

    await postMerge(server.url, lecture.id);

    const { blocks } = await getFinalNote(server.url, lecture.id);
    expect(blocks).toBeDefined();
    const texts = blocks!.map((b) => b.text);
    expect(texts).toContain("student text here");
  });

  it("includes additions with null reviewState (implicit keep)", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "some notes", t));
    await sealWithPdf(server.url, lecture.id);

    classifier.addCoverageAnswers({ "coverage:S001-B01": { label: "missing", probability: 0.98 } });
    writingModel.setOperations([]);

    const { mergedNote } = await postMerge(server.url, lecture.id);
    const addition = mergedNote.find((b) => b.origin === "addition" || b.origin === "fallback");
    expect(addition).toBeDefined();
    expect(addition!.reviewState).toBeNull();

    const { blocks } = await getFinalNote(server.url, lecture.id);
    const ids = blocks!.map((b) => b.id);
    expect(ids).toContain(addition!.id);
  });

  it("includes kept additions (reviewState=kept)", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "some notes", t));
    await sealWithPdf(server.url, lecture.id);

    classifier.addCoverageAnswers({ "coverage:S001-B01": { label: "missing", probability: 0.98 } });
    writingModel.setOperations([]);

    const { mergedNote } = await postMerge(server.url, lecture.id);
    const addition = mergedNote.find((b) => b.origin === "addition" || b.origin === "fallback");
    expect(addition).toBeDefined();

    await patchBlock(server.url, lecture.id, addition!.id, { reviewState: "kept" });

    const { blocks } = await getFinalNote(server.url, lecture.id);
    const ids = blocks!.map((b) => b.id);
    expect(ids).toContain(addition!.id);
  });

  it("excludes reverted additions", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "some notes", t));
    await sealWithPdf(server.url, lecture.id);

    classifier.addCoverageAnswers({ "coverage:S001-B01": { label: "missing", probability: 0.98 } });
    writingModel.setOperations([]);

    const { mergedNote } = await postMerge(server.url, lecture.id);
    const addition = mergedNote.find((b) => b.origin === "addition" || b.origin === "fallback");
    expect(addition).toBeDefined();

    await patchBlock(server.url, lecture.id, addition!.id, { reviewState: "reverted" });

    const { blocks } = await getFinalNote(server.url, lecture.id);
    const ids = blocks!.map((b) => b.id);
    expect(ids).not.toContain(addition!.id);
  });

  it("includes conflict block text after K resolution", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "student wrote this", t));
    await sealWithPdf(server.url, lecture.id);

    classifier.addConflictAnswers({ "conflict:B01": { label: "conflicts", probability: 0.97 } });
    writingModel.setOperations([
      { type: "rewrite", blockId: "B01", text: "rewritten text", sourceIds: ["S001-B01"] },
    ]);

    const { mergedNote } = await postMerge(server.url, lecture.id);
    const conflict = mergedNote.find((b) => b.origin === "conflict");
    expect(conflict).toBeDefined();

    await patchBlock(server.url, lecture.id, conflict!.id, { reviewState: "kept" });

    const { blocks } = await getFinalNote(server.url, lecture.id);
    const found = blocks!.find((b) => b.id === conflict!.id);
    expect(found).toBeDefined();
    expect(found!.text).toBe("student wrote this");
  });

  it("includes conflict block with rewritten text after E resolution", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "student wrote this", t));
    await sealWithPdf(server.url, lecture.id);

    classifier.addConflictAnswers({ "conflict:B01": { label: "conflicts", probability: 0.97 } });
    writingModel.setOperations([
      { type: "rewrite", blockId: "B01", text: "rewritten text", sourceIds: ["S001-B01"] },
    ]);

    const { mergedNote } = await postMerge(server.url, lecture.id);
    const conflict = mergedNote.find((b) => b.origin === "conflict");
    expect(conflict).toBeDefined();

    await patchBlock(server.url, lecture.id, conflict!.id, { reviewState: "edited" });

    const { blocks } = await getFinalNote(server.url, lecture.id);
    const found = blocks!.find((b) => b.id === conflict!.id);
    expect(found).toBeDefined();
    expect(found!.text).toBe("rewritten text");
  });

  it("final note blocks have no citations or review metadata", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "some notes", t));
    await sealWithPdf(server.url, lecture.id);

    classifier.addCoverageAnswers({ "coverage:S001-B01": { label: "missing", probability: 0.98 } });
    writingModel.setOperations([]);

    const { mergedNote } = await postMerge(server.url, lecture.id);
    const addition = mergedNote.find((b) => b.origin === "addition" || b.origin === "fallback");
    expect(addition).toBeDefined();
    await patchBlock(server.url, lecture.id, addition!.id, { reviewState: "kept" });

    const { blocks } = await getFinalNote(server.url, lecture.id);
    for (const b of blocks!) {
      expect(Object.keys(b)).toEqual(["id", "text"]);
    }
  });

  it("excludes slide marker student blocks", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    // B01 is a regular block; B02 will be the slide marker block
    const notes = twoBlockNotes("B01", "real note content", "B02", "", t);
    await putNotes(server.url, lecture.id, notes);

    // Register B02 as a slide marker
    await fetch(`${server.url}/api/lectures/${lecture.id}/markers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timestamp: t + 30000, blockId: "B02" }),
    });

    await sealWithPdf(server.url, lecture.id);
    writingModel.setOperations([]);
    const { mergedNote } = await postMerge(server.url, lecture.id);

    // Find the student blocks
    const studentBlocks = mergedNote.filter((b) => b.origin === "student");
    // B02 should be in the merged note (it's a student block)
    const b02Block = studentBlocks.find((b) => b.noteId === "B02");
    expect(b02Block).toBeDefined();

    // But the final note should exclude it
    const { blocks } = await getFinalNote(server.url, lecture.id);
    const ids = blocks!.map((b) => b.id);
    expect(ids).not.toContain(b02Block!.id);

    // B01 should be included
    const b01Block = studentBlocks.find((b) => b.noteId === "B01");
    expect(b01Block).toBeDefined();
    expect(ids).toContain(b01Block!.id);
  });
});

describe("POST /api/lectures/:id/export/pdf — stage and gating", () => {
  it("sets lecture stage to exported on success", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "some notes", t));
    await sealWithPdf(server.url, lecture.id);
    writingModel.setOperations([]);
    await postMerge(server.url, lecture.id);

    const { status, lecture: updated } = await postExportPdf(server.url, lecture.id);
    expect(status).toBe(200);
    expect(updated!.stage).toBe("exported");
  });

  it("returns 409 when unresolved conflict exists", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "student text", t));
    await sealWithPdf(server.url, lecture.id);

    classifier.addConflictAnswers({ "conflict:B01": { label: "conflicts", probability: 0.97 } });
    writingModel.setOperations([
      { type: "rewrite", blockId: "B01", text: "rewritten", sourceIds: ["S001-B01"] },
    ]);

    await postMerge(server.url, lecture.id);

    const { status, error } = await postExportPdf(server.url, lecture.id);
    expect(status).toBe(409);
    expect(error).toBeTruthy();
  });

  it("returns 409 if lecture is not in review stage", async () => {
    const lecture = await createLecture(server.url);
    const { status } = await postExportPdf(server.url, lecture.id);
    expect(status).toBe(409);
  });

  it("returns 404 for unknown lecture", async () => {
    const { status } = await postExportPdf(server.url, "no-such-lecture");
    expect(status).toBe(404);
  });

  it("allows re-export after already exported", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "some notes", t));
    await sealWithPdf(server.url, lecture.id);
    writingModel.setOperations([]);
    await postMerge(server.url, lecture.id);

    await postExportPdf(server.url, lecture.id);
    const { status } = await postExportPdf(server.url, lecture.id);
    expect(status).toBe(200);
  });
});
