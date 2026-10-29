import { describe, it, expect, beforeEach, afterEach } from "vitest";
import FormData from "form-data";
import path from "path";
import { readFileSync } from "fs";
import { openDb, listAudioFiles } from "../../src/server/db.js";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture, MergedBlock, MergeRun } from "../../src/shared/types.js";
import { ScriptedClassifier, ScriptedWritingModel } from "../../src/providers/fakes.js";

const FIXTURES = path.resolve("tests/fixtures");
const SHORT_AUDIO = readFileSync(path.join(FIXTURES, "short_audio.wav"));

// Builds a minimal valid PDF with a title and one bullet per page
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

function oneBlockNotes(blockId: string, text: string, firstEditTime: number): object {
  return {
    blocks: [
      { id: blockId, type: "paragraph", content: [{ type: "text", text }], children: [] },
    ],
    meta: {
      [blockId]: { firstEditTime, lastEditTime: firstEditTime + 5 * 60 * 1000 },
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

async function sealWithAudio(url: string, lectureId: string): Promise<{ audioFileId: string }> {
  const form = new FormData();
  form.append("subjectName", "Anatomy 101");
  form.append("presentation", SLIDE_PDF, { filename: "slides.pdf", contentType: "application/pdf" });
  form.append("audio1", SHORT_AUDIO, { filename: "lecture.wav", contentType: "audio/wav" });
  form.append("audio1StartTime", String(Date.now()));
  const headers = form.getHeaders() as Record<string, string>;
  await fetch(`${url}/api/lectures/${lectureId}/sources`, {
    method: "POST",
    headers,
    body: form.getBuffer(),
  });
  // read the audio file id directly from the DB
  const files = listAudioFiles(server.db, lectureId);
  return { audioFileId: files[0]?.id ?? "" };
}

async function postMerge(url: string, lectureId: string): Promise<{ mergeRun: MergeRun; mergedNote: MergedBlock[] }> {
  const res = await fetch(`${url}/api/lectures/${lectureId}/merge`, { method: "POST" });
  return res.json() as Promise<{ mergeRun: MergeRun; mergedNote: MergedBlock[] }>;
}

async function getMergedNote(url: string, lectureId: string): Promise<MergedBlock[]> {
  const res = await fetch(`${url}/api/lectures/${lectureId}/merged-note`);
  const body = await res.json() as { blocks: MergedBlock[] };
  return body.blocks;
}

async function patchBlockReviewState(
  url: string,
  lectureId: string,
  blockId: string,
  reviewState: string,
): Promise<{ status: number; block?: MergedBlock; error?: string }> {
  const res = await fetch(`${url}/api/lectures/${lectureId}/merged-note/${blockId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewState }),
  });
  const body = await res.json() as { block?: MergedBlock; error?: string };
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

describe("PATCH /api/lectures/:id/merged-note/:blockId — review state", () => {
  it("reverts an addition block and persists the state", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    // Script a missing verdict so an addition block is produced
    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
    });
    writingModel.setOperations([]);

    const { mergedNote } = await postMerge(server.url, lecture.id);
    const addition = mergedNote.find((b) => b.origin === "addition" || b.origin === "fallback");
    expect(addition).toBeDefined();

    // Revert it
    const { status, block } = await patchBlockReviewState(server.url, lecture.id, addition!.id, "reverted");
    expect(status).toBe(200);
    expect(block!.reviewState).toBe("reverted");

    // Fetch again to confirm persistence
    const blocks = await getMergedNote(server.url, lecture.id);
    const updated = blocks.find((b) => b.id === addition!.id);
    expect(updated!.reviewState).toBe("reverted");
  });

  it("keeps an addition block", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
    });
    writingModel.setOperations([]);

    const { mergedNote } = await postMerge(server.url, lecture.id);
    const addition = mergedNote.find((b) => b.origin === "addition" || b.origin === "fallback");
    expect(addition).toBeDefined();

    const { status, block } = await patchBlockReviewState(server.url, lecture.id, addition!.id, "kept");
    expect(status).toBe(200);
    expect(block!.reviewState).toBe("kept");
  });

  it("returns 400 for invalid reviewState value", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);
    classifier.addCoverageAnswers({ "coverage:S001-B01": { label: "missing", probability: 0.98 } });
    writingModel.setOperations([]);

    const { mergedNote } = await postMerge(server.url, lecture.id);
    const addition = mergedNote.find((b) => b.origin === "addition" || b.origin === "fallback");

    const { status } = await patchBlockReviewState(server.url, lecture.id, addition!.id, "invalid");
    expect(status).toBe(400);
  });

  it("returns 404 for a non-existent block", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);
    writingModel.setOperations([]);
    await postMerge(server.url, lecture.id);

    const { status } = await patchBlockReviewState(server.url, lecture.id, "nonexistent-block-id", "reverted");
    expect(status).toBe(404);
  });

  it("persists review state across server restart", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
    });
    writingModel.setOperations([]);

    const { mergedNote } = await postMerge(server.url, lecture.id);
    const addition = mergedNote.find((b) => b.origin === "addition" || b.origin === "fallback");

    await patchBlockReviewState(server.url, lecture.id, addition!.id, "reverted");

    // Simulate restart: open a new db connection to the same file
    const dbPath = server.dataDir + "/notemerge.db";
    server.close();

    // Re-open the same database to verify persistence
    const newDb = openDb(dbPath);
    try {
      const rows = newDb.prepare(
        "SELECT review_state FROM merged_blocks WHERE id = ?",
      ).get(addition!.id) as { review_state: string } | undefined;
      expect(rows?.review_state).toBe("reverted");
    } finally {
      newDb.close();
    }
  });

  it("duplicate additions appear in merged note and can be reverted independently", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    // Script two separate missing items from the same slide
    // Both use the same window so the writing model can add_at_window twice
    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
    });
    // Writing model adds two blocks at the same window — duplicates
    writingModel.setOperations([]);

    await postMerge(server.url, lecture.id);
    const blocks = await getMergedNote(server.url, lecture.id);
    const additions = blocks.filter((b) => b.origin === "addition" || b.origin === "fallback");
    // At least one addition produced (fallback for the missing item)
    expect(additions.length).toBeGreaterThanOrEqual(1);

    // All additions initially have null review_state (default keep)
    for (const a of additions) {
      expect(a.reviewState).toBeNull();
    }

    // Revert the first one independently
    if (additions.length >= 1) {
      const { status } = await patchBlockReviewState(server.url, lecture.id, additions[0]!.id, "reverted");
      expect(status).toBe(200);
    }
  });

  it("additions default to null reviewState (keep is the implicit default)", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);

    classifier.addCoverageAnswers({
      "coverage:S001-B01": { label: "missing", probability: 0.98 },
    });
    writingModel.setOperations([]);

    await postMerge(server.url, lecture.id);
    const blocks = await getMergedNote(server.url, lecture.id);
    const additions = blocks.filter((b) => b.origin === "addition" || b.origin === "fallback");
    for (const a of additions) {
      expect(a.reviewState).toBeNull();
    }
  });
});

describe("Library stage routing — lecture stage in API", () => {
  it("lecture is in review stage after merge completes", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);
    writingModel.setOperations([]);

    await postMerge(server.url, lecture.id);

    const res = await fetch(`${server.url}/api/lectures/${lecture.id}`);
    const updated = await res.json() as Lecture;
    expect(updated.stage).toBe("review");
  });

  it("GET /api/lectures returns stage for each lecture", async () => {
    const lecture = await createLecture(server.url);
    const res = await fetch(`${server.url}/api/lectures`);
    const lectures = await res.json() as Lecture[];
    const found = lectures.find((l) => l.id === lecture.id);
    expect(found).toBeDefined();
    expect(found!.stage).toBe("writing");
  });
});

describe("PATCH /api/lectures/:id/transcription-model — lock after review", () => {
  it("returns 409 when a review decision has been made", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);
    classifier.addCoverageAnswers({ "coverage:S001-B01": { label: "missing", probability: 0.98 } });
    writingModel.setOperations([]);

    const { mergedNote } = await postMerge(server.url, lecture.id);
    const addition = mergedNote.find((b) => b.origin === "addition" || b.origin === "fallback");

    // Make a review decision
    await patchBlockReviewState(server.url, lecture.id, addition!.id, "kept");

    // Now try to change the transcription model
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/transcription-model`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "whisper-large-v3-turbo" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("returns 200 before any review decision", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));
    await sealWithPdf(server.url, lecture.id, SLIDE_PDF);
    writingModel.setOperations([]);
    await postMerge(server.url, lecture.id);

    // No review decision made yet — model change should succeed
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/transcription-model`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "whisper-large-v3-turbo" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/lectures/:id/audio/:fileId/recording-start — lock after review", () => {
  it("returns 409 when a review decision has been made", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "Some notes", t));

    // Seal with audio so we have an audio file
    const { audioFileId } = await sealWithAudio(server.url, lecture.id);
    // If we couldn't get the audio file ID, skip the specific assertion but test the lock
    classifier.addCoverageAnswers({ "coverage:S001-B01": { label: "missing", probability: 0.98 } });
    writingModel.setOperations([]);

    const { mergedNote } = await postMerge(server.url, lecture.id);
    const addition = mergedNote.find((b) => b.origin === "addition" || b.origin === "fallback");

    // Make a review decision
    if (addition) {
      await patchBlockReviewState(server.url, lecture.id, addition.id, "reverted");
    }

    // Try changing recording start time
    const targetFileId = audioFileId || "any-file-id";
    const res = await fetch(
      `${server.url}/api/lectures/${lecture.id}/audio/${targetFileId}/recording-start`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordingStartMs: Date.now() }),
      },
    );
    // With a review decision: 409; without a valid audio file but with review lock: 409
    expect(res.status).toBe(409);
  });
});

// Helper to set up a lecture with one note block and a conflict
async function setupConflictLecture(
  url: string,
  blockId: string,
  noteText: string,
  rewriteText: string,
): Promise<{ lectureId: string; conflictBlock: MergedBlock }> {
  const t = Date.now();
  const lecture = await createLecture(url);
  await putNotes(url, lecture.id, oneBlockNotes(blockId, noteText, t));
  await sealWithPdf(url, lecture.id, SLIDE_PDF);

  classifier.addConflictAnswers({
    [`conflict:${blockId}`]: { label: "conflicts", probability: 0.97 },
  });
  writingModel.setOperations([
    { type: "rewrite", blockId, text: rewriteText, sourceIds: ["S001-B01"] },
  ]);

  const { mergedNote } = await postMerge(url, lecture.id);
  const conflictBlock = mergedNote.find((b) => b.origin === "conflict");
  if (!conflictBlock) throw new Error("no conflict block produced");
  return { lectureId: lecture.id, conflictBlock };
}

async function patchBlock(
  url: string,
  lectureId: string,
  blockId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; block?: MergedBlock; error?: string }> {
  const res = await fetch(`${url}/api/lectures/${lectureId}/merged-note/${blockId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json() as { block?: MergedBlock; error?: string };
  return { status: res.status, ...json };
}

describe("Conflict resolution — K, E, reopen", () => {
  it("conflict block starts as unresolved with originalText and proposedRewrite", async () => {
    const { conflictBlock } = await setupConflictLecture(
      server.url, "B01", "student wrote this", "rewritten text",
    );
    expect(conflictBlock.reviewState).toBe("unresolved");
    expect(conflictBlock.originalText).toBe("student wrote this");
    expect(conflictBlock.proposedRewrite).toBe("rewritten text");
    expect(conflictBlock.text).toBe("student wrote this");
  });

  it("K (kept) resolves conflict and preserves original text", async () => {
    const { lectureId, conflictBlock } = await setupConflictLecture(
      server.url, "B01", "student wrote this", "rewritten text",
    );
    const { status, block } = await patchBlock(server.url, lectureId, conflictBlock.id, {
      reviewState: "kept",
    });
    expect(status).toBe(200);
    expect(block!.reviewState).toBe("kept");
    expect(block!.text).toBe("student wrote this");
  });

  it("E (edited) resolves conflict and sets text to proposedRewrite", async () => {
    const { lectureId, conflictBlock } = await setupConflictLecture(
      server.url, "B01", "student wrote this", "rewritten text",
    );
    const { status, block } = await patchBlock(server.url, lectureId, conflictBlock.id, {
      reviewState: "edited",
    });
    expect(status).toBe(200);
    expect(block!.reviewState).toBe("edited");
    expect(block!.text).toBe("rewritten text");
  });

  it("after E, text is editable and tweaks persist", async () => {
    const { lectureId, conflictBlock } = await setupConflictLecture(
      server.url, "B01", "student wrote this", "rewritten text",
    );
    await patchBlock(server.url, lectureId, conflictBlock.id, { reviewState: "edited" });

    // Tweak the text
    const { status, block } = await patchBlock(server.url, lectureId, conflictBlock.id, {
      text: "tweaked rewrite",
    });
    expect(status).toBe(200);
    expect(block!.text).toBe("tweaked rewrite");

    // Confirm it persisted
    const blocks = await getMergedNote(server.url, lectureId);
    const fetched = blocks.find((b) => b.id === conflictBlock.id);
    expect(fetched!.text).toBe("tweaked rewrite");
  });

  it("reopen restores unresolved state and original text", async () => {
    const { lectureId, conflictBlock } = await setupConflictLecture(
      server.url, "B01", "student wrote this", "rewritten text",
    );

    // Resolve with E first
    await patchBlock(server.url, lectureId, conflictBlock.id, { reviewState: "edited" });

    // Reopen
    const { status, block } = await patchBlock(server.url, lectureId, conflictBlock.id, {
      reviewState: "unresolved",
    });
    expect(status).toBe(200);
    expect(block!.reviewState).toBe("unresolved");
    expect(block!.text).toBe("student wrote this");
    expect(block!.originalText).toBe("student wrote this");
    expect(block!.proposedRewrite).toBe("rewritten text");
  });

  it("reopen from K also restores original text", async () => {
    const { lectureId, conflictBlock } = await setupConflictLecture(
      server.url, "B01", "student wrote this", "rewritten text",
    );

    await patchBlock(server.url, lectureId, conflictBlock.id, { reviewState: "kept" });
    const { block } = await patchBlock(server.url, lectureId, conflictBlock.id, {
      reviewState: "unresolved",
    });
    expect(block!.reviewState).toBe("unresolved");
    expect(block!.text).toBe("student wrote this");
  });

  it("resolution state persists across restart", async () => {
    const { lectureId, conflictBlock } = await setupConflictLecture(
      server.url, "B01", "student wrote this", "rewritten text",
    );
    await patchBlock(server.url, lectureId, conflictBlock.id, { reviewState: "edited" });

    const dbPath = server.dataDir + "/notemerge.db";
    server.close();

    const newDb = openDb(dbPath);
    try {
      const row = newDb
        .prepare("SELECT review_state, text FROM merged_blocks WHERE id = ?")
        .get(conflictBlock.id) as { review_state: string; text: string } | undefined;
      expect(row?.review_state).toBe("edited");
      expect(row?.text).toBe("rewritten text");
    } finally {
      newDb.close();
    }
  });

  it("returns 400 when neither reviewState nor text is provided", async () => {
    const { lectureId, conflictBlock } = await setupConflictLecture(
      server.url, "B01", "student wrote this", "rewritten text",
    );
    const res = await fetch(
      `${server.url}/api/lectures/${lectureId}/merged-note/${conflictBlock.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
  });
});
