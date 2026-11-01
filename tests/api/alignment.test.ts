import { describe, it, expect, afterEach } from "vitest";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { AlignedWindow, Lecture, MergeRun } from "../../src/shared/types.js";
import { ScriptedClassifier, FailableClassifier } from "../../src/providers/fakes.js";
import {
  ensureDefaultUser,
  createSubject,
  sealLecture,
  createAudioFile,
  createAudioChunk,
  createSentence,
  createMarker,
} from "../../src/server/db.js";

const MIN = 60 * 1000;

let server: TestServer | undefined;
afterEach(() => server?.close());

type CoverageCall = { state: string; keys: string[] };
type ConflictCall = { state: string; keys: string[] };

class RecordingClassifier extends FailableClassifier {
  coverageCalls: CoverageCall[] = [];
  conflictCalls: ConflictCall[] = [];

  override async classifyCoverage(state: string, questions: Parameters<ScriptedClassifier["classifyCoverage"]>[1]) {
    this.coverageCalls.push({ state, keys: questions.map((q) => q.key) });
    return super.classifyCoverage(state, questions);
  }

  override async checkConflicts(state: string, questions: Parameters<ScriptedClassifier["checkConflicts"]>[1]) {
    this.conflictCalls.push({ state, keys: questions.map((q) => q.key) });
    return super.checkConflicts(state, questions);
  }
}

function addSentence(srv: TestServer, lectureId: string, id: string, clockStartTimeMs: number): void {
  createAudioFile(srv.db, `af-${id}`, lectureId, 1, "/fake/audio.wav", clockStartTimeMs - 1000, 120000);
  createAudioChunk(srv.db, `ac-${id}`, `af-${id}`, 1, "/fake/chunk.wav", 0, 120000);
  createSentence(srv.db, {
    id,
    chunkId: `ac-${id}`,
    audioStartOffsetMs: 0,
    audioEndOffsetMs: 2000,
    clockStartTimeMs,
    clockEndTimeMs: clockStartTimeMs + 2000,
    textRaw: `Sentence ${id}`,
    text: `Sentence ${id}`,
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

// A live-notes lecture with two markers, audio sentences on both sides of each boundary, and
// the last two windows merged by hand (a manual window override).
async function setup(classifier: RecordingClassifier): Promise<{ lecture: Lecture; url: string }> {
  server = await startTestServer({ classifier });
  const url = server.url;
  const t = Date.now();
  const lecture = (await (await fetch(`${url}/api/lectures`, { method: "POST" })).json()) as Lecture;

  const blocks = [
    ["B01", 0, "alpha note"],
    ["B02", 1.5 * MIN, "bravo note"],
    ["B03", 2.5 * MIN, "charlie note"],
    ["B04", 4.5 * MIN, "delta note"],
    ["B05", 0.5 * MIN, ""],
  ] as const;
  const notes = {
    blocks: blocks.map(([id, , text]) => ({
      id,
      type: "paragraph",
      content: text ? [{ type: "text", text }] : [],
      children: [],
    })),
    meta: Object.fromEntries(
      blocks.map(([id, offset]) => [id, { firstEditTime: t + offset, lastEditTime: t + offset + 6 * MIN }]),
    ),
  };
  await fetch(`${url}/api/lectures/${lecture.id}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesData: JSON.stringify(notes) }),
  });

  const user = ensureDefaultUser(server.db);
  const subject = createSubject(server.db, "subj-align", "Test Subject", user.id);
  sealLecture(server.db, lecture.id, subject.id, null);

  createMarker(server.db, "M1", lecture.id, t + 2 * MIN, "B02");
  createMarker(server.db, "M2", lecture.id, t + 4 * MIN, "B03");
  // W001 = [t, t+2m), W002 = [t+2m, t+4m), W003 = [t+4m, end)
  addSentence(server, lecture.id, "T1", t + 0.2 * MIN);
  addSentence(server, lecture.id, "T2", t + 1.5 * MIN); // W001, in W002's margin
  addSentence(server, lecture.id, "T3", t + 2.5 * MIN); // W002
  addSentence(server, lecture.id, "T4", t + 3.5 * MIN); // W002, in W003's margin
  addSentence(server, lecture.id, "T5", t + 4.5 * MIN); // W003
  addSentence(server, lecture.id, "T6", t + 9.5 * MIN); // W003, far from every margin

  // Manual override: merge W002 and W003
  const merged = await fetch(`${url}/api/lectures/${lecture.id}/windows/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ windowIds: ["W002", "W003"] }),
  });
  expect(merged.status).toBe(200);
  return { lecture, url };
}

async function getAlignment(url: string, lectureId: string): Promise<AlignedWindow[]> {
  const res = await fetch(`${url}/api/lectures/${lectureId}/alignment`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { windows: AlignedWindow[] }).windows;
}

describe("Aligned stage (time alignment for live notes)", () => {
  it("persists windows as ID lists that match what the classifier is sent", async () => {
    const classifier = new RecordingClassifier();
    const { lecture, url } = await setup(classifier);

    const before = await fetch(`${url}/api/lectures/${lecture.id}/alignment`);
    expect(before.status).toBe(404);

    const res = await fetch(`${url}/api/lectures/${lecture.id}/merge`, { method: "POST" });
    expect(res.status).toBe(201);

    const windows = await getAlignment(url, lecture.id);
    expect(windows.map((w) => w.id)).toEqual(["W001", "W002"]);
    for (const w of windows) {
      expect(w.startMs).toBeTypeOf("number");
      expect(w.endMs).toBeTypeOf("number");
    }
    const [w1, w2] = windows as [AlignedWindow, AlignedWindow];

    expect(w1.sentenceIds).toEqual(["T1", "T2"]);
    expect(w1.contextSentenceIds).toEqual(["T3"]);
    expect(w1.blockIds.sort()).toEqual(["B01", "B02", "B05"]);
    expect(w1.contextBlockIds.sort()).toEqual(["B01", "B02", "B03", "B05"]);

    expect(w2.sentenceIds).toEqual(["T3", "T4", "T5", "T6"]);
    expect(w2.contextSentenceIds).toEqual(["T2"]);
    expect(w2.blockIds.sort()).toEqual(["B03", "B04"]);
    expect(w2.contextBlockIds.sort()).toEqual(["B02", "B03", "B04"]);

    // Each window's classifier requests carry exactly the persisted IDs
    for (const w of windows) {
      const coverage = classifier.coverageCalls.find((c) =>
        w.sentenceIds.every((id) => c.keys.includes(`coverage:${id}`)),
      );
      expect(coverage?.keys.sort()).toEqual(w.sentenceIds.map((id) => `coverage:${id}`).sort());
      for (const id of w.contextSentenceIds) expect(coverage?.state).toContain(`${id}: Sentence ${id}`);
      const notesContext = coverage!.state.split("Transcript context:")[0]!;
      const texts: Record<string, string> = { B01: "alpha", B02: "bravo", B03: "charlie", B04: "delta" };
      for (const [id, text] of Object.entries(texts)) {
        expect(notesContext.includes(text)).toBe(w.contextBlockIds.includes(id));
      }

      // Empty-text B05 is never sent to the classifier
      const conflict = classifier.conflictCalls.find((c) =>
        w.blockIds.some((id) => c.keys.includes(`conflict:${id}`)),
      );
      expect(conflict?.keys.sort()).toEqual(
        w.blockIds.filter((id) => id !== "B05").map((id) => `conflict:${id}`).sort(),
      );
    }
  });

  it("a retried paused merge uses the persisted alignment", async () => {
    const classifier = new RecordingClassifier();
    const { lecture, url } = await setup(classifier);
    for (let i = 0; i < 6; i++) classifier.scheduleCoverageCall({ statusCode: 429, retryAfterMs: 1 });

    const first = await fetch(`${url}/api/lectures/${lecture.id}/merge`, { method: "POST" });
    expect(((await first.json()) as { mergeRun: MergeRun }).mergeRun.state).toBe("paused");
    const persisted = await getAlignment(url, lecture.id);

    // Changing the windows after the merge started must not affect the retry: the alignment
    // is read back, not recomputed.
    server!.db.prepare("UPDATE lectures SET window_overrides = NULL WHERE id = ?").run(lecture.id);
    createMarker(server!.db, "M3", lecture.id, Date.now() + 5 * MIN, "B04");

    classifier.coverageCalls = [];
    const retry = await fetch(`${url}/api/lectures/${lecture.id}/merge/retry`, { method: "POST" });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { mergeRun: MergeRun }).mergeRun.state).toBe("done");

    expect(await getAlignment(url, lecture.id)).toEqual(persisted);
    // The retried requests carry exactly the persisted windows' sentences
    const retried = classifier.coverageCalls.map((c) => c.keys.sort());
    expect(retried.length).toBeGreaterThan(0);
    for (const keys of retried) {
      expect(persisted.some((w) => keys.join() === w.sentenceIds.map((id) => `coverage:${id}`).sort().join())).toBe(true);
    }
  });
});
