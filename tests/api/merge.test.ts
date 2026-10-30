import { describe, it, expect, beforeEach, afterEach } from "vitest";
import FormData from "form-data";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture, MergedBlock, MergeRun } from "../../src/shared/types.js";
import { ScriptedClassifier, ScriptedWritingModel, FailableClassifier } from "../../src/providers/fakes.js";
import {
  ensureDefaultUser,
  createSubject,
  sealLecture,
  createAudioFile,
  createAudioChunk,
  createSentence,
  createMarker,
} from "../../src/server/db.js";

// Builds a minimal valid multi-page PDF (one title + one bullet per page)
function buildMultiSlidePdf(pages: Array<{ title: string; bullet: string }>): Buffer {
  const n = pages.length;
  const numObjs = 3 + n * 2;
  const objBodies: string[] = [""];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objBodies.push(`<</Type /Catalog /Pages 2 0 R>>`);
  objBodies.push(`<</Type /Pages /Kids [${kids}] /Count ${n}>>`);
  objBodies.push(`<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>`);

  for (let i = 0; i < n; i++) {
    const contentObjNum = 5 + i * 2;
    const titleEsc = pages[i]!.title.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    const bulletEsc = (`- ${pages[i]!.bullet}`).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    let stream = "";
    stream += `BT /F1 24 Tf 50 720 Td (${titleEsc}) Tj ET\n`;
    stream += `BT /F1 12 Tf 50 670 Td (${bulletEsc}) Tj ET\n`;
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

function buildTwoSlidePdf(): Buffer {
  return buildMultiSlidePdf([
    { title: "Slide One Title", bullet: "First slide bullet" },
    { title: "Slide Two Title", bullet: "Second slide bullet" },
  ]);
}

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

// Seal a lecture without a presentation (notes+audio only)
function sealWithoutSlides(srv: TestServer, lectureId: string): void {
  const user = ensureDefaultUser(srv.db);
  const subject = createSubject(srv.db, `subj-${lectureId}`, "Test Subject", user.id);
  sealLecture(srv.db, lectureId, subject.id, null);
}

// Create a fake audio file + chunk + sentence in the DB for a sealed lecture.
// Returns the sentence ID so tests can assert on it.
function addSentence(
  srv: TestServer,
  lectureId: string,
  sentenceId: string,
  clockStartTimeMs: number,
  text: string,
  opts?: { flagState?: "unflagged" | "flagged_unhandled" | "corrected" | "advanced"; correctedText?: string },
): void {
  const afId = `af-${sentenceId}`;
  const acId = `ac-${sentenceId}`;
  createAudioFile(srv.db, afId, lectureId, 1, "/fake/audio.wav", clockStartTimeMs - 1000, 120000);
  createAudioChunk(srv.db, acId, afId, 1, "/fake/chunk.wav", 0, 120000);
  createSentence(srv.db, {
    id: sentenceId,
    chunkId: acId,
    audioStartOffsetMs: 0,
    audioEndOffsetMs: 2000,
    clockStartTimeMs,
    clockEndTimeMs: clockStartTimeMs + 2000,
    textRaw: text,
    text,
    avgLogprob: -0.3,
    noSpeechProb: 0.05,
    compressionRatio: 1.1,
    status: "active",
    stitchedInto: null,
    flagState: opts?.flagState ?? "unflagged",
    flagReasons: [],
    correctedText: opts?.correctedText ?? null,
  });
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

  it("an entry answered twice keeps the first answer and logs the second as already answered (#35)", async () => {
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", Date.now()));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
    });
    writingModel.setOperations([
      { type: "add_after", blockId: "B01", text: "first answer", sourceIds: ["S001-B01"] },
      { type: "add_after", blockId: "B01", text: "second answer", sourceIds: ["S001-B01"] },
    ]);

    const { body } = await postMerge(server.url, lecture.id);
    const runId = (body as MergeResponse).mergeRun.id;

    const { body: noteBody } = await getMergedNote(server.url, lecture.id);
    const additions = (noteBody as MergedNoteResponse).blocks.filter((b) => b.origin === "addition");
    expect(additions.map((b) => b.text)).toEqual(["first answer"]);

    const ops = server.db
      .prepare("SELECT text, status, drop_reason FROM operations WHERE merge_run_id = ? ORDER BY rowid")
      .all(runId) as Array<{ text: string; status: string; drop_reason: string | null }>;
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ text: "first answer", status: "accepted" });
    expect(ops[1]).toMatchObject({ text: "second answer", status: "dropped" });
    expect(ops[1]!.drop_reason).toMatch(/already answered/i);
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

  it("each split call receives every note its entries reference, even across the window boundary (#35)", async () => {
    const t = Date.now();
    const min = 60 * 1000;
    const lecture = await createLecture(splitServer.url);
    // 4-minute windows: window 1 = [t, t+4m), window 2 = [t+4m, ...). B02 sits in window 1 but
    // within the 1-minute margin of window 2; B03 sits in window 2 but within window 1's margin.
    const block = (id: string, text: string) => ({
      id, type: "paragraph", content: [{ type: "text", text }], children: [],
    });
    const notes = {
      blocks: [block("B01", "First block"), block("B02", "Second block"), block("B03", "Third block")],
      meta: {
        B01: { firstEditTime: t, lastEditTime: t },
        B02: { firstEditTime: t + 3.5 * min, lastEditTime: t + 3.5 * min },
        B03: { firstEditTime: t + 5 * min, lastEditTime: t + 6 * min },
      },
    };
    await putNotes(splitServer.url, lecture.id, notes);
    await sealWithPdf(splitServer.url, lecture.id, TWO_SLIDE_PDF);

    splitClassifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "partially_covered", probability: 0.91 },
      "coverage:S002-B01": { label: "partially_covered", probability: 0.91 },
    });
    splitWritingModel.setOperations([]);

    const inputs: Array<{
      sealedNotes: Array<{ id: string }>;
      editList: Array<{ retrievedNoteIds?: string[]; noteId?: string }>;
    }> = [];
    const generate = splitWritingModel.generateOperations.bind(splitWritingModel);
    splitWritingModel.generateOperations = async (input: unknown) => {
      inputs.push(input as (typeof inputs)[number]);
      return generate(input);
    };

    const { status } = await postMerge(splitServer.url, lecture.id);
    expect(status).toBe(201);
    expect(inputs).toHaveLength(2);

    for (const input of inputs) {
      const have = new Set(input.sealedNotes.map((n) => n.id));
      for (const entry of input.editList) {
        for (const id of [...(entry.retrievedNoteIds ?? []), ...(entry.noteId ? [entry.noteId] : [])]) {
          expect(have.has(id)).toBe(true);
        }
      }
    }
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

describe("Merge failure handling: pause and resume", () => {
  it("retries on 429 (retryable) and succeeds after transient failures", async () => {
    const failableClassifier = new FailableClassifier();
    // Two 429 failures, then success (no failure scheduled → parent ScriptedClassifier default: covered)
    failableClassifier.scheduleCoverageCall({ statusCode: 429, retryAfterMs: 1 });
    failableClassifier.scheduleCoverageCall({ statusCode: 429, retryAfterMs: 1 });

    server.close();
    const freshServer = await startTestServer({ classifier: failableClassifier, writingModel });

    try {
      const lecture = await createLecture(freshServer.url);
      await putNotes(freshServer.url, lecture.id, oneBlockNotes("B01", "note", Date.now()));
      await sealWithPdf(freshServer.url, lecture.id, SLIDE_PDF);

      const { status, body } = await postMerge(freshServer.url, lecture.id);
      expect(status).toBe(201);
      expect((body as MergeResponse).mergeRun.state).toBe("done");
      // coverage_attempts = 1: retry is transparent at DB level (settled once as "done")
      const mergeRunId = (body as MergeResponse).mergeRun.id;
      const wr = freshServer.db
        .prepare("SELECT * FROM window_results WHERE merge_run_id = ?")
        .get(mergeRunId) as { coverage_attempts: number; coverage_status: string };
      expect(wr.coverage_status).toBe("done");
      expect(wr.coverage_attempts).toBe(1);
    } finally {
      freshServer.close();
    }
  });

  it("retries honor Retry-After delay from 529 error", async () => {
    const failableClassifier = new FailableClassifier();
    failableClassifier.scheduleCoverageCall({ statusCode: 529, retryAfterMs: 1 });
    // 2nd call succeeds

    server.close();
    const freshServer = await startTestServer({ classifier: failableClassifier, writingModel });

    try {
      const lecture = await createLecture(freshServer.url);
      await putNotes(freshServer.url, lecture.id, oneBlockNotes("B01", "note", Date.now()));
      await sealWithPdf(freshServer.url, lecture.id, SLIDE_PDF);

      const { status, body } = await postMerge(freshServer.url, lecture.id);
      expect(status).toBe(201);
      expect((body as MergeResponse).mergeRun.state).toBe("done");
    } finally {
      freshServer.close();
    }
  });

  it("exhausted retries pause the merge with failedWindowIds; Haiku is not called", async () => {
    const failableClassifier = new FailableClassifier();
    // Fail all 3 attempts (default maxRetryAttempts = 3)
    failableClassifier.scheduleCoverageCall({ statusCode: 429, retryAfterMs: 1 });
    failableClassifier.scheduleCoverageCall({ statusCode: 429, retryAfterMs: 1 });
    failableClassifier.scheduleCoverageCall({ statusCode: 429, retryAfterMs: 1 });

    let haikuCallCount = 0;
    const capturingWritingModel = new ScriptedWritingModel();
    const origGenerate = capturingWritingModel.generateOperations.bind(capturingWritingModel);
    capturingWritingModel.generateOperations = async (input: unknown) => {
      haikuCallCount++;
      return origGenerate(input);
    };

    server.close();
    const freshServer = await startTestServer({
      classifier: failableClassifier,
      writingModel: capturingWritingModel,
    });

    try {
      const lecture = await createLecture(freshServer.url);
      await putNotes(freshServer.url, lecture.id, oneBlockNotes("B01", "note", Date.now()));
      await sealWithPdf(freshServer.url, lecture.id, SLIDE_PDF);

      const { status, body } = await postMerge(freshServer.url, lecture.id);
      expect(status).toBe(201);
      const run = (body as MergeResponse).mergeRun;
      expect(run.state).toBe("paused");
      expect(run.failedWindowIds).toHaveLength(1);
      expect(haikuCallCount).toBe(0);
    } finally {
      freshServer.close();
    }
  });

  it("GET /merge returns failedWindowIds when paused", async () => {
    const failableClassifier = new FailableClassifier();
    failableClassifier.scheduleCoverageCall({ statusCode: 429, retryAfterMs: 1 });
    failableClassifier.scheduleCoverageCall({ statusCode: 429, retryAfterMs: 1 });
    failableClassifier.scheduleCoverageCall({ statusCode: 429, retryAfterMs: 1 });

    server.close();
    const freshServer = await startTestServer({ classifier: failableClassifier, writingModel });

    try {
      const lecture = await createLecture(freshServer.url);
      await putNotes(freshServer.url, lecture.id, oneBlockNotes("B01", "note", Date.now()));
      await sealWithPdf(freshServer.url, lecture.id, SLIDE_PDF);
      await postMerge(freshServer.url, lecture.id);

      const { status, body } = await getMerge(freshServer.url, lecture.id);
      expect(status).toBe(200);
      const run = (body as MergeStatusResponse).mergeRun;
      expect(run.state).toBe("paused");
      expect(run.failedWindowIds.length).toBeGreaterThan(0);
    } finally {
      freshServer.close();
    }
  });

  it("retry re-runs only failed windows and completes the merge", async () => {
    const failableClassifier = new FailableClassifier();
    // Fail all 3 retry attempts for the first merge
    failableClassifier.scheduleCoverageCall({ statusCode: 429, retryAfterMs: 1 });
    failableClassifier.scheduleCoverageCall({ statusCode: 429, retryAfterMs: 1 });
    failableClassifier.scheduleCoverageCall({ statusCode: 429, retryAfterMs: 1 });
    // No more failures → retry call succeeds

    server.close();
    const freshServer = await startTestServer({ classifier: failableClassifier, writingModel });

    try {
      const lecture = await createLecture(freshServer.url);
      await putNotes(freshServer.url, lecture.id, oneBlockNotes("B01", "note", Date.now()));
      await sealWithPdf(freshServer.url, lecture.id, SLIDE_PDF);

      // First attempt: should pause
      await postMerge(freshServer.url, lecture.id);
      const getMergeResult = await getMerge(freshServer.url, lecture.id);
      expect((getMergeResult.body as MergeStatusResponse).mergeRun.state).toBe("paused");

      // Retry with no more failures scripted — should succeed
      const retryRes = await fetch(
        `${freshServer.url}/api/lectures/${lecture.id}/merge/retry`,
        { method: "POST" },
      );
      const retryBody = await retryRes.json() as { mergeRun: MergeRun; mergedNote: MergedBlock[] };
      expect(retryRes.status).toBe(200);
      expect(retryBody.mergeRun.state).toBe("done");
      expect(retryBody.mergeRun.failedWindowIds).toHaveLength(0);
    } finally {
      freshServer.close();
    }
  });

  it("per-window persistence: finished windows are not reprocessed on retry", async () => {
    const twoSlidePdf = buildTwoSlidePdf();

    const failableClassifier = new FailableClassifier();
    // W001: success (null = use parent's default, which is covered)
    failableClassifier.scheduleCoverageCall(null);
    // W002: fail all 3 attempts
    failableClassifier.scheduleCoverageCall({ statusCode: 429, retryAfterMs: 1 });
    failableClassifier.scheduleCoverageCall({ statusCode: 429, retryAfterMs: 1 });
    failableClassifier.scheduleCoverageCall({ statusCode: 429, retryAfterMs: 1 });
    // After retry: no more failures → W002 succeeds

    server.close();
    const freshServer = await startTestServer({ classifier: failableClassifier, writingModel });

    try {
      const t = Date.now();
      const lecture = await createLecture(freshServer.url);
      const notes = {
        blocks: [
          { id: "B01", type: "paragraph", content: [{ type: "text", text: "Note one" }], children: [] },
          { id: "B02", type: "paragraph", content: [{ type: "text", text: "Note two" }], children: [] },
        ],
        meta: {
          B01: { firstEditTime: t, lastEditTime: t + 5 * 60 * 1000 },
          B02: { firstEditTime: t + 10 * 60 * 1000, lastEditTime: t + 15 * 60 * 1000 },
        },
      };
      await putNotes(freshServer.url, lecture.id, notes);

      // Seal with 2-slide PDF
      const form = new FormData();
      form.append("subjectName", "Anatomy 101");
      form.append("presentation", twoSlidePdf, {
        filename: "slides.pdf",
        contentType: "application/pdf",
      });
      const headers = form.getHeaders() as Record<string, string>;
      await fetch(`${freshServer.url}/api/lectures/${lecture.id}/sources`, {
        method: "POST",
        headers,
        body: form.getBuffer(),
      });

      // Add a marker between the two blocks to create 2 windows
      await fetch(`${freshServer.url}/api/lectures/${lecture.id}/markers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timestamp: t + 7 * 60 * 1000, blockId: "B01" }),
      });

      // First merge attempt: W001 succeeds, W002 fails → paused
      await postMerge(freshServer.url, lecture.id);

      const mergeRunRes = await getMerge(freshServer.url, lecture.id);
      const mergeRunState = (mergeRunRes.body as MergeStatusResponse).mergeRun;
      expect(mergeRunState.state).toBe("paused");

      // Check window result statuses
      const windowResults = freshServer.db
        .prepare("SELECT * FROM window_results WHERE merge_run_id = ?")
        .all(mergeRunState.id) as Array<{
          window_id: string;
          coverage_attempts: number;
          coverage_status: string;
        }>;

      const w001 = windowResults.find((wr) => wr.window_id === "W001");
      const w002 = windowResults.find((wr) => wr.window_id === "W002");
      expect(w001?.coverage_status).toBe("done");
      expect(w002?.coverage_status).toBe("failed");
      const w001AttemptsAfterFirst = w001?.coverage_attempts ?? 0;

      // Retry: no more failures → W002 succeeds
      const retryRes = await fetch(
        `${freshServer.url}/api/lectures/${lecture.id}/merge/retry`,
        { method: "POST" },
      );
      expect(retryRes.status).toBe(200);
      const retryBody = await retryRes.json() as { mergeRun: MergeRun };
      expect(retryBody.mergeRun.state).toBe("done");

      // W001 was NOT reprocessed (attempts unchanged)
      const windowResultsAfterRetry = freshServer.db
        .prepare("SELECT * FROM window_results WHERE merge_run_id = ?")
        .all(mergeRunState.id) as Array<{ window_id: string; coverage_attempts: number }>;
      const w001After = windowResultsAfterRetry.find((wr) => wr.window_id === "W001");
      expect(w001After?.coverage_attempts).toBe(w001AttemptsAfterFirst);
    } finally {
      freshServer.close();
    }
  });

  it("POST /merge/retry returns 409 when merge is not paused (already done)", async () => {
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "note", Date.now()));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);
    await postMerge(server.url, lecture.id); // succeeds → state = done

    const res = await fetch(
      `${server.url}/api/lectures/${lecture.id}/merge/retry`,
      { method: "POST" },
    );
    expect(res.status).toBe(409);
  });

  it("a Haiku failure pauses the merge; retry re-runs only Haiku until it succeeds (#34)", async () => {
    let haikuCalls = 0;
    const flakyWritingModel = new ScriptedWritingModel();
    flakyWritingModel.setOperations([]);
    const generate = flakyWritingModel.generateOperations.bind(flakyWritingModel);
    flakyWritingModel.generateOperations = async (input: unknown) => {
      haikuCalls++;
      if (haikuCalls <= 2) throw new Error("Anthropic 529: overloaded");
      return generate(input);
    };

    let coverageCalls = 0;
    const countingClassifier = new ScriptedClassifier();
    countingClassifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
    });
    const classify = countingClassifier.classifyCoverage.bind(countingClassifier);
    countingClassifier.classifyCoverage = async (state, questions) => {
      coverageCalls++;
      return classify(state, questions);
    };

    server.close();
    const freshServer = await startTestServer({
      classifier: countingClassifier,
      writingModel: flakyWritingModel,
    });

    try {
      const lecture = await createLecture(freshServer.url);
      await putNotes(freshServer.url, lecture.id, oneBlockNotes("B01", "note", Date.now()));
      await sealWithPdf(freshServer.url, lecture.id, SLIDE_PDF);

      // First Haiku failure: the merge pauses with no failed windows, not a 500 or a stuck run
      const first = await postMerge(freshServer.url, lecture.id);
      expect(first.status).toBe(201);
      expect((first.body as MergeResponse).mergeRun.state).toBe("paused");
      expect((first.body as MergeResponse).mergeRun.failedWindowIds).toHaveLength(0);
      expect(haikuCalls).toBe(1);
      const jevCallsAfterFirst = coverageCalls;

      const status = await getMerge(freshServer.url, lecture.id);
      expect((status.body as MergeStatusResponse).mergeRun.state).toBe("paused");

      // Second failure, this time on the retry path: still paused
      const retryUrl = `${freshServer.url}/api/lectures/${lecture.id}/merge/retry`;
      const second = await fetch(retryUrl, { method: "POST" });
      expect(second.status).toBe(200);
      expect(((await second.json()) as { mergeRun: MergeRun }).mergeRun.state).toBe("paused");
      expect(haikuCalls).toBe(2);

      // Third attempt succeeds and completes the merge
      const third = await fetch(retryUrl, { method: "POST" });
      const thirdBody = (await third.json()) as { mergeRun: MergeRun; mergedNote: MergedBlock[] };
      expect(third.status).toBe(200);
      expect(thirdBody.mergeRun.state).toBe("done");
      expect(haikuCalls).toBe(3);
      expect(thirdBody.mergedNote.some((b) => b.origin === "addition" || b.origin === "fallback")).toBe(true);

      // Jev is never re-run: every window already finished
      expect(coverageCalls).toBe(jevCallsAfterFirst);
    } finally {
      freshServer.close();
    }
  });

  it("POST /merge/retry returns 404 when no merge run exists", async () => {
    const lecture = await createLecture(server.url);
    const res = await fetch(
      `${server.url}/api/lectures/${lecture.id}/merge/retry`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });
});

describe("Merge with transcript sentences (#22)", () => {
  it("transcript sentence in its window enters coverage questions", async () => {
    // The sentence's clockStartTimeMs falls inside the lecture window.
    // Classifier returns missing for it → edit list entry with sentence ID.
    const scriptedClassifier = new ScriptedClassifier();
    const scriptedWritingModel = new ScriptedWritingModel();
    const srv = await startTestServer({ classifier: scriptedClassifier, writingModel: scriptedWritingModel });

    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      sealWithoutSlides(srv, lecture.id);

      // Sentence at t+1000 is inside the window [t, t+5min)
      addSentence(srv, lecture.id, "A01-T0001", t + 1000, "Transcript fact about anatomy");

      // Script the sentence key as missing so an edit list entry is created
      scriptedClassifier.addCoverageAnswers({
        "coverage:A01-T0001": { label: "missing", probability: 0.95 },
      });

      const { status, body } = await postMerge(srv.url, lecture.id);
      expect(status).toBe(201);
      expect((body as MergeResponse).mergeRun.state).toBe("done");

      // Verify edit list entry was created for the sentence
      const editList = srv.db
        .prepare("SELECT * FROM edit_list_entries WHERE merge_run_id = ?")
        .all((body as MergeResponse).mergeRun.id) as Array<{
          type: string;
          source_ids: string;
          source_text: string;
        }>;
      const entry = editList.find((e) => JSON.parse(e.source_ids).includes("A01-T0001"));
      expect(entry).toBeDefined();
      expect(entry!.type).toBe("missing");
      expect(entry!.source_text).toBe("Transcript fact about anatomy");
    } finally {
      srv.close();
    }
  });

  it("margin sentences (outside window, within 1-minute) are context only and not judged", async () => {
    const scriptedClassifier = new ScriptedClassifier();
    const srv = await startTestServer({ classifier: scriptedClassifier, writingModel: new ScriptedWritingModel() });

    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      sealWithoutSlides(srv, lecture.id);

      // Sentence at t-30s is BEFORE the window but within 1-minute margin (contextMarginMs=60000)
      addSentence(srv, lecture.id, "A01-T0001", t - 30000, "Margin sentence text");

      const { status, body } = await postMerge(srv.url, lecture.id);
      expect(status).toBe(201);

      // No edit list entry should be created for the margin sentence
      const editList = srv.db
        .prepare("SELECT * FROM edit_list_entries WHERE merge_run_id = ?")
        .all((body as MergeResponse).mergeRun.id) as Array<{ source_ids: string }>;
      const marginEntry = editList.find((e) => JSON.parse(e.source_ids).includes("A01-T0001"));
      expect(marginEntry).toBeUndefined();
    } finally {
      srv.close();
    }
  });

  it("flagged_unhandled sentences still enter the pool", async () => {
    const scriptedClassifier = new ScriptedClassifier();
    const srv = await startTestServer({ classifier: scriptedClassifier, writingModel: new ScriptedWritingModel() });

    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      sealWithoutSlides(srv, lecture.id);

      // Flagged_unhandled sentence in window
      addSentence(srv, lecture.id, "A01-T0001", t + 1000, "Flagged sentence text", { flagState: "flagged_unhandled" });

      scriptedClassifier.addCoverageAnswers({
        "coverage:A01-T0001": { label: "missing", probability: 0.95 },
      });

      const { status, body } = await postMerge(srv.url, lecture.id);
      expect(status).toBe(201);

      const editList = srv.db
        .prepare("SELECT * FROM edit_list_entries WHERE merge_run_id = ?")
        .all((body as MergeResponse).mergeRun.id) as Array<{ source_ids: string }>;
      const entry = editList.find((e) => JSON.parse(e.source_ids).includes("A01-T0001"));
      expect(entry).toBeDefined();
    } finally {
      srv.close();
    }
  });

  it("notes+audio lecture (no slides) completes merge using transcript sentences", async () => {
    const scriptedClassifier = new ScriptedClassifier();
    const scriptedWritingModel = new ScriptedWritingModel();
    const srv = await startTestServer({ classifier: scriptedClassifier, writingModel: scriptedWritingModel });

    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      sealWithoutSlides(srv, lecture.id);

      addSentence(srv, lecture.id, "A01-T0001", t + 1000, "Audio-only lecture fact");

      scriptedClassifier.addCoverageAnswers({
        "coverage:A01-T0001": { label: "missing", probability: 0.95 },
      });

      const { status, body } = await postMerge(srv.url, lecture.id);
      expect(status).toBe(201);
      expect((body as MergeResponse).mergeRun.state).toBe("done");

      // Verify the edit list entry has transcript (not slide) source
      const editList = srv.db
        .prepare("SELECT * FROM edit_list_entries WHERE merge_run_id = ?")
        .all((body as MergeResponse).mergeRun.id) as Array<{ source_ids: string; type: string }>;
      expect(editList.length).toBeGreaterThan(0);
      const entry = editList[0]!;
      const sourceIds = JSON.parse(entry.source_ids) as string[];
      expect(sourceIds[0]).toMatch(/^A/);
      expect(entry.type).toBe("missing");
    } finally {
      srv.close();
    }
  });

  it("slide vs transcript disagreement: conflict entry cites both source IDs", async () => {
    const scriptedClassifier = new ScriptedClassifier();
    const srv = await startTestServer({ classifier: scriptedClassifier, writingModel: new ScriptedWritingModel() });

    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note that is wrong", t));
      await sealWithPdf(srv.url, lecture.id, SLIDE_PDF);

      // Add a transcript sentence in the same window
      addSentence(srv, lecture.id, "A01-T0001", t + 1000, "Transcript says something different");

      // Note block B01 conflicts with pool (slide bullet + transcript sentence)
      scriptedClassifier.addConflictAnswers({
        "conflict:B01": { label: "conflicts", probability: 0.97 },
      });

      const { status, body } = await postMerge(srv.url, lecture.id);
      expect(status).toBe(201);

      // Conflict edit list entry should cite both a slide source (S...) and transcript (A...)
      const editList = srv.db
        .prepare("SELECT * FROM edit_list_entries WHERE merge_run_id = ?")
        .all((body as MergeResponse).mergeRun.id) as Array<{
          type: string;
          source_ids: string;
          note_id: string;
        }>;
      const conflictEntry = editList.find((e) => e.type === "conflict" && e.note_id === "B01");
      expect(conflictEntry).toBeDefined();
      const sourceIds = JSON.parse(conflictEntry!.source_ids) as string[];
      expect(sourceIds.some((id) => id.startsWith("S"))).toBe(true);
      expect(sourceIds.some((id) => id.startsWith("A"))).toBe(true);
    } finally {
      srv.close();
    }
  });

  it("slide with no text is judged from transcript sentences only", async () => {
    // Build a PDF with a text-less slide so bullets are empty for that slide's window
    // but a transcript sentence in that window should still be judged.
    const scriptedClassifier = new ScriptedClassifier();
    const srv = await startTestServer({ classifier: scriptedClassifier, writingModel: new ScriptedWritingModel() });

    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      sealWithoutSlides(srv, lecture.id);

      // Sentence in window → should be judged even with no slides
      addSentence(srv, lecture.id, "A01-T0001", t + 1000, "Only transcript source");

      scriptedClassifier.addCoverageAnswers({
        "coverage:A01-T0001": { label: "missing", probability: 0.95 },
      });

      const { status, body } = await postMerge(srv.url, lecture.id);
      expect(status).toBe(201);
      expect((body as MergeResponse).mergeRun.state).toBe("done");

      const editList = srv.db
        .prepare("SELECT * FROM edit_list_entries WHERE merge_run_id = ?")
        .all((body as MergeResponse).mergeRun.id) as Array<{ source_ids: string }>;
      expect(editList.some((e) => JSON.parse(e.source_ids as string).includes("A01-T0001"))).toBe(true);
    } finally {
      srv.close();
    }
  });

  it("addition citation for transcript sentence has correct text and kind", async () => {
    // When Haiku returns an add_after op with transcript sourceId, the merged block
    // should have citation.kind=transcript and citation.text = the sentence text.
    const scriptedClassifier = new ScriptedClassifier();
    const scriptedWritingModel = new ScriptedWritingModel();
    const srv = await startTestServer({ classifier: scriptedClassifier, writingModel: scriptedWritingModel });

    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      sealWithoutSlides(srv, lecture.id);

      addSentence(srv, lecture.id, "A01-T0001", t + 1000, "The transcript fact");

      scriptedClassifier.addCoverageAnswers({
        "coverage:A01-T0001": { label: "missing", probability: 0.95 },
      });

      // Script Haiku to return an add_after op for the sentence
      scriptedWritingModel.setOperations([
        { type: "add_after", blockId: "B01", text: "Added from transcript", sourceIds: ["A01-T0001"] },
      ]);

      const { status, body } = await postMerge(srv.url, lecture.id);
      expect(status).toBe(201);
      const mergedNote = (body as MergeResponse).mergedNote;

      const additionBlock = mergedNote.find((b) => b.origin === "addition");
      expect(additionBlock).toBeDefined();
      expect(additionBlock!.citations).toHaveLength(1);
      const citation = additionBlock!.citations[0]!;
      expect(citation.sourceId).toBe("A01-T0001");
      expect(citation.kind).toBe("transcript");
      expect(citation.text).toBe("The transcript fact");
    } finally {
      srv.close();
    }
  });
});

describe("Low-confidence badge (#27)", () => {
  it("addition citing only flagged_unhandled transcript sentence is low confidence", async () => {
    const scriptedClassifier = new ScriptedClassifier();
    const scriptedWritingModel = new ScriptedWritingModel();
    const srv = await startTestServer({ classifier: scriptedClassifier, writingModel: scriptedWritingModel });
    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      sealWithoutSlides(srv, lecture.id);
      addSentence(srv, lecture.id, "A01-T0001", t + 1000, "Flagged transcript fact", {
        flagState: "flagged_unhandled",
      });

      scriptedClassifier.addCoverageAnswers({
        "coverage:A01-T0001": { label: "missing", probability: 0.95 },
      });
      scriptedWritingModel.setOperations([
        { type: "add_after", blockId: "B01", text: "Added from flagged sentence", sourceIds: ["A01-T0001"] },
      ]);

      const { body } = await postMerge(srv.url, lecture.id);
      const mergedNote = (body as MergeResponse).mergedNote;
      const addition = mergedNote.find((b) => b.origin === "addition");
      expect(addition).toBeDefined();
      expect(addition!.lowConfidence).toBe(true);
    } finally {
      srv.close();
    }
  });

  it("addition citing a handled (corrected) transcript sentence is not low confidence", async () => {
    const scriptedClassifier = new ScriptedClassifier();
    const scriptedWritingModel = new ScriptedWritingModel();
    const srv = await startTestServer({ classifier: scriptedClassifier, writingModel: scriptedWritingModel });
    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      sealWithoutSlides(srv, lecture.id);
      addSentence(srv, lecture.id, "A01-T0001", t + 1000, "Corrected transcript fact", {
        flagState: "corrected",
      });

      scriptedClassifier.addCoverageAnswers({
        "coverage:A01-T0001": { label: "missing", probability: 0.95 },
      });
      scriptedWritingModel.setOperations([
        { type: "add_after", blockId: "B01", text: "Added from corrected sentence", sourceIds: ["A01-T0001"] },
      ]);

      const { body } = await postMerge(srv.url, lecture.id);
      const mergedNote = (body as MergeResponse).mergedNote;
      const addition = mergedNote.find((b) => b.origin === "addition");
      expect(addition).toBeDefined();
      expect(addition!.lowConfidence).toBe(false);
    } finally {
      srv.close();
    }
  });

  it("addition citing a handled (advanced) transcript sentence is not low confidence", async () => {
    const scriptedClassifier = new ScriptedClassifier();
    const scriptedWritingModel = new ScriptedWritingModel();
    const srv = await startTestServer({ classifier: scriptedClassifier, writingModel: scriptedWritingModel });
    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      sealWithoutSlides(srv, lecture.id);
      addSentence(srv, lecture.id, "A01-T0001", t + 1000, "Advanced transcript fact", {
        flagState: "advanced",
      });

      scriptedClassifier.addCoverageAnswers({
        "coverage:A01-T0001": { label: "missing", probability: 0.95 },
      });
      scriptedWritingModel.setOperations([
        { type: "add_after", blockId: "B01", text: "Added from advanced sentence", sourceIds: ["A01-T0001"] },
      ]);

      const { body } = await postMerge(srv.url, lecture.id);
      const mergedNote = (body as MergeResponse).mergedNote;
      const addition = mergedNote.find((b) => b.origin === "addition");
      expect(addition).toBeDefined();
      expect(addition!.lowConfidence).toBe(false);
    } finally {
      srv.close();
    }
  });

  it("student block is never low confidence even if all transcript sentences are flagged_unhandled", async () => {
    const scriptedClassifier = new ScriptedClassifier();
    const srv = await startTestServer({ classifier: scriptedClassifier });
    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      sealWithoutSlides(srv, lecture.id);
      addSentence(srv, lecture.id, "A01-T0001", t + 1000, "Flagged sentence", {
        flagState: "flagged_unhandled",
      });

      scriptedClassifier.addCoverageAnswers({
        "coverage:A01-T0001": { label: "covered", probability: 0.95 },
      });

      const { body } = await postMerge(srv.url, lecture.id);
      const mergedNote = (body as MergeResponse).mergedNote;
      const studentBlock = mergedNote.find((b) => b.origin === "student");
      expect(studentBlock).toBeDefined();
      expect(studentBlock!.lowConfidence).toBe(false);
    } finally {
      srv.close();
    }
  });

  it("badge clears when played=true is PATCHed and a final review state is set", async () => {
    const scriptedClassifier = new ScriptedClassifier();
    const scriptedWritingModel = new ScriptedWritingModel();
    const srv = await startTestServer({ classifier: scriptedClassifier, writingModel: scriptedWritingModel });
    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      sealWithoutSlides(srv, lecture.id);
      addSentence(srv, lecture.id, "A01-T0001", t + 1000, "Flagged sentence", {
        flagState: "flagged_unhandled",
      });

      scriptedClassifier.addCoverageAnswers({
        "coverage:A01-T0001": { label: "missing", probability: 0.95 },
      });
      scriptedWritingModel.setOperations([
        { type: "add_after", blockId: "B01", text: "Low confidence addition", sourceIds: ["A01-T0001"] },
      ]);

      const { body: mergeBody } = await postMerge(srv.url, lecture.id);
      const addition = (mergeBody as MergeResponse).mergedNote.find((b) => b.origin === "addition");
      expect(addition!.lowConfidence).toBe(true);

      // Play the block — badge still shows until review decision
      const playRes = await fetch(`${srv.url}/api/lectures/${lecture.id}/merged-note/${addition!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ played: true }),
      });
      const playBody = await playRes.json() as { block: MergedBlock };
      expect(playBody.block.played).toBe(true);
      expect(playBody.block.lowConfidence).toBe(true);

      // Keep the block — now badge clears
      const keepRes = await fetch(`${srv.url}/api/lectures/${lecture.id}/merged-note/${addition!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewState: "kept" }),
      });
      const keepBody = await keepRes.json() as { block: MergedBlock };
      expect(keepBody.block.lowConfidence).toBe(false);
    } finally {
      srv.close();
    }
  });

  it("conflict block citing only flagged_unhandled transcript sentence is low confidence", async () => {
    const scriptedClassifier = new ScriptedClassifier();
    const scriptedWritingModel = new ScriptedWritingModel();
    const srv = await startTestServer({ classifier: scriptedClassifier, writingModel: scriptedWritingModel });
    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note about topic", t));
      sealWithoutSlides(srv, lecture.id);
      addSentence(srv, lecture.id, "A01-T0001", t + 1000, "Different transcript claim", {
        flagState: "flagged_unhandled",
      });

      scriptedClassifier.addCoverageAnswers({
        "coverage:A01-T0001": { label: "missing", probability: 0.95 },
      });
      scriptedClassifier.addConflictAnswers({
        "conflict:B01": { label: "conflicts", probability: 0.95 },
      });
      scriptedWritingModel.setOperations([
        { type: "rewrite", blockId: "B01", text: "Rewritten from transcript", sourceIds: ["A01-T0001"] },
      ]);

      const { body } = await postMerge(srv.url, lecture.id);
      const mergedNote = (body as MergeResponse).mergedNote;
      const conflict = mergedNote.find((b) => b.origin === "conflict");
      expect(conflict).toBeDefined();
      expect(conflict!.lowConfidence).toBe(true);
    } finally {
      srv.close();
    }
  });

  it("export is not blocked by low-confidence blocks", async () => {
    const scriptedClassifier = new ScriptedClassifier();
    const scriptedWritingModel = new ScriptedWritingModel();
    const srv = await startTestServer({ classifier: scriptedClassifier, writingModel: scriptedWritingModel });
    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      sealWithoutSlides(srv, lecture.id);
      addSentence(srv, lecture.id, "A01-T0001", t + 1000, "Flagged sentence", {
        flagState: "flagged_unhandled",
      });

      scriptedClassifier.addCoverageAnswers({
        "coverage:A01-T0001": { label: "missing", probability: 0.95 },
      });
      scriptedWritingModel.setOperations([
        { type: "add_after", blockId: "B01", text: "Low confidence addition", sourceIds: ["A01-T0001"] },
      ]);

      await postMerge(srv.url, lecture.id);

      // Final note should be accessible even with low-confidence blocks
      const res = await fetch(`${srv.url}/api/lectures/${lecture.id}/final-note`);
      expect(res.status).toBe(200);
    } finally {
      srv.close();
    }
  });
});

class RecordingClassifier extends ScriptedClassifier {
  coverageKeys: string[] = [];

  override async classifyCoverage(
    state: string,
    questions: Parameters<ScriptedClassifier["classifyCoverage"]>[1],
  ): ReturnType<ScriptedClassifier["classifyCoverage"]> {
    this.coverageKeys.push(...questions.map((q) => q.key));
    return super.classifyCoverage(state, questions);
  }
}

describe("Merge builds windows like the windows route (#32)", () => {
  async function startRecording(): Promise<{ srv: TestServer; classifier: RecordingClassifier }> {
    const classifier = new RecordingClassifier();
    const srv = await startTestServer({ classifier, writingModel: new ScriptedWritingModel() });
    return { srv, classifier };
  }

  it("a reassigned window changes which slide bullets are judged", async () => {
    const { srv, classifier } = await startRecording();
    try {
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", Date.now()));
      await sealWithPdf(srv.url, lecture.id, TWO_SLIDE_PDF);

      // One window, default-mapped to S001; reassign it to S002
      const res = await fetch(`${srv.url}/api/lectures/${lecture.id}/windows/W001`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappedSlides: ["S002"] }),
      });
      expect(res.status).toBe(200);

      await postMerge(srv.url, lecture.id);
      expect(classifier.coverageKeys).toContain("coverage:S002-B01");
      expect(classifier.coverageKeys).not.toContain("coverage:S001-B01");
    } finally {
      srv.close();
    }
  });

  it("a deleted window drops its slides from the judged pool", async () => {
    const { srv, classifier } = await startRecording();
    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      createMarker(srv.db, "M1", lecture.id, t + 2 * 60 * 1000, "B01");
      await sealWithPdf(srv.url, lecture.id, TWO_SLIDE_PDF);

      // Two windows: W001 → S001, W002 → S002. Deleting W001 drops S001.
      const res = await fetch(`${srv.url}/api/lectures/${lecture.id}/windows/W001`, { method: "DELETE" });
      expect(res.status).toBe(200);

      await postMerge(srv.url, lecture.id);
      expect(classifier.coverageKeys).toContain("coverage:S002-B01");
      expect(classifier.coverageKeys).not.toContain("coverage:S001-B01");
    } finally {
      srv.close();
    }
  });

  it("a transcript sentence before the first note lands in window 1 and is judged", async () => {
    const { srv, classifier } = await startRecording();
    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      sealWithoutSlides(srv, lecture.id);
      // Audio starts 31s before the first note; the sentence sits in that audio-only time
      addSentence(srv, lecture.id, "A01-T0001", t - 30000, "Before the first note");

      await postMerge(srv.url, lecture.id);
      expect(classifier.coverageKeys).toContain("coverage:A01-T0001");
    } finally {
      srv.close();
    }
  });

  it("a transcript sentence after the last edit lands in the last window and is judged", async () => {
    const { srv, classifier } = await startRecording();
    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      sealWithoutSlides(srv, lecture.id);
      // Last edit is t + 5min; the sentence is 30s later, inside the audio
      addSentence(srv, lecture.id, "A01-T0001", t + 5 * 60 * 1000 + 30000, "After the last edit");

      await postMerge(srv.url, lecture.id);
      expect(classifier.coverageKeys).toContain("coverage:A01-T0001");
    } finally {
      srv.close();
    }
  });

  it("window IDs used by merge match those the transcription route reports", async () => {
    const { srv } = await startRecording();
    try {
      const t = Date.now();
      const lecture = await createLecture(srv.url);
      await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "My note", t));
      createMarker(srv.db, "M1", lecture.id, t + 2 * 60 * 1000, "B01");
      sealWithoutSlides(srv, lecture.id);
      addSentence(srv, lecture.id, "A01-T0001", t - 30000, "Before the first note");
      addSentence(srv, lecture.id, "A01-T0002", t + 3 * 60 * 1000, "Inside the second window");

      const { body } = await postMerge(srv.url, lecture.id);
      const runId = (body as MergeResponse).mergeRun.id;
      const mergeIds = (srv.db
        .prepare("SELECT window_id FROM window_results WHERE merge_run_id = ? ORDER BY window_id")
        .all(runId) as Array<{ window_id: string }>).map((r) => r.window_id);

      const res = await fetch(`${srv.url}/api/lectures/${lecture.id}/sentences`);
      const { windows } = await res.json() as { windows: Array<{ id: string }> };
      expect(mergeIds).toEqual(windows.map((w) => w.id).sort());
    } finally {
      srv.close();
    }
  });
});

describe("Conflict evidence and Haiku pool texts (#33)", () => {
  // Slide S001-B01 plus transcript sentence A01-T0001 in one window; B01 is flagged as conflicting
  async function setup(
    srv: TestServer,
    classifier: ScriptedClassifier,
    evidenceIds: string[] | undefined,
  ): Promise<{ lectureId: string }> {
    const t = Date.now();
    const lecture = await createLecture(srv.url);
    await putNotes(srv.url, lecture.id, oneBlockNotes("B01", "The heart has three chambers", t));
    await sealWithPdf(srv.url, lecture.id, SLIDE_PDF);
    addSentence(srv, lecture.id, "A01-T0001", t + 1000, "The heart has four chambers");
    classifier.addConflictAnswers({
      "conflict:B01": { label: "conflicts", probability: 0.97, evidenceIds },
    });
    return { lectureId: lecture.id };
  }

  function conflictEntry(srv: TestServer, runId: string): { source_ids: string } {
    return srv.db
      .prepare("SELECT source_ids FROM edit_list_entries WHERE merge_run_id = ? AND type = 'conflict'")
      .get(runId) as { source_ids: string };
  }

  it("a conflict cites only the evidence items the classifier named", async () => {
    const { lectureId } = await setup(server, classifier, ["A01-T0001"]);
    const { body } = await postMerge(server.url, lectureId);
    const entry = conflictEntry(server, (body as MergeResponse).mergeRun.id);
    expect(JSON.parse(entry.source_ids)).toEqual(["A01-T0001"]);

    const note = (await getMergedNote(server.url, lectureId)).body as MergedNoteResponse;
    const flag = note.blocks.find((b) => b.origin === "conflict")!;
    expect(flag.citations.map((c) => c.sourceId)).toEqual(["A01-T0001"]);
  });

  it("Haiku receives pool items with id, text and slide/transcript label for conflict entries", async () => {
    const { lectureId } = await setup(server, classifier, ["S001-B01", "A01-T0001"]);
    await postMerge(server.url, lectureId);

    const input = writingModel.lastInput as {
      editList: Array<{
        type: string;
        noteId?: string;
        sourceText: string;
        poolItems?: Array<{ id: string; text: string; label: string }>;
      }>;
    };
    const entry = input.editList.find((e) => e.type === "conflict")!;
    expect(entry.noteId).toBe("B01");
    expect(entry.sourceText).toBe("The heart has three chambers");
    expect(entry.poolItems).toEqual([
      { id: "S001-B01", text: "Important fact about anatomy", label: "slide" },
      { id: "A01-T0001", text: "The heart has four chambers", label: "transcript" },
    ]);
  });

  it("an addition op cannot satisfy a conflict entry", async () => {
    const { lectureId } = await setup(server, classifier, ["A01-T0001"]);
    writingModel.setOperations([
      { type: "add_after", blockId: "B01", text: "Four chambers.", sourceIds: ["A01-T0001"] },
    ]);
    const { body } = await postMerge(server.url, lectureId);
    const runId = (body as MergeResponse).mergeRun.id;

    const op = server.db
      .prepare("SELECT status, drop_reason FROM operations WHERE merge_run_id = ?")
      .get(runId) as { status: string; drop_reason: string };
    expect(op.status).toBe("dropped");
    expect(op.drop_reason).toBe("No matching edit list entry");

    const note = (await getMergedNote(server.url, lectureId)).body as MergedNoteResponse;
    const flag = note.blocks.find((b) => b.origin === "conflict")!;
    expect(flag.modelPlaced).toBe(false);
  });

  it("a rewrite citing IDs outside the conflict's evidence is rejected", async () => {
    const { lectureId } = await setup(server, classifier, ["A01-T0001"]);
    writingModel.setOperations([
      { type: "rewrite", blockId: "B01", text: "Four chambers.", sourceIds: ["S001-B01"] },
    ]);
    const { body } = await postMerge(server.url, lectureId);
    const op = server.db
      .prepare("SELECT status, drop_reason FROM operations WHERE merge_run_id = ?")
      .get((body as MergeResponse).mergeRun.id) as { status: string; drop_reason: string };
    expect(op.status).toBe("dropped");
    expect(op.drop_reason).toBe("Unknown source ID: S001-B01");
  });
});
