import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync } from "fs";
import path from "path";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture, Sentence, TranscriptRun, WhisperSegment } from "../../src/shared/types.js";
import type { TranscriptionResult } from "../../src/shared/types.js";
import { TranscriptionHttpError } from "../../src/providers/interfaces.js";
import { FakeEmbeddingProvider, ScriptedSpeechToText } from "../../src/providers/fakes.js";
import {
  ensureDefaultUser,
  createSubject,
  sealLecture,
  createAudioFile,
  createAudioChunk,
  updateSubjectGlossary,
} from "../../src/server/db.js";

let server: TestServer | undefined;
afterEach(() => server?.close());

const SEC = 1000;
const GOOD = -0.2;
const BAD = -2.5;
const seg = (startS: number, text: string, avgLogprob = GOOD): WhisperSegment => ({
  startMs: startS * SEC,
  endMs: (startS + 3) * SEC,
  text,
  avgLogprob,
  noSpeechProb: 0.01,
  compressionRatio: 1.1,
});

// Fails the second call for the given chunk paths with a non-retryable error, while armed
class FailingSecondCall extends ScriptedSpeechToText {
  armed = new Set<string>();
  private calls = new Map<string, number>();
  override async transcribeChunk(chunkPath: string, prompt: string): Promise<TranscriptionResult> {
    const n = (this.calls.get(chunkPath) ?? 0) + 1;
    this.calls.set(chunkPath, n);
    if (n >= 2 && this.armed.has(chunkPath)) {
      this.capturedPrompts.push({ chunkPath, prompt });
      throw new TranscriptionHttpError(400, "HTTP 400");
    }
    return super.transcribeChunk(chunkPath, prompt);
  }
}

const C1 = "/fake/c1.wav";
const C2 = "/fake/c2.wav";
const C3 = "/fake/c3.wav";

interface Setup {
  lecture: Lecture;
  url: string;
  stt: FailingSecondCall;
  embeddings: FakeEmbeddingProvider;
}

const block = (id: string, text: string) => ({
  id,
  type: "paragraph",
  content: [{ type: "text", text }],
  children: [],
});

// An untimed audio-only lecture seeded with three chunks: C1 [0,130 s), C2 [130,250), C3 [250,300).
// 100 s windows cut W1 [0,130), W2 [130,250), W3 [250,300) at sentence starts, so every chunk
// overlaps exactly one window. Note N1 belongs to W1, N2 to W2, N3 to W3.
async function setup(opts: { slides?: object[]; subjectGlossary?: string[] } = {}): Promise<Setup> {
  const stt = new FailingSecondCall();
  const embeddings = new FakeEmbeddingProvider(6);
  server = await startTestServer({ speechToText: stt, embeddings }, { contentAlignment: { audioWindowMs: 100 * SEC } } as never);
  const url = server.url;
  const lecture = (await (
    await fetch(`${url}/api/lectures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "untimed" }),
    })
  ).json()) as Lecture;

  const notes = [
    block("N1", "Disnea paroxística nocturna"),
    block("N2", "Edema agudo de pulmón"),
    block("N3", "Cetoacidosis diabética"),
  ];
  server.db
    .prepare("UPDATE lectures SET notes_data = ? WHERE id = ?")
    .run(JSON.stringify({ blocks: notes, meta: { N1: {}, N2: {}, N3: {} } }), lecture.id);
  if (opts.slides) writeFileSync(path.join(lecture.dataDir, "slides.json"), JSON.stringify(opts.slides));

  createAudioFile(server.db, "af1", lecture.id, 1, "/fake/a.wav", 0, 300 * SEC);
  createAudioChunk(server.db, "ac1", "af1", 1, C1, 0, 135 * SEC);
  createAudioChunk(server.db, "ac2", "af1", 2, C2, 135 * SEC, 145 * SEC);
  createAudioChunk(server.db, "ac3", "af1", 3, C3, 280 * SEC, 20 * SEC);

  const user = ensureDefaultUser(server.db);
  const subject = createSubject(server.db, "subj-tp", "Subject", user.id);
  if (opts.subjectGlossary) updateSubjectGlossary(server.db, subject.id, opts.subjectGlossary);
  sealLecture(server.db, lecture.id, subject.id, opts.slides ? "/fake/slides.pdf" : null);

  // Span texts (pass 1, after clean-up) and note blocks line up window by window
  const axis = (i: number) => Array.from({ length: 6 }, (_, k) => (k === i ? 1 : 0));
  embeddings.vectors.set("Hoy empezar clase muy importante. Todo esto como examen.", axis(0));
  embeddings.vectors.set("Ahora hasta porque pero.", axis(1));
  embeddings.vectors.set("como todos ya desde ahora.", axis(1));
  embeddings.vectors.set("Todo bueno.", axis(2));
  embeddings.vectors.set("Disnea paroxística nocturna", axis(0));
  embeddings.vectors.set("Edema agudo de pulmón", axis(1));
  embeddings.vectors.set("Cetoacidosis diabética", axis(2));

  // Pass 1: C1 and C3 have a badly scored sentence; C2 is clean (the words are common enough
  // not to look medical). C2 ends mid-sentence and C3 starts lowercase, so that boundary is
  // stitched. Sentences are numbered A01-T0001.. in this order: C1 1-2, C2 3-4, C3 5-6.
  stt.setSegmentsSequence(C1, [
    [seg(5, "Hoy empezar clase muy importante."), seg(20, "Todo esto como examen.", BAD)],
    [seg(5, "Hoy empezar clase con disnea paroxística nocturna."), seg(20, "Todo esto como examen.")],
  ]);
  stt.setSegmentsSequence(C2, [[seg(140, "Ahora hasta porque pero."), seg(200, "como todos ya")]]);
  stt.setSegmentsSequence(C3, [
    [seg(285, "desde ahora."), seg(290, "Todo bueno.", BAD)],
    [seg(285, "desde ahora con cetoacidosis."), seg(290, "Todo bueno.")],
  ]);
  return { lecture, url, stt, embeddings };
}

async function transcribe(s: Setup): Promise<{ status: number; run: TranscriptRun }> {
  const res = await fetch(`${s.url}/api/lectures/${s.lecture.id}/transcribe`, { method: "POST" });
  const body = (await res.json()) as { transcriptRun: TranscriptRun };
  return { status: res.status, run: body.transcriptRun };
}

async function sentences(s: Setup): Promise<Sentence[]> {
  const res = await fetch(`${s.url}/api/lectures/${s.lecture.id}/sentences`);
  return ((await res.json()) as { sentences: Sentence[] }).sentences;
}

const promptsFor = (s: Setup, p: string) => s.stt.capturedPrompts.filter((c) => c.chunkPath === p).map((c) => c.prompt);
const words = (prompt: string) => prompt.split(/\s+/).filter(Boolean);

describe("two-pass transcription: pass 1", () => {
  it("prompts every chunk with the same lecture glossary: slides and notes terms first, subject glossary filling leftover space, capped at 224", async () => {
    const subjectTerms = Array.from({ length: 300 }, (_, i) => `subjterm${i}`);
    const s = await setup({
      slides: [{ id: "S001", title: "Fisiopatología renal", bullets: [{ id: "S001-B01", text: "Glomerulonefritis" }] }],
      subjectGlossary: subjectTerms,
    });
    // A clean lecture: nothing is flagged, so there is no pass 2
    for (const p of [C1, C2, C3]) s.stt.setSegmentsSequence(p, [[seg(p === C1 ? 5 : p === C2 ? 140 : 285, "Hoy empezar clase.")]]);
    expect((await transcribe(s)).run.state).toBe("done");

    const prompts = [C1, C2, C3].map((p) => promptsFor(s, p));
    expect(prompts.map((p) => p.length)).toEqual([1, 1, 1]);
    const prompt = prompts[0]![0]!;
    expect(prompts[1]![0]).toBe(prompt);
    expect(prompts[2]![0]).toBe(prompt);
    expect(words(prompt).length).toBe(224);
    expect(prompt).toContain("Glomerulonefritis");
    expect(prompt).toContain("paroxística");
    expect(prompt).toContain("Cetoacidosis");
    // Lecture terms come before the subject glossary, which only fills what is left
    expect(prompt.indexOf("Glomerulonefritis")).toBeLessThan(prompt.indexOf("subjterm0"));
    expect(prompt).not.toContain("subjterm299");
    expect(s.embeddings.calls.length).toBe(0);
  });
});

describe("two-pass transcription: pass 2", () => {
  it("re-sends only chunks with a flagged sentence, once, with the glossary of their window", async () => {
    const s = await setup();
    const { run } = await transcribe(s);
    expect(run.state).toBe("done");
    expect(run.pass).toBe(2);

    expect(promptsFor(s, C1)).toHaveLength(2);
    expect(promptsFor(s, C2)).toHaveLength(1);
    expect(promptsFor(s, C3)).toHaveLength(2);

    const c1Pass2 = promptsFor(s, C1)[1]!;
    expect(c1Pass2).toContain("paroxística");
    expect(c1Pass2).not.toContain("Cetoacidosis");
    expect(c1Pass2).not.toContain("pulmón");
    // C3 overlaps the end of W2 and all of W3, so it gets both windows' terms
    const c3Pass2 = promptsFor(s, C3)[1]!;
    expect(c3Pass2).toContain("Cetoacidosis");
    expect(c3Pass2).toContain("pulmón");
    expect(c3Pass2).not.toContain("paroxística");
    // Pass 1 used the one lecture glossary for all three
    expect(promptsFor(s, C2)[0]).toBe(promptsFor(s, C1)[0]);
    expect(promptsFor(s, C3)[0]).toBe(promptsFor(s, C1)[0]);
  });

  it("retires the old sentence IDs, continues the numbering, and re-applies stitching and flagging", async () => {
    const s = await setup();
    await transcribe(s);
    const all = await sentences(s);
    const byId = new Map(all.map((x) => [x.id, x]));

    // Pass 1 numbered A01-T0001..T0006 (C1: 1-2, C2: 3-4, C3: 5-6); pass 2 continues at 7
    const c1Old = ["A01-T0001", "A01-T0002"].map((id) => byId.get(id)!);
    expect(c1Old.every((x) => x.status === "retired")).toBe(true);
    const c1New = all.filter((x) => x.chunkId === "ac1" && x.status === "active");
    expect(c1New.map((x) => x.id)).toEqual(["A01-T0007", "A01-T0008"]);
    expect(c1New[0]!.text).toBe("Hoy empezar clase con disnea paroxística nocturna.");
    const c3New = all.filter((x) => x.chunkId === "ac3" && x.status === "active");
    expect(c3New.map((x) => x.id)).toEqual(["A01-T0010"]);
    expect(new Set(all.map((x) => x.id)).size).toBe(all.length);

    // The C2/C3 boundary was stitched again exactly once, onto the unchanged C2 sentence
    const c2Last = byId.get("A01-T0004")!;
    expect(c2Last.status).toBe("active");
    expect(c2Last.text).toBe("como todos ya desde ahora con cetoacidosis.");
    const newFirst = byId.get("A01-T0009")!;
    expect(newFirst.status).toBe("retired");
    expect(newFirst.stitchedInto).toBe("A01-T0004");
    // C2's own first sentence is untouched
    expect(byId.get("A01-T0003")!.text).toBe("Ahora hasta porque pero.");

    // Nothing is flagged any more: pass 2 text scored well
    expect(all.filter((x) => x.status === "active" && x.flagState === "flagged_unhandled")).toEqual([]);
  });

  it("leaves a sentence that is still flagged after pass 2 for the transcript check, without a third pass", async () => {
    const s = await setup();
    s.stt.setSegmentsSequence(C1, [
      [seg(5, "Hoy empezar clase muy importante."), seg(20, "Todo esto como examen.", BAD)],
      [seg(5, "Hoy empezar clase muy importante."), seg(20, "Todo esto como examen.", BAD)],
    ]);
    const { run } = await transcribe(s);
    expect(run.state).toBe("done");
    expect(promptsFor(s, C1)).toHaveLength(2);
    const flagged = (await sentences(s)).filter((x) => x.status === "active" && x.flagState === "flagged_unhandled");
    expect(flagged.map((x) => x.chunkId)).toEqual(["ac1"]);
    expect(flagged[0]!.flagReasons).toContain("avg_logprob");
  });

  it("keeps the provisional alignment in memory: nothing is persisted or served", async () => {
    const s = await setup();
    await transcribe(s);
    expect(s.embeddings.calls.length).toBeGreaterThan(0);
    expect((await fetch(`${s.url}/api/lectures/${s.lecture.id}/alignment`)).status).toBe(404);
    expect(server!.db.prepare("SELECT COUNT(*) AS n FROM merge_runs").get()).toEqual({ n: 0 });
  });

  it("pauses on a pass-2 chunk failure and resumes only the missing pass-2 chunks", async () => {
    const s = await setup();
    s.stt.armed.add(C3);
    const first = await transcribe(s);
    expect(first.run.state).toBe("paused");
    expect(first.run.pass).toBe(2);
    expect(first.run.failedChunkIds).toEqual(["ac3"]);

    const status = (await (await fetch(`${s.url}/api/lectures/${s.lecture.id}/transcribe`)).json()) as {
      transcriptRun: TranscriptRun;
      failedChunks: Array<{ id: string }>;
    };
    expect(status.transcriptRun.pass).toBe(2);
    expect(status.failedChunks.map((c) => c.id)).toEqual(["ac3"]);
    expect(server!.db.prepare("SELECT stage FROM lectures WHERE id = ?").get(s.lecture.id)).toEqual({ stage: "sealed" });
    // C1 was already re-transcribed before C3 failed
    expect((await sentences(s)).some((x) => x.id === "A01-T0007" && x.status === "active")).toBe(true);

    s.stt.armed.clear();
    const second = await transcribe(s);
    expect(second.run.state).toBe("done");
    // Pass 1 was not repeated and C1 was not sent again; only C3 was retried
    expect(promptsFor(s, C1)).toHaveLength(2);
    expect(promptsFor(s, C2)).toHaveLength(1);
    expect(promptsFor(s, C3)).toHaveLength(3);
    const all = await sentences(s);
    expect(all.find((x) => x.id === "A01-T0004")!.text).toBe("como todos ya desde ahora con cetoacidosis.");
    expect(new Set(all.map((x) => x.id)).size).toBe(all.length);
  });

  it("an embedding failure in the provisional alignment is an explicit error; retrying resumes pass 2 without repeating pass 1", async () => {
    const s = await setup();
    s.embeddings.failWith = new Error("model missing");
    const res = await fetch(`${s.url}/api/lectures/${s.lecture.id}/transcribe`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("model missing");

    s.embeddings.failWith = null;
    const { run } = await transcribe(s);
    expect(run.state).toBe("done");
    expect(promptsFor(s, C2)).toHaveLength(1);
    expect(promptsFor(s, C1)).toHaveLength(2);
  });
});
