import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import type { Providers } from "../providers/interfaces.js";
import type {
  AbbreviationPair,
  AudioFile,
  AudioChunk,
  NotesDocument,
  Sentence,
  WhisperSegment,
} from "../shared/types.js";
import {
  getLecture,
  listAudioFiles,
  listAudioChunks,
  listAbbreviationPairs,
  getSubject,
  updateLectureStage,
  createTranscriptRun,
  getTranscriptRunByLectureId,
  updateTranscriptRunState,
  updateAudioChunkTranscription,
  setAudioFileTranscriptionModel,
  createSentence,
} from "./db.js";
import { expandAbbreviations } from "../shared/abbreviationExpansion.js";
import { retainTerms } from "../shared/termRetention.js";
import { tokenize } from "../shared/unknownTokens.js";

// ── Mini glossary ─────────────────────────────────────────────────────────────

function extractAllBlockTexts(doc: NotesDocument): Array<{ text: string; firstEditTime: number }> {
  const result: Array<{ text: string; firstEditTime: number }> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function walkBlocks(blocks: any[]): void {
    for (const block of blocks) {
      const meta = doc.meta[block.id as string];
      if (meta?.firstEditTime !== undefined) {
        const text = extractBlockText(block);
        if (text) result.push({ text, firstEditTime: meta.firstEditTime });
      }
      if (Array.isArray(block.children) && block.children.length > 0) {
        walkBlocks(block.children as unknown[]);
      }
    }
  }

  const topBlocks = Array.isArray(doc.blocks) ? (doc.blocks as unknown[]) : [];
  walkBlocks(topBlocks as unknown[]);
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBlockText(block: any): string {
  if (!block || !Array.isArray(block.content)) return "";
  return (block.content as unknown[])
    .map((item) => {
      if (typeof item !== "object" || item === null) return "";
      const obj = item as Record<string, unknown>;
      if (obj["type"] === "text") return typeof obj["text"] === "string" ? obj["text"] : "";
      return "";
    })
    .join("");
}

export function buildChunkPrompt(
  notesDoc: NotesDocument,
  chunkClockStartMs: number,
  chunkClockEndMs: number,
  abbrevPairs: AbbreviationPair[],
  subjectGlossary: string[],
  maxWords: number = 224,
): string {
  // Collect block texts in the chunk's clock time range
  const blockTexts: string[] = [];
  const allBlocks = extractAllBlockTexts(notesDoc);
  for (const { text, firstEditTime } of allBlocks) {
    if (firstEditTime >= chunkClockStartMs && firstEditTime < chunkClockEndMs) {
      blockTexts.push(text);
    }
  }

  if (blockTexts.length === 0) {
    // Subject glossary fallback; empty string if no glossary
    if (subjectGlossary.length === 0) return "";
    return capWords(subjectGlossary, maxWords).join(" ");
  }

  // Collect candidates: both original tokens and abbreviation-expanded copies
  const candidates: string[] = [];
  for (const text of blockTexts) {
    const expanded = expandAbbreviations(text, abbrevPairs);
    candidates.push(...tokenize(text), ...tokenize(expanded));
  }

  const retained = retainTerms(candidates);
  const terms = retained.filter((r) => r.kept).map((r) => r.term);
  // Deduplicate (preserving order)
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const t of terms) {
    const key = t.toLowerCase();
    if (!seen.has(key)) { seen.add(key); deduped.push(t); }
  }

  return capWords(deduped, maxWords).join(" ");
}

function capWords(words: string[], max: number): string[] {
  const result: string[] = [];
  let count = 0;
  for (const w of words) {
    const wc = w.split(/\s+/).filter(Boolean).length;
    if (count + wc > max) break;
    result.push(w);
    count += wc;
  }
  return result;
}

// ── Sentence splitting ────────────────────────────────────────────────────────

export type RawSentence = {
  text: string;
  audioStartOffsetMs: number;
  avgLogprob: number;
  noSpeechProb: number;
  compressionRatio: number;
};

const TERMINAL_PUNCT_RE = /[.!?]\s*$/;

export function splitSegmentsIntoSentences(segments: WhisperSegment[]): RawSentence[] {
  const result: RawSentence[] = [];
  let acc: WhisperSegment[] = [];

  for (const seg of segments) {
    acc.push(seg);
    const joined = acc.map((s) => s.text).join("").trim();
    if (TERMINAL_PUNCT_RE.test(joined)) {
      result.push(makeSentence(acc, joined));
      acc = [];
    }
  }

  if (acc.length > 0) {
    const joined = acc.map((s) => s.text).join("").trim();
    if (joined) result.push(makeSentence(acc, joined));
  }

  return result;
}

function makeSentence(segs: WhisperSegment[], text: string): RawSentence {
  return {
    text,
    audioStartOffsetMs: segs[0]!.startMs,
    avgLogprob: Math.min(...segs.map((s) => s.avgLogprob)),
    noSpeechProb: Math.max(...segs.map((s) => s.noSpeechProb)),
    compressionRatio: Math.max(...segs.map((s) => s.compressionRatio)),
  };
}

// ── Sentence ID generation ────────────────────────────────────────────────────

export function makeSentenceId(fileIndex: number, sentenceNumber: number): string {
  const filePrefix = `A${String(fileIndex).padStart(2, "0")}`;
  return `${filePrefix}-T${String(sentenceNumber).padStart(4, "0")}`;
}

// ── Main transcription driver ─────────────────────────────────────────────────

export async function transcribeLecture(
  db: Database.Database,
  lectureId: string,
  providers: Providers,
  cfg: Config,
): Promise<{ transcriptRun: import("../shared/types.js").TranscriptRun }> {
  const lecture = getLecture(db, lectureId);
  if (!lecture) throw new Error("Lecture not found");
  if (lecture.stage !== "sealed") throw new Error("Lecture is not sealed");

  // Idempotent: return existing run if already running/done
  const existing = getTranscriptRunByLectureId(db, lectureId);
  if (existing) return { transcriptRun: existing };

  const model = cfg.transcriptionModel;
  const transcriptRun = createTranscriptRun(db, uuidv4(), lectureId, model);

  const notesDoc = JSON.parse(lecture.notesData) as NotesDocument;
  const abbrevPairs = listAbbreviationPairs(db);
  const subject = lecture.subjectId ? getSubject(db, lecture.subjectId) : null;
  const subjectGlossary = subject?.glossaryTerms ?? [];

  const audioFiles = listAudioFiles(db, lectureId);
  const failedChunkIds: string[] = [];

  for (const audioFile of audioFiles) {
    setAudioFileTranscriptionModel(db, audioFile.id, model);
    const chunks = listAudioChunks(db, audioFile.id);

    let sentenceCounter = 1;

    for (const chunk of chunks) {
      const chunkClockStartMs = audioFile.recordingStartMs + chunk.startOffsetMs;
      const chunkClockEndMs = chunkClockStartMs + chunk.durationMs;

      const prompt = buildChunkPrompt(
        notesDoc,
        chunkClockStartMs,
        chunkClockEndMs,
        abbrevPairs,
        subjectGlossary,
        224,
      );

      let rawResult: import("../shared/types.js").TranscriptionResult;
      try {
        rawResult = await providers.speechToText.transcribeChunk(chunk.filePath, prompt);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        updateAudioChunkTranscription(db, chunk.id, "failed", null, errMsg);
        failedChunkIds.push(chunk.id);
        continue;
      }

      const rawResponse = JSON.stringify(rawResult);
      updateAudioChunkTranscription(db, chunk.id, "done", rawResponse, null);

      const rawSentences = splitSegmentsIntoSentences(rawResult.segments);
      for (const rs of rawSentences) {
        const sentenceId = makeSentenceId(audioFile.fileIndex, sentenceCounter++);
        const sentence: Sentence = {
          id: sentenceId,
          chunkId: chunk.id,
          audioStartOffsetMs: rs.audioStartOffsetMs,
          clockStartTimeMs: audioFile.recordingStartMs + rs.audioStartOffsetMs,
          textRaw: rs.text,
          text: rs.text,
          avgLogprob: rs.avgLogprob,
          noSpeechProb: rs.noSpeechProb,
          compressionRatio: rs.compressionRatio,
          status: "active",
          stitchedInto: null,
          flagState: "unflagged",
          flagReasons: [],
          correctedText: null,
        };
        createSentence(db, sentence);
      }
    }
  }

  if (failedChunkIds.length > 0) {
    updateTranscriptRunState(db, transcriptRun.id, "paused", failedChunkIds);
  } else {
    updateTranscriptRunState(db, transcriptRun.id, "done");
    updateLectureStage(db, lectureId, "transcript-check");
  }

  return {
    transcriptRun: getTranscriptRunByLectureId(db, lectureId)!,
  };
}

export function getChunksForLecture(
  db: Database.Database,
  lectureId: string,
): Array<{ audioFile: AudioFile; chunk: AudioChunk }> {
  const audioFiles = listAudioFiles(db, lectureId);
  const result: Array<{ audioFile: AudioFile; chunk: AudioChunk }> = [];
  for (const audioFile of audioFiles) {
    const chunks = listAudioChunks(db, audioFile.id);
    for (const chunk of chunks) {
      result.push({ audioFile, chunk });
    }
  }
  return result;
}
