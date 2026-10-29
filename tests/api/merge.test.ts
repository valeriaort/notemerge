import { describe, it, expect, beforeEach, afterEach } from "vitest";
import FormData from "form-data";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture, MergedBlock, MergeRun } from "../../src/shared/types.js";
import { ScriptedClassifier, ScriptedWritingModel } from "../../src/providers/fakes.js";

// Builds a minimal valid PDF with one title and one bullet per slide
function buildSlidePdf(slides: Array<{ title: string; bullet: string }>): Buffer {
  const pages = slides.map((s) => ({
    texts: [
      { text: s.title, y: 720, size: 24 },
      { text: `- ${s.bullet}`, y: 670, size: 12 },
    ],
  }));

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

const SLIDE_PDF = buildSlidePdf([{ title: "Slide Title", bullet: "Important fact about anatomy" }]);
const TWO_SLIDE_PDF = buildSlidePdf([
  { title: "Slide One", bullet: "First slide fact" },
  { title: "Slide Two", bullet: "Second slide fact" },
]);

type MergeResponse = { mergeRun: MergeRun; mergedNote: MergedBlock[] };
type MergedNoteResponse = { blocks: MergedBlock[] };
type MergeStatusResponse = { mergeRun: MergeRun };

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

async function sealWithPdf(url: string, lectureId: string, pdf: Buffer): Promise<void> {
  const form = new FormData();
  form.append("subjectName", "Anatomy 101");
  form.append("presentation", pdf, { filename: "slides.pdf", contentType: "application/pdf" });
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
): Promise<{ status: number; body: MergeResponse | { error: string } }> {
  const res = await fetch(`${url}/api/lectures/${lectureId}/merge`, { method: "POST" });
  return { status: res.status, body: await res.json() as MergeResponse | { error: string } };
}

async function getMerge(
  url: string,
  lectureId: string,
): Promise<{ status: number; body: MergeStatusResponse | { error: string } }> {
  const res = await fetch(`${url}/api/lectures/${lectureId}/merge`);
  return { status: res.status, body: await res.json() as MergeStatusResponse | { error: string } };
}

async function getMergedNote(
  url: string,
  lectureId: string,
): Promise<{ status: number; body: MergedNoteResponse | { error: string } }> {
  const res = await fetch(`${url}/api/lectures/${lectureId}/merged-note`);
  return { status: res.status, body: await res.json() as MergedNoteResponse | { error: string } };
}

// Build a notes document with one block spanning a real duration so computeWindows
// produces a non-zero-duration window.
function oneBlockNotes(blockId: string, text: string, firstEditTime: number): object {
  return {
    blocks: [
      {
        id: blockId,
        type: "paragraph",
        content: [{ type: "text", text }],
        children: [],
      },
    ],
    meta: {
      // lastEditTime is 5 minutes after firstEditTime so the lecture has a non-zero duration
      [blockId]: { firstEditTime, lastEditTime: firstEditTime + 5 * 60 * 1000 },
    },
  };
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

describe("POST /api/lectures/:id/merge", () => {
  it("returns 201 and mergeRun.state=done on a sealed lecture", async () => {
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "My note", Date.now()));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    const { status, body } = await postMerge(server.url, lecture.id);
    expect(status).toBe(201);
    const resp = body as MergeResponse;
    expect(resp.mergeRun.state).toBe("done");
    expect(resp.mergeRun.lectureId).toBe(lecture.id);
  });

  it("returns 400 on a lecture that is still in writing stage", async () => {
    const lecture = await createLecture(server.url);
    const { status, body } = await postMerge(server.url, lecture.id);
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBeTruthy();
  });

  it("returns 409 on a second merge request for the same lecture", async () => {
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "My note", Date.now()));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    await postMerge(server.url, lecture.id);
    const { status, body } = await postMerge(server.url, lecture.id);
    expect(status).toBe(409);
    expect((body as { error: string }).error).toContain("already");
  });

  it("returns 404 for a non-existent lecture", async () => {
    const { status } = await postMerge(server.url, "nonexistent-id");
    expect(status).toBe(404);
  });
});

describe("GET /api/lectures/:id/merge", () => {
  it("returns 200 with mergeRun after a successful merge", async () => {
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "My note", Date.now()));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);
    await postMerge(server.url, lecture.id);

    const { status, body } = await getMerge(server.url, lecture.id);
    expect(status).toBe(200);
    expect((body as MergeStatusResponse).mergeRun.state).toBe("done");
  });

  it("returns 404 when no merge has been run", async () => {
    const lecture = await createLecture(server.url);
    const { status } = await getMerge(server.url, lecture.id);
    expect(status).toBe(404);
  });
});

describe("GET /api/lectures/:id/merged-note", () => {
  it("returns all student blocks in order", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    const notes = {
      blocks: [
        { id: "B01", type: "paragraph", content: [{ type: "text", text: "First block" }], children: [] },
        { id: "B02", type: "paragraph", content: [{ type: "text", text: "Second block" }], children: [] },
      ],
      meta: {
        B01: { firstEditTime: t, lastEditTime: t + 5 * 60 * 1000 },
        B02: { firstEditTime: t + 1000, lastEditTime: t + 6 * 60 * 1000 },
      },
    };
    await putNotes(server.url, lecture.id, notes);
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);
    await postMerge(server.url, lecture.id);

    const { status, body } = await getMergedNote(server.url, lecture.id);
    expect(status).toBe(200);
    const blocks = (body as MergedNoteResponse).blocks;
    const studentBlocks = blocks.filter((b) => b.origin === "student");
    expect(studentBlocks).toHaveLength(2);
    expect(studentBlocks[0]!.noteId).toBe("B01");
    expect(studentBlocks[1]!.noteId).toBe("B02");
    // Positions should be in order
    expect(studentBlocks[0]!.position).toBeLessThan(studentBlocks[1]!.position);
  });

  it("returns 404 when no merge has been run", async () => {
    const lecture = await createLecture(server.url);
    const { status } = await getMergedNote(server.url, lecture.id);
    expect(status).toBe(404);
  });
});

describe("Merge verdict → merged note", () => {
  it("missing verdict produces a fallback addition block with citations", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    // Script Jev: bullet S001-B01 is missing
    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
    });
    // Writing model returns nothing — fallback path
    writingModel.setOperations([]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;
    const additions = blocks.filter((b) => b.origin === "addition" || b.origin === "fallback");
    expect(additions).toHaveLength(1);
    const addition = additions[0]!;
    expect(addition.citations).toHaveLength(1);
    expect(addition.citations[0]!.sourceId).toBe("S001-B01");
    expect(addition.citations[0]!.kind).toBe("slide");
  });

  it("covered verdict produces no addition block", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Important fact about anatomy", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    // Script Jev: covered
    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "covered", probability: 0.97 },
    });
    writingModel.setOperations([]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;
    const additions = blocks.filter((b) => b.origin !== "student");
    expect(additions).toHaveLength(0);
  });

  it("noise verdict at or above threshold produces no addition", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "my notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    // Noise at 0.95 threshold — should stay noise (no addition)
    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "noise", probability: 0.95 },
    });
    writingModel.setOperations([]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;
    const additions = blocks.filter((b) => b.origin !== "student");
    expect(additions).toHaveLength(0);
  });

  it("noise verdict below threshold becomes missing (produces addition)", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "my notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    // Noise at 0.90 < 0.95 threshold → becomes missing
    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "noise", probability: 0.90 },
    });
    writingModel.setOperations([]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;
    const additions = blocks.filter((b) => b.origin !== "student");
    expect(additions).toHaveLength(1);
  });

  it("add_after operation places addition after the specified student block", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    const notes = {
      blocks: [
        { id: "B01", type: "paragraph", content: [{ type: "text", text: "First" }], children: [] },
        { id: "B02", type: "paragraph", content: [{ type: "text", text: "Second" }], children: [] },
      ],
      meta: {
        B01: { firstEditTime: t, lastEditTime: t + 5 * 60 * 1000 },
        B02: { firstEditTime: t + 1000, lastEditTime: t + 6 * 60 * 1000 },
      },
    };
    await putNotes(server.url, lecture.id, notes);
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    // Missing verdict
    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
    });
    // Haiku returns add_after B01
    writingModel.setOperations([
      { type: "add_after", blockId: "B01", text: "La hematología estudia la sangre.", sourceIds: ["S001-B01"] },
    ]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;

    // Find B01, addition, B02 in order
    const b01Idx = blocks.findIndex((b) => b.noteId === "B01");
    const additionIdx = blocks.findIndex((b) => b.origin === "addition");
    const b02Idx = blocks.findIndex((b) => b.noteId === "B02");

    expect(b01Idx).not.toBe(-1);
    expect(additionIdx).not.toBe(-1);
    expect(b02Idx).not.toBe(-1);
    // addition is immediately after B01, before B02
    expect(additionIdx).toBe(b01Idx + 1);
    expect(b02Idx).toBe(additionIdx + 1);

    const addition = blocks[additionIdx]!;
    expect(addition.text).toBe("La hematología estudia la sangre.");
    expect(addition.citations[0]!.sourceId).toBe("S001-B01");
    expect(addition.modelPlaced).toBe(true);
    expect(addition.reviewState).toBeNull();
  });

  it("sealed notes are unchanged after merge", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    const notesPayload = oneBlockNotes("B01", "Original note text", t);
    await putNotes(server.url, lecture.id, notesPayload);
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
    });
    writingModel.setOperations([]);

    await postMerge(server.url, lecture.id);

    // Fetch the lecture and check notes are unchanged
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}`);
    const updatedLecture = await res.json() as Lecture;
    const notes = JSON.parse(updatedLecture.notesData) as { blocks: unknown[] };
    // notes should still have the original single block
    expect(notes.blocks).toHaveLength(1);
  });

  it("coverage question key is coverage:<sourceId> and Jev receives notes context", async () => {
    const t = Date.now();
    // Script a missing answer for the expected key
    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.99 },
    });
    writingModel.setOperations([]);

    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Note text", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    const { status, body } = await postMerge(server.url, lecture.id);
    // If key was wrong, Jev would return default "covered" and no addition would appear.
    // The missing verdict for "coverage:S001-B01" only fires when the key matches.
    expect(status).toBe(201);
    const resp = body as MergeResponse;
    // mergeRun done means Jev was called successfully with the right key
    expect(resp.mergeRun.state).toBe("done");
    // An addition block exists because coverage:S001-B01 was answered with "missing"
    const additions = resp.mergedNote.filter((b) => b.origin !== "student");
    expect(additions).toHaveLength(1);
    expect(additions[0]!.citations[0]!.sourceId).toBe("S001-B01");
  });

  it("partially_covered verdict produces a partial_fix block right after the completed block", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    const notes = {
      blocks: [
        { id: "B01", type: "paragraph", content: [{ type: "text", text: "El corazón bombea sangre" }], children: [] },
        { id: "B02", type: "paragraph", content: [{ type: "text", text: "Other note" }], children: [] },
      ],
      meta: {
        B01: { firstEditTime: t, lastEditTime: t + 5 * 60 * 1000 },
        B02: { firstEditTime: t + 1000, lastEditTime: t + 6 * 60 * 1000 },
      },
    };
    await putNotes(server.url, lecture.id, notes);
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    // Jev says the bullet is partially covered
    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "partially_covered", probability: 0.91 },
    });
    // Haiku returns add_after B01 for the specific missing fact
    writingModel.setOperations([
      { type: "add_after", blockId: "B01", text: "Gasto cardíaco: 5 L/min en reposo.", sourceIds: ["S001-B01"] },
    ]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;

    const b01Idx = blocks.findIndex((b) => b.noteId === "B01");
    const partialFixIdx = blocks.findIndex((b) => b.origin === "partial_fix");
    const b02Idx = blocks.findIndex((b) => b.noteId === "B02");

    expect(b01Idx).not.toBe(-1);
    expect(partialFixIdx).not.toBe(-1);
    expect(b02Idx).not.toBe(-1);

    // partial_fix is immediately after B01
    expect(partialFixIdx).toBe(b01Idx + 1);
    expect(b02Idx).toBe(partialFixIdx + 1);

    const pf = blocks[partialFixIdx]!;
    expect(pf.text).toBe("Gasto cardíaco: 5 L/min en reposo.");
    expect(pf.citations[0]!.sourceId).toBe("S001-B01");
    expect(pf.modelPlaced).toBe(true);
    expect(pf.reviewState).toBeNull();
  });

  it("partially_covered entry carries retrieved note block IDs", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    const notes = {
      blocks: [
        { id: "B01", type: "paragraph", content: [{ type: "text", text: "El corazón bombea sangre" }], children: [] },
      ],
      meta: {
        B01: { firstEditTime: t, lastEditTime: t + 5 * 60 * 1000 },
      },
    };
    await putNotes(server.url, lecture.id, notes);
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "partially_covered", probability: 0.88 },
    });
    // Writing model captures its input to verify retrievedNoteIds were passed
    let capturedInput: unknown = null;
    writingModel.setOperations([]);
    const originalGenerate = writingModel.generateOperations.bind(writingModel);
    writingModel.generateOperations = async (input: unknown) => {
      capturedInput = input;
      return originalGenerate(input);
    };

    await postMerge(server.url, lecture.id);

    // The captured edit list entry for the partial verdict should carry B01 as a retrieved note ID
    const input = capturedInput as {
      editList: Array<{ type: string; retrievedNoteIds: string[] }>;
    };
    const partialEntry = input.editList.find((e) => e.type === "partial");
    expect(partialEntry).toBeDefined();
    expect(partialEntry!.retrievedNoteIds).toContain("B01");
  });

  it("partially_covered verdict with no Haiku answer produces a fallback block", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "El corazón", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "partially_covered", probability: 0.85 },
    });
    writingModel.setOperations([]); // Haiku produces nothing

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;
    // Fallback block should appear (not partial_fix since Haiku gave nothing)
    const nonStudent = blocks.filter((b) => b.origin !== "student");
    expect(nonStudent).toHaveLength(1);
    expect(nonStudent[0]!.origin).toBe("fallback");
    expect(nonStudent[0]!.citations[0]!.sourceId).toBe("S001-B01");
  });
});

describe("Conflict check → yellow flags", () => {
  it("scripted conflict verdict produces a yellow block with citations and proposed rewrite", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "El corazón tiene 3 ventrículos", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    // Conflict verdict for B01 (conflict key = conflict:B01)
    classifier.addConflictAnswers({
      "conflict:B01": { label: "conflicts", probability: 0.97 },
    });

    // Haiku returns a rewrite targeting B01 with source S001-B01
    writingModel.setOperations([
      {
        type: "rewrite",
        blockId: "B01",
        text: "El corazón tiene 4 ventrículos.",
        sourceIds: ["S001-B01"],
      },
    ]);

    const { status, body } = await postMerge(server.url, lecture.id);
    expect(status).toBe(201);
    const resp = body as MergeResponse;

    const conflictBlocks = resp.mergedNote.filter((b) => b.origin === "conflict");
    expect(conflictBlocks).toHaveLength(1);

    const flag = conflictBlocks[0]!;
    // Original text is preserved
    expect(flag.text).toBe("El corazón tiene 3 ventrículos");
    // Rewrite is stored alongside
    expect(flag.proposedRewrite).toBe("El corazón tiene 4 ventrículos.");
    // Unresolved by default
    expect(flag.reviewState).toBe("unresolved");
    // Citations name the conflicting source
    expect(flag.citations).toHaveLength(1);
    expect(flag.citations[0]!.sourceId).toBe("S001-B01");
    expect(flag.citations[0]!.kind).toBe("slide");
    expect(flag.citations[0]!.text).toBe("Important fact about anatomy");
    // Placed by the model
    expect(flag.modelPlaced).toBe(true);
  });

  it("conflict question key is conflict:<blockId>", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "some note text", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    // Only fires when the key is exactly "conflict:B01"
    classifier.addConflictAnswers({
      "conflict:B01": { label: "conflicts", probability: 0.95 },
    });
    writingModel.setOperations([
      {
        type: "rewrite",
        blockId: "B01",
        text: "Rewritten text.",
        sourceIds: ["S001-B01"],
      },
    ]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;
    const conflictBlocks = blocks.filter((b) => b.origin === "conflict");
    expect(conflictBlocks).toHaveLength(1);
  });

  it("supported verdict produces no conflict flag", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "El corazón tiene 4 ventrículos", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    // Default: supported — no conflict
    classifier.addConflictAnswers({
      "conflict:B01": { label: "supported", probability: 0.99 },
    });
    writingModel.setOperations([]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;
    const conflictBlocks = blocks.filter((b) => b.origin === "conflict");
    expect(conflictBlocks).toHaveLength(0);
  });

  it("unsupported verdict produces no conflict flag (only conflicts are flagged)", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "some unrelated note", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    classifier.addConflictAnswers({
      "conflict:B01": { label: "unsupported", probability: 0.98 },
    });
    writingModel.setOperations([]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;
    const conflictBlocks = blocks.filter((b) => b.origin === "conflict");
    expect(conflictBlocks).toHaveLength(0);
  });

  it("conflict fallback: no rewrite op produces a conflict block with modelPlaced=false", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "original text", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    classifier.addConflictAnswers({
      "conflict:B01": { label: "conflicts", probability: 0.96 },
    });
    // Haiku returns nothing — fallback path
    writingModel.setOperations([]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;
    const conflictBlocks = blocks.filter((b) => b.origin === "conflict");
    expect(conflictBlocks).toHaveLength(1);
    const flag = conflictBlocks[0]!;
    expect(flag.modelPlaced).toBe(false);
    expect(flag.text).toBe("original text");
    expect(flag.reviewState).toBe("unresolved");
    expect(flag.citations.length).toBeGreaterThan(0);
  });

  it("each block is checked at most once (in its own window only)", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    // Two blocks both in the same window
    const notes = {
      blocks: [
        { id: "B01", type: "paragraph", content: [{ type: "text", text: "Note one" }], children: [] },
        { id: "B02", type: "paragraph", content: [{ type: "text", text: "Note two" }], children: [] },
      ],
      meta: {
        B01: { firstEditTime: t, lastEditTime: t + 5 * 60 * 1000 },
        B02: { firstEditTime: t + 1000, lastEditTime: t + 6 * 60 * 1000 },
      },
    };
    await putNotes(server.url, lecture.id, notes);
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    // Both blocks conflict — should each be flagged exactly once
    classifier.addConflictAnswers({
      "conflict:B01": { label: "conflicts", probability: 0.96 },
      "conflict:B02": { label: "conflicts", probability: 0.94 },
    });
    writingModel.setOperations([
      { type: "rewrite", blockId: "B01", text: "Rewrite one.", sourceIds: ["S001-B01"] },
      { type: "rewrite", blockId: "B02", text: "Rewrite two.", sourceIds: ["S001-B01"] },
    ]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;
    // Each block flagged exactly once
    expect(blocks.filter((b) => b.noteId === "B01" && b.origin === "conflict")).toHaveLength(1);
    expect(blocks.filter((b) => b.noteId === "B02" && b.origin === "conflict")).toHaveLength(1);
  });
});

describe("Haiku output validation", () => {
  it("unknown blockId in add_after is dropped; fallback block appears with verbatim source text", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
    });
    // Haiku references a block that does not exist
    writingModel.setOperations([
      { type: "add_after", blockId: "NONEXISTENT-BLOCK", text: "El corazón.", sourceIds: ["S001-B01"] },
    ]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;
    // No model-placed addition
    expect(blocks.filter((b) => b.origin === "addition" && b.modelPlaced)).toHaveLength(0);
    // Fallback block with verbatim source text and citation
    const fallbacks = blocks.filter((b) => b.origin === "fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.modelPlaced).toBe(false);
    expect(fallbacks[0]!.citations[0]!.sourceId).toBe("S001-B01");
  });

  it("unknown windowId in add_at_window is dropped; fallback block appears", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
    });
    // Haiku references a window that does not exist
    writingModel.setOperations([
      { type: "add_at_window", windowId: "W999", text: "El corazón.", sourceIds: ["S001-B01"] },
    ]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;
    expect(blocks.filter((b) => b.origin === "addition" && b.modelPlaced)).toHaveLength(0);
    const fallbacks = blocks.filter((b) => b.origin === "fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.modelPlaced).toBe(false);
  });

  it("source ID outside the edit list is dropped; unanswered entry produces fallback block", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
    });
    // Haiku returns a source ID that is not in the edit list
    writingModel.setOperations([
      { type: "add_after", blockId: "B01", text: "El corazón.", sourceIds: ["S999-B99"] },
    ]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;
    expect(blocks.filter((b) => b.origin === "addition" && b.modelPlaced)).toHaveLength(0);
    const fallbacks = blocks.filter((b) => b.origin === "fallback");
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.citations[0]!.sourceId).toBe("S001-B01");
  });

  it("entry answered multiple times: only first operation accepted, second dropped", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
    });
    // Two operations for the same entry (same sourceId → same edit list entry)
    writingModel.setOperations([
      { type: "add_after", blockId: "B01", text: "First answer.", sourceIds: ["S001-B01"] },
      { type: "add_at_window", windowId: "W001", text: "Second answer.", sourceIds: ["S001-B01"] },
    ]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;
    // Exactly one non-student block (first op accepted, second dropped)
    const nonStudent = blocks.filter((b) => b.origin !== "student");
    expect(nonStudent).toHaveLength(1);
    expect(nonStudent[0]!.origin).toBe("addition");
    expect(nonStudent[0]!.text).toBe("First answer.");
    expect(nonStudent[0]!.modelPlaced).toBe(true);
  });

  it("Haiku is not retried when it returns invalid operations", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
    });
    writingModel.setOperations([
      { type: "add_after", blockId: "NONEXISTENT", text: "text", sourceIds: ["S001-B01"] },
    ]);

    const { status } = await postMerge(server.url, lecture.id);
    expect(status).toBe(201);
    // Haiku called exactly once — no retry on invalid output
    expect(writingModel.callCount).toBe(1);
  });

  it("dropped rewrite op for a conflict entry → conflict flag still appears with modelPlaced=false", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "original text", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    classifier.addConflictAnswers({
      "conflict:B01": { label: "conflicts", probability: 0.96 },
    });
    // Rewrite targets a non-existent block → dropped
    writingModel.setOperations([
      { type: "rewrite", blockId: "NONEXISTENT", text: "rewrite text", sourceIds: ["S001-B01"] },
    ]);

    await postMerge(server.url, lecture.id);

    const { body } = await getMergedNote(server.url, lecture.id);
    const blocks = (body as MergedNoteResponse).blocks;
    const conflictBlocks = blocks.filter((b) => b.origin === "conflict");
    expect(conflictBlocks).toHaveLength(1);
    const flag = conflictBlocks[0]!;
    expect(flag.modelPlaced).toBe(false);
    expect(flag.proposedRewrite).toBeNull();
    expect(flag.reviewState).toBe("unresolved");
    expect(flag.citations.length).toBeGreaterThan(0);
  });
});

describe("Haiku split above 100k tokens", () => {
  let splitServer: TestServer;
  let splitClassifier: ScriptedClassifier;
  let splitWritingModel: ScriptedWritingModel;

  beforeEach(async () => {
    splitClassifier = new ScriptedClassifier();
    splitWritingModel = new ScriptedWritingModel();
    // Threshold of 1 forces a split whenever windows.length > 1
    splitServer = await startTestServer(
      { classifier: splitClassifier, writingModel: splitWritingModel },
      { haikuTokenThreshold: 1 },
    );
  });

  afterEach(() => {
    splitServer.close();
  });

  it("makes two Haiku calls when estimated tokens exceed threshold with multiple windows", async () => {
    const t = Date.now();
    const lecture = await createLecture(splitServer.url);
    // lastEditTime 6 minutes after firstEditTime → 4-minute fixed windows → two windows
    const notes = {
      blocks: [
        { id: "B01", type: "paragraph", content: [{ type: "text", text: "First block" }], children: [] },
      ],
      meta: {
        B01: { firstEditTime: t, lastEditTime: t + 6 * 60 * 1000 },
      },
    };
    await putNotes(splitServer.url, lecture.id, notes);
    await sealWithPdf(splitServer.url, lecture.id, TWO_SLIDE_PDF);

    // Script missing for both slide bullets (one per window)
    splitClassifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
      "coverage:S002-B01": { label: "missing", probability: 0.98 },
    });
    splitWritingModel.setOperations([]);

    const { status } = await postMerge(splitServer.url, lecture.id);
    expect(status).toBe(201);
    // Two separate Haiku calls (one per half)
    expect(splitWritingModel.callCount).toBe(2);
  });
});
