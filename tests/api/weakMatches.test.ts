import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync } from "fs";
import path from "path";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture, MergedBlock, MergeRun } from "../../src/shared/types.js";
import { FailableClassifier, FakeEmbeddingProvider, ScriptedWritingModel } from "../../src/providers/fakes.js";
import type { ExtractedSlide } from "../../src/server/pdfExtraction.js";
import { ensureDefaultUser, createSubject, sealLecture } from "../../src/server/db.js";

let server: TestServer | undefined;
afterEach(() => server?.close());

class RecordingClassifier extends FailableClassifier {
  conflicts: Array<{ state: string; keys: string[] }> = [];
  override async checkConflicts(state: string, questions: Parameters<FailableClassifier["checkConflicts"]>[1]) {
    this.conflicts.push({ state, keys: questions.map((q) => q.key) });
    return super.checkConflicts(state, questions);
  }
}

const axis = (i: number, extra: Record<number, number> = {}): number[] => {
  const v = new Array(6).fill(0);
  v[i] = 1;
  for (const [k, x] of Object.entries(extra)) v[Number(k)] = x;
  return v;
};

const slide = (n: number): ExtractedSlide => ({
  id: `S00${n}`,
  title: `Slide ${n}`,
  bullets: [{ id: `S00${n}-B01`, text: `bullet ${n}` }],
});

interface Setup {
  lecture: Lecture;
  url: string;
  classifier: RecordingClassifier;
  writingModel: ScriptedWritingModel;
}

// Untimed, presentation only: three slides, N1 about slide 1, N2 about slide 3, and N3
// resembling slide 1 but written after N2, so the order-preserving alignment makes it a weak
// match assigned to W003.
async function setup(): Promise<Setup> {
  const embeddings = new FakeEmbeddingProvider(6);
  const classifier = new RecordingClassifier();
  const writingModel = new ScriptedWritingModel();
  server = await startTestServer({ embeddings, classifier, writingModel });
  const url = server.url;
  const lecture = (await (
    await fetch(`${url}/api/lectures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "untimed" }),
    })
  ).json()) as Lecture;
  const texts: Record<string, string> = {
    N1: "alpha note about topic one",
    N2: "gamma note about topic three",
    N3: "stray note about topic one",
  };
  const notesData = {
    blocks: Object.entries(texts).map(([id, text]) => ({
      id,
      type: "paragraph",
      content: [{ type: "text", text }],
      children: [],
    })),
    meta: { N1: {}, N2: {}, N3: {} },
  };
  server.db.prepare("UPDATE lectures SET notes_data = ? WHERE id = ?").run(JSON.stringify(notesData), lecture.id);
  writeFileSync(path.join(lecture.dataDir, "slides.json"), JSON.stringify([slide(1), slide(2), slide(3)]));
  const v = embeddings.vectors;
  for (let n = 1; n <= 3; n++) {
    v.set(`Slide ${n}\nbullet ${n}`, axis(n - 1));
    v.set(`bullet ${n}`, axis(n - 1));
  }
  v.set(texts.N1!, axis(0));
  v.set(texts.N2!, axis(2));
  v.set(texts.N3!, axis(0, { 3: 0.5 }));
  const user = ensureDefaultUser(server.db);
  const subject = createSubject(server.db, "subj-wm", "Subject", user.id);
  sealLecture(server.db, lecture.id, subject.id, "/fake/slides.pdf");
  return { lecture, url, classifier, writingModel };
}

const base = (s: Setup): string => `${s.url}/api/lectures/${s.lecture.id}`;

async function merge(s: Setup): Promise<MergeRun> {
  const res = await fetch(`${base(s)}/merge`, { method: "POST" });
  expect(res.status).toBe(201);
  return ((await res.json()) as { mergeRun: MergeRun }).mergeRun;
}

async function mergedNote(s: Setup): Promise<MergedBlock[]> {
  return ((await (await fetch(`${base(s)}/merged-note`)).json()) as { blocks: MergedBlock[] }).blocks;
}

const patch = (s: Setup, blockId: string, body: object) =>
  fetch(`${base(s)}/merged-note/${blockId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("weak matches: conflict check", () => {
  it("sends one extra conflict request per weak match with the pool of its three similar windows, and never as a window question", async () => {
    const s = await setup();
    await merge(s);

    const withN3 = s.classifier.conflicts.filter((c) => c.keys.includes("conflict:N3"));
    expect(withN3).toHaveLength(1);
    expect(withN3[0]!.keys).toEqual(["conflict:N3"]);
    for (const id of ["S001-B01", "S002-B01", "S003-B01"]) expect(withN3[0]!.state).toContain(id);
    // The window requests never ask about N3
    const windowRequests = s.classifier.conflicts.filter((c) => !c.keys.includes("conflict:N3"));
    expect(windowRequests.flatMap((c) => c.keys).sort()).toEqual(["conflict:N1", "conflict:N2"]);
  });

  it("a non-conflict verdict makes a gray weak-match block, kept by default", async () => {
    const s = await setup();
    await merge(s);
    const blocks = await mergedNote(s);
    const n3 = blocks.find((b) => b.noteId === "N3")!;
    expect(n3.weakMatch).toBe(true);
    expect(n3.origin).toBe("student");
    expect(n3.reviewState).toBe("kept");
    expect(blocks.filter((b) => b.weakMatch)).toHaveLength(1);
  });

  it("a conflicts verdict yields one ordinary conflict flag citing the evidence, not a weak match", async () => {
    const s = await setup();
    s.classifier.addConflictAnswers({
      "conflict:N3": { label: "conflicts", probability: 0.9, evidenceIds: ["S002-B01"] },
    });
    s.writingModel.setOperations([{ type: "rewrite", blockId: "N3", text: "fixed note", sourceIds: ["S002-B01"] }]);
    await merge(s);
    const blocks = await mergedNote(s);
    const n3 = blocks.find((b) => b.noteId === "N3")!;
    expect(n3.origin).toBe("conflict");
    expect(n3.weakMatch).toBe(false);
    expect(n3.reviewState).toBe("unresolved");
    expect(n3.proposedRewrite).toBe("fixed note");
    expect(n3.citations.map((c) => c.sourceId)).toEqual(["S002-B01"]);
    expect(n3.windowId).toBeNull();
  });

  it("a failing request pauses the merge and retry re-sends only that request", async () => {
    const s = await setup();
    // Window conflict requests (W001, W003) succeed; the weak-match request fails every attempt
    s.classifier.scheduleConflictCall(null);
    s.classifier.scheduleConflictCall(null);
    for (let i = 0; i < 3; i++) s.classifier.scheduleConflictCall({ statusCode: 429, retryAfterMs: 1 });
    const run = await merge(s);
    expect(run.state).toBe("paused");
    expect(run.failedWindowIds).toHaveLength(1);

    s.classifier.conflicts = [];
    const retry = await fetch(`${base(s)}/merge/retry`, { method: "POST" });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { mergeRun: MergeRun }).mergeRun.state).toBe("done");
    expect(s.classifier.conflicts.map((c) => c.keys)).toEqual([["conflict:N3"]]);
    expect((await mergedNote(s)).find((b) => b.noteId === "N3")!.weakMatch).toBe(true);
  });
});

describe("weak matches: review state", () => {
  it("deleted removes the block from the final note, kept restores it, and state survives reload", async () => {
    const s = await setup();
    await merge(s);
    const n3 = (await mergedNote(s)).find((b) => b.noteId === "N3")!;
    const finalTexts = async (): Promise<string[]> =>
      ((await (await fetch(`${base(s)}/final-note`)).json()) as { blocks: Array<{ text: string }> }).blocks.map((b) => b.text);

    expect(await finalTexts()).toContain("stray note about topic one");

    expect((await patch(s, n3.id, { reviewState: "deleted" })).status).toBe(200);
    expect((await mergedNote(s)).find((b) => b.noteId === "N3")!.reviewState).toBe("deleted");
    expect(await finalTexts()).not.toContain("stray note about topic one");

    expect((await patch(s, n3.id, { reviewState: "kept" })).status).toBe(200);
    expect(await finalTexts()).toContain("stray note about topic one");
  });

  it("rejects deleted on non-weak blocks and conflict states on weak blocks", async () => {
    const s = await setup();
    await merge(s);
    const blocks = await mergedNote(s);
    const n1 = blocks.find((b) => b.noteId === "N1")!;
    const n3 = blocks.find((b) => b.noteId === "N3")!;
    expect((await patch(s, n1.id, { reviewState: "deleted" })).status).toBe(400);
    expect((await patch(s, n3.id, { reviewState: "reverted" })).status).toBe(400);
  });

  it("weak matches never block export", async () => {
    const s = await setup();
    await merge(s);
    expect((await fetch(`${base(s)}/final-note`)).status).toBe(200);
  });
});

