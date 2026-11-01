import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync } from "fs";
import path from "path";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import { evaluateAlignment, formatReport } from "../../src/server/alignmentEvaluation.js";
import type { AlignmentExport, AlignedWindow, Lecture, MergedBlock, WeakMatch } from "../../src/shared/types.js";
import type { WritingModelProvider } from "../../src/providers/interfaces.js";
import { FakeEmbeddingProvider, FakeWritingModel, ScriptedClassifier } from "../../src/providers/fakes.js";
import type { ExtractedSlide } from "../../src/server/pdfExtraction.js";
import { ensureDefaultUser, createSubject, sealLecture, createAudioFile, createAudioChunk, createSentence } from "../../src/server/db.js";

let server: TestServer | undefined;
afterEach(() => server?.close());

const SEC = 1000;

class RecordingClassifier extends ScriptedClassifier {
  coverage: Array<{ state: string; keys: string[] }> = [];
  conflicts: Array<{ state: string; keys: string[] }> = [];
  override async classifyCoverage(state: string, questions: Parameters<ScriptedClassifier["classifyCoverage"]>[1]) {
    this.coverage.push({ state, keys: questions.map((q) => q.key) });
    return super.classifyCoverage(state, questions);
  }
  override async checkConflicts(state: string, questions: Parameters<ScriptedClassifier["checkConflicts"]>[1]) {
    this.conflicts.push({ state, keys: questions.map((q) => q.key) });
    return super.checkConflicts(state, questions);
  }
}

class RecordingWritingModel extends FakeWritingModel {
  inputs: Array<Parameters<WritingModelProvider["generateOperations"]>[0]> = [];
  override async generateOperations(input: Parameters<WritingModelProvider["generateOperations"]>[0]) {
    this.inputs.push(input);
    return super.generateOperations(input);
  }
}

const axis = (i: number, extra: Record<number, number> = {}): number[] => {
  const v = new Array(6).fill(0);
  v[i] = 1;
  for (const [k, x] of Object.entries(extra)) v[Number(k)] = x;
  return v;
};

type Note = { id: string; text: string; type?: string; level?: number };

interface Setup {
  lecture: Lecture;
  url: string;
  embeddings: FakeEmbeddingProvider;
  classifier: RecordingClassifier;
  writingModel: RecordingWritingModel;
}

// An untimed lecture seeded directly (notes, slides, sentences), sealed and ready to merge.
async function setup(opts: {
  slides?: ExtractedSlide[];
  sentences?: Array<{ id: string; startMs: number; text: string }>;
  durationMs?: number;
  notes: Note[];
  cfg?: Parameters<typeof startTestServer>[1];
}): Promise<Setup> {
  const embeddings = new FakeEmbeddingProvider(6);
  const classifier = new RecordingClassifier();
  const writingModel = new RecordingWritingModel();
  server = await startTestServer({ embeddings, classifier, writingModel }, opts.cfg);
  const url = server.url;
  const lecture = (await (
    await fetch(`${url}/api/lectures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "untimed" }),
    })
  ).json()) as Lecture;

  const notesData = {
    blocks: opts.notes.map((n) => ({
      id: n.id,
      type: n.type ?? "paragraph",
      ...(n.level ? { props: { level: n.level } } : {}),
      content: [{ type: "text", text: n.text }],
      children: [],
    })),
    meta: Object.fromEntries(opts.notes.map((n) => [n.id, {}])),
  };
  server.db.prepare("UPDATE lectures SET notes_data = ? WHERE id = ?").run(JSON.stringify(notesData), lecture.id);

  if (opts.slides) writeFileSync(path.join(lecture.dataDir, "slides.json"), JSON.stringify(opts.slides));
  if (opts.sentences) {
    createAudioFile(server.db, "af1", lecture.id, 1, "/fake/a.wav", 0, opts.durationMs ?? 0);
    createAudioChunk(server.db, "ac1", "af1", 1, "/fake/c.wav", 0, opts.durationMs ?? 0);
    for (const s of opts.sentences) {
      createSentence(server.db, {
        id: s.id,
        chunkId: "ac1",
        audioStartOffsetMs: s.startMs,
        audioEndOffsetMs: s.startMs + 2000,
        clockStartTimeMs: s.startMs,
        clockEndTimeMs: s.startMs + 2000,
        textRaw: s.text,
        text: s.text,
        avgLogprob: -0.3,
        noSpeechProb: 0.05,
        compressionRatio: 1.1,
        status: "active",
        stitchedInto: null,
        flagState: "unflagged",
        flagReasons: [],
        correctedText: null,
      });
    }
  }
  const user = ensureDefaultUser(server.db);
  const subject = createSubject(server.db, "subj-ca", "Subject", user.id);
  sealLecture(server.db, lecture.id, subject.id, opts.slides ? "/fake/slides.pdf" : null);
  return { lecture, url, embeddings, classifier, writingModel };
}

async function merge(s: Setup): Promise<void> {
  const res = await fetch(`${s.url}/api/lectures/${s.lecture.id}/merge`, { method: "POST" });
  expect(res.status).toBe(201);
}

async function alignment(s: Setup): Promise<{ windows: AlignedWindow[]; weakMatches?: WeakMatch[] }> {
  const res = await fetch(`${s.url}/api/lectures/${s.lecture.id}/alignment`);
  expect(res.status).toBe(200);
  return (await res.json()) as { windows: AlignedWindow[]; weakMatches?: WeakMatch[] };
}

const slide = (n: number, bullet = `bullet ${n}`): ExtractedSlide => ({
  id: `S00${n}`,
  title: `Slide ${n}`,
  bullets: [{ id: `S00${n}-B01`, text: bullet }],
});
const slideText = (n: number): string => `Slide ${n}\nbullet ${n}`;

// Presentation + audio: three slides, six sentences in three ~30 s spans (A: T1 T2, B: T3 T4,
// C: T5 T6). Span A is about slide 1, span B about nothing, span C about slide 3; slide 2 is
// never discussed. Notes: N1 is about slide 1, N2 about slide 3, N3 resembles slide 1 but
// comes after N2 (out of order).
async function presentationAndAudio(): Promise<Setup> {
  const s = await setup({
    slides: [slide(1), slide(2), slide(3)],
    sentences: [
      { id: "T1", startMs: 0, text: "uno" },
      { id: "T2", startMs: 10 * SEC, text: "dos" },
      { id: "T3", startMs: 35 * SEC, text: "tres" },
      { id: "T4", startMs: 45 * SEC, text: "cuatro" },
      { id: "T5", startMs: 70 * SEC, text: "cinco" },
      { id: "T6", startMs: 80 * SEC, text: "seis" },
    ],
    durationMs: 100 * SEC,
    notes: [
      { id: "N1", text: "alpha note about topic one" },
      { id: "N2", text: "gamma note about topic three" },
      { id: "N3", text: "stray note about topic one" },
    ],
  });
  const v = s.embeddings.vectors;
  v.set(slideText(1), axis(0));
  v.set("bullet 1", axis(0));
  v.set(slideText(2), axis(1));
  v.set("bullet 2", axis(1));
  v.set(slideText(3), axis(2));
  v.set("bullet 3", axis(2));
  v.set("uno dos", axis(0));
  v.set("tres cuatro", axis(3));
  v.set("cinco seis", axis(2));
  v.set("alpha note about topic one", axis(0));
  v.set("gamma note about topic three", axis(2));
  v.set("stray note about topic one", axis(0, { 3: 0.5 }));
  return s;
}

describe("content alignment: presentation + audio", () => {
  it("aligns spans to slides in order with skips on both sides; sentences are judged in the window holding their start", async () => {
    const s = await presentationAndAudio();
    await merge(s);
    const { windows } = await alignment(s);

    expect(windows.map((w) => w.id)).toEqual(["W001", "W002", "W003"]);
    expect(windows.map((w) => w.mappedSlides)).toEqual([["S001"], ["S002"], ["S003"]]);
    // Slide 2 matched no span: an empty window, still a window, placed at slide 3's start
    expect(windows.map((w) => [w.startMs, w.endMs])).toEqual([
      [0, 70 * SEC],
      [70 * SEC, 70 * SEC],
      [70 * SEC, 100 * SEC],
    ]);
    // The unmatched middle span stays with the window whose range holds its start
    expect(windows.map((w) => w.sentenceIds)).toEqual([["T1", "T2", "T3", "T4"], [], ["T5", "T6"]]);
  });

  it("places note blocks in the scripted windows; an out-of-order block is a weak match, not placed out of order", async () => {
    const s = await presentationAndAudio();
    await merge(s);
    const { windows, weakMatches } = await alignment(s);

    expect(windows.map((w) => w.blockIds)).toEqual([["N1"], [], ["N2"]]);
    expect(weakMatches).toHaveLength(1);
    const weak = weakMatches![0]!;
    expect(weak.blockId).toBe("N3");
    expect(weak.windowId).toBe("W003");
    expect(weak.similarWindowIds).toHaveLength(3);
    expect(weak.similarWindowIds[0]).toBe("W001");
    expect(weak.score).toBeCloseTo(0, 5);
  });

  it("context is the neighbouring windows; only items in the window itself are judged", async () => {
    const s = await presentationAndAudio();
    await merge(s);
    const { windows } = await alignment(s);

    expect(windows[0]!.contextSentenceIds).toEqual([]);
    expect(windows[1]!.contextSentenceIds).toEqual(["T1", "T2", "T3", "T4", "T5", "T6"]);
    expect(windows[2]!.contextSentenceIds).toEqual([]);

    // W001's coverage request judges its own sentences and sees none of W003's
    const w1 = s.classifier.coverage.find((c) => c.keys.includes("coverage:T1"))!;
    expect(w1.keys.sort()).toEqual(["coverage:S001-B01", "coverage:T1", "coverage:T2", "coverage:T3", "coverage:T4"]);
    expect(w1.state).not.toContain("cinco");
  });

  it("a weak match is not judged and is context only in its assigned window's neighbours", async () => {
    const s = await presentationAndAudio();
    await merge(s);

    // N3 only has its own weak-match request, never a question in a window's request
    const judged = s.classifier.conflicts.filter((c) => c.keys.length !== 1 || c.keys[0] !== "conflict:N3").flatMap((c) => c.keys);
    expect(judged).toContain("conflict:N1");
    expect(judged).toContain("conflict:N2");
    expect(judged).not.toContain("conflict:N3");

    // N3 is assigned to W003, so W002 (its neighbour) sees it as context; W003 does not
    const w2 = s.classifier.coverage.find((c) => c.keys.includes("coverage:S002-B01"))!;
    expect(w2.state).toContain("stray note about topic one");
    const w3 = s.classifier.coverage.find((c) => c.keys.includes("coverage:T5"))!;
    expect(w3.state).not.toContain("stray note about topic one");
  });

  it("a missing verdict in a window with no placed block yields an addition after the last placed block of the previous window", async () => {
    const s = await presentationAndAudio();
    s.classifier.addCoverageAnswers({ "coverage:S002-B01": { label: "missing", probability: 0.9 } });
    await merge(s);

    const res = await fetch(`${s.url}/api/lectures/${s.lecture.id}/merged-note`);
    const blocks = ((await res.json()) as { blocks: MergedBlock[] }).blocks;
    const order = blocks.map((b) => (b.noteId ?? b.text));
    // W002 has no placed block: its addition goes right after N1, the last placed block of W001
    expect(order).toEqual(["N1", "bullet 2", "N2", "N3"]);
    expect(blocks[1]!.windowId).toBe("W002");
    // The weak match is not placed in any window
    expect(blocks[3]!.windowId).toBeNull();
  });

  it("surfaces an embedding failure as an error and leaves no half-started merge", async () => {
    const s = await presentationAndAudio();
    s.embeddings.failWith = new Error("model missing");
    const res = await fetch(`${s.url}/api/lectures/${s.lecture.id}/merge`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("model missing");
    expect((await fetch(`${s.url}/api/lectures/${s.lecture.id}/merge`)).status).toBe(404);
  });
});

describe("content alignment: audio only", () => {
  it("cuts windows of about 4 minutes at sentence boundaries, labelled by number", async () => {
    const sentences = Array.from({ length: 11 }, (_, i) => ({ id: `T${i + 1}`, startMs: i * 70 * SEC, text: `s${i}` }));
    const s = await setup({
      sentences,
      durationMs: 800 * SEC,
      notes: [{ id: "N1", text: "some long enough note" }],
    });
    await merge(s);
    const { windows } = await alignment(s);

    const starts = new Set(sentences.map((x) => x.startMs));
    expect(windows.length).toBeGreaterThan(2);
    expect(windows.map((w) => w.id)).toEqual(windows.map((_, i) => `W00${i + 1}`));
    for (const w of windows) {
      expect(w.mappedSlides).toEqual([]);
      expect(starts.has(w.startMs!)).toBe(true);
    }
    // Tiled, ending at the lecture end
    windows.forEach((w, i) => {
      if (i > 0) expect(w.startMs).toBe(windows[i - 1]!.endMs);
    });
    expect(windows.at(-1)!.endMs).toBe(800 * SEC);
    // Each cut is the first sentence start at least 4 minutes after the previous cut
    expect(windows.map((w) => w.startMs)).toEqual([0, 280 * SEC, 560 * SEC]);
    expect(windows.flatMap((w) => w.sentenceIds)).toEqual(sentences.map((x) => x.id));
  });
});

describe("content alignment: presentation only", () => {
  it("makes one window per slide with no time range, and Haiku receives ranges without times", async () => {
    const s = await setup({
      slides: [slide(1), slide(2)],
      notes: [
        { id: "N1", text: "alpha note about topic one" },
        { id: "N2", text: "beta note about topic two" },
      ],
    });
    s.embeddings.vectors.set("bullet 1", axis(0));
    s.embeddings.vectors.set("bullet 2", axis(1));
    s.embeddings.vectors.set(slideText(1), axis(0));
    s.embeddings.vectors.set(slideText(2), axis(1));
    s.embeddings.vectors.set("alpha note about topic one", axis(0));
    s.embeddings.vectors.set("beta note about topic two", axis(1));
    s.classifier.addCoverageAnswers({ "coverage:S002-B01": { label: "missing", probability: 0.9 } });
    await merge(s);

    const { windows } = await alignment(s);
    expect(windows.map((w) => w.mappedSlides)).toEqual([["S001"], ["S002"]]);
    for (const w of windows) {
      expect(w.startMs).toBeUndefined();
      expect(w.endMs).toBeUndefined();
    }
    expect(windows.map((w) => w.blockIds)).toEqual([["N1"], ["N2"]]);
    expect(windows[0]!.contextBlockIds.sort()).toEqual(["N1", "N2"]);

    const ranges = s.writingModel.inputs[0]!.windowRanges;
    expect(ranges).toEqual([{ windowId: "W001" }, { windowId: "W002" }]);
  });
});

describe("content alignment: note block embeddings", () => {
  it("prefixes the heading path; headings and very short items follow neighbours and are never weak", async () => {
    const s = await setup({
      slides: [slide(1), slide(2)],
      notes: [
        { id: "H1", text: "Cardiología", type: "heading", level: 1 },
        { id: "H2", text: "Insuficiencia cardíaca", type: "heading", level: 2 },
        { id: "N1", text: "tto: IECA y diuréticos" },
        { id: "H3", text: "Arritmias", type: "heading", level: 2 },
        { id: "N2", text: "fibrilación auricular" },
        { id: "N3", text: "ok" },
      ],
    });
    const v = s.embeddings.vectors;
    v.set("bullet 1", axis(0));
    v.set("bullet 2", axis(1));
    v.set(slideText(1), axis(0));
    v.set(slideText(2), axis(1));
    v.set("Cardiología › Insuficiencia cardíaca › tto: IECA y diuréticos", axis(0));
    v.set("Cardiología › Arritmias › fibrilación auricular", axis(1));
    await merge(s);

    expect(s.embeddings.embeddedTexts).toContain("Cardiología › Insuficiencia cardíaca › tto: IECA y diuréticos");
    expect(s.embeddings.embeddedTexts).toContain("Cardiología › Arritmias › fibrilación auricular");

    const { windows, weakMatches } = await alignment(s);
    // Headings take the following block's window; the short item the preceding block's
    expect(windows[0]!.blockIds).toEqual(["H1", "H2", "N1"]);
    expect(windows[1]!.blockIds).toEqual(["H3", "N2", "N3"]);
    expect(weakMatches).toEqual([]);
  });

  it("applies abbreviations to the embedded copy and leaves the sealed notes untouched", async () => {
    const s = await setup({
      slides: [slide(1)],
      notes: [{ id: "N1", text: "el pc tiene disnea" }],
    });
    await fetch(`${s.url}/api/abbreviations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ abbreviation: "pc", expansion: "paciente" }),
    });
    await merge(s);
    expect(s.embeddings.embeddedTexts).toContain("el paciente tiene disnea");
    const lecture = (await (await fetch(`${s.url}/api/lectures/${s.lecture.id}`)).json()) as Lecture;
    expect(lecture.notesData).toContain("el pc tiene disnea");
  });
});

describe("content alignment: weak-match threshold", () => {
  it("marks a placed block whose best similarity is below the configured threshold", async () => {
    const run = async (weakMatchThreshold: number): Promise<WeakMatch[]> => {
      server?.close();
      const s = await setup({
        slides: [slide(1)],
        notes: [{ id: "N1", text: "partly related note" }],
        cfg: { contentAlignment: { weakMatchThreshold, skipFloor: 0.3 } },
      });
      s.embeddings.vectors.set("bullet 1", axis(0));
      s.embeddings.vectors.set(slideText(1), axis(0));
      // cosine 0.6 with the bullet
      s.embeddings.vectors.set("partly related note", axis(0, { 1: 4 / 3 }));
      await merge(s);
      return (await alignment(s)).weakMatches ?? [];
    };
    expect(await run(0.5)).toEqual([]);
    const weak = await run(0.7);
    expect(weak.map((w) => w.blockId)).toEqual(["N1"]);
    expect(weak[0]!.score).toBeCloseTo(0.6, 5);
    expect(weak[0]!.windowId).toBe("W001");
    expect(weak[0]!.similarWindowIds).toEqual(["W001"]);
  });
});

describe("alignment export and evaluation (calibration tool)", () => {
  it("exports every scored block with window, score and weak state, ready for labelling", async () => {
    const s = await setup({
      slides: [slide(1), slide(2)],
      notes: [
        { id: "N1", text: "note about slide one" },
        { id: "N2", text: "partly related note" },
      ],
    });
    s.embeddings.vectors.set("bullet 1", axis(0));
    s.embeddings.vectors.set(slideText(1), axis(0));
    s.embeddings.vectors.set("bullet 2", axis(2));
    s.embeddings.vectors.set(slideText(2), axis(2));
    s.embeddings.vectors.set("note about slide one", axis(0));
    s.embeddings.vectors.set("partly related note", axis(2, { 1: 4 / 3 }));
    await merge(s);
    const res = await fetch(`${s.url}/api/lectures/${s.lecture.id}/alignment/export`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AlignmentExport;
    expect(body.weakMatchThreshold).toBe(0.5);
    expect(body.windows.map((w) => w.id)).toEqual(["W001", "W002"]);
    expect(body.blocks.map((b) => [b.blockId, b.windowId, b.weak, b.correctWindowId])).toEqual([
      ["N1", "W001", false, null],
      ["N2", "W002", false, null],
    ]);
    expect(body.blocks[1]!.score).toBeCloseTo(0.6, 5);
    expect(body.blocks[1]!.text).toBe("partly related note");
  });

  it("rejects the export for live lectures", async () => {
    server = await startTestServer({});
    const lecture = (await (
      await fetch(`${server.url}/api/lectures`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    ).json()) as Lecture;
    const res = await fetch(`${server.url}/api/lectures/${lecture.id}/alignment/export`);
    expect(res.status).toBe(409);
  });

  it("reports precision and weak-match rate per threshold from labelled exports", () => {
    const block = (blockId: string, score: number, windowId: string, correctWindowId: string | null, placed = true) => ({
      blockId, text: blockId, windowId, score, placed, weak: false, correctWindowId,
    });
    const exp: AlignmentExport = {
      lectureId: "L",
      weakMatchThreshold: 0.5,
      windows: [],
      blocks: [
        block("A", 0.9, "W001", "W001"),
        block("B", 0.6, "W002", "W002"),
        block("C", 0.4, "W002", "W003"), // wrong window, low score
        block("D", 0.3, "W003", "not taught"),
        block("E", 0.8, "W004", null, false), // skipped: weak at every threshold
      ],
    };
    const r = evaluateAlignment([exp], { thresholds: [0.2, 0.5], targetPrecision: 0.95 });
    expect(r.rows[0]).toMatchObject({ threshold: 0.2, placedBlocks: 4, precision: 0.5 });
    expect(r.rows[0]!.weakMatchRate).toBeCloseTo(0.2);
    expect(r.rows[1]).toMatchObject({ threshold: 0.5, placedBlocks: 2, precision: 1 });
    expect(r.rows[1]!.weakMatchRate).toBeCloseTo(0.6);
    expect(r.recommendedThreshold).toBe(0.5);
    expect(formatReport(r)).toContain("Lowest threshold reaching 95.0% precision: 0.50");
  });
});
