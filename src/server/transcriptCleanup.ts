import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import type { AbbreviationPair, NotesDocument, Sentence } from "../shared/types.js";
import {
  listAudioFiles,
  listAudioChunks,
  listSentencesByChunk,
  listSentencesByLecture,
  updateSentence,
  setSentenceStitchBackup,
  getAudioChunk,
  getAudioFile,
} from "./db.js";
import { expandAbbreviations } from "../shared/abbreviationExpansion.js";
import { retainTerms, isMedicalLooking } from "../shared/termRetention.js";
import { tokenize } from "../shared/unknownTokens.js";

// ── Filler regex ──────────────────────────────────────────────────────────────

export const FILLER_RE = /^\s*[¿¡]?\s*ya\s+(lo\s+ten[eé]is|est[aá]\s+copiado)\s*[?!.]?\s*$/iu;

// ── Stitching ─────────────────────────────────────────────────────────────────

const TERMINAL_PUNCT_RE = /[.!?]\s*$/;

function startsLowercase(text: string): boolean {
  const match = text.match(/[\p{L}]/u);
  if (!match) return false;
  const ch = match[0]!;
  return ch === ch.toLowerCase() && ch !== ch.toUpperCase();
}

// With onlyChunkIds, only boundaries touching one of those chunks are considered (pass 2 of
// untimed transcription); the other boundaries were stitched already and must not stitch twice.
// Returns the sentences that absorbed the start of the next chunk.
export function stitchAcrossChunkBoundaries(
  db: Database.Database,
  lectureId: string,
  onlyChunkIds?: Set<string>,
): string[] {
  const stitched: string[] = [];
  const audioFiles = listAudioFiles(db, lectureId);

  for (const audioFile of audioFiles) {
    const chunks = listAudioChunks(db, audioFile.id);

    for (let i = 0; i < chunks.length - 1; i++) {
      const currChunk = chunks[i]!;
      const nextChunk = chunks[i + 1]!;
      if (onlyChunkIds && !onlyChunkIds.has(currChunk.id) && !onlyChunkIds.has(nextChunk.id)) continue;

      const currSentences = listSentencesByChunk(db, currChunk.id).filter((s) => s.status === "active");
      const nextSentences = listSentencesByChunk(db, nextChunk.id).filter((s) => s.status === "active");

      if (currSentences.length === 0 || nextSentences.length === 0) continue;

      const lastSent = currSentences[currSentences.length - 1]!;
      const firstSent = nextSentences[0]!;

      if (!TERMINAL_PUNCT_RE.test(lastSent.text) && startsLowercase(firstSent.text)) {
        const stitchedText = (lastSent.text + " " + firstSent.text).replace(/\s+/g, " ").trim();
        setSentenceStitchBackup(db, lectureId, lastSent.id, {
          text: lastSent.text,
          avgLogprob: lastSent.avgLogprob,
          noSpeechProb: lastSent.noSpeechProb,
          compressionRatio: lastSent.compressionRatio,
          audioEndOffsetMs: lastSent.audioEndOffsetMs,
          clockEndTimeMs: lastSent.clockEndTimeMs,
        });
        updateSentence(db, lectureId, lastSent.id, {
          text: stitchedText,
          avgLogprob: Math.min(lastSent.avgLogprob, firstSent.avgLogprob),
          noSpeechProb: Math.max(lastSent.noSpeechProb, firstSent.noSpeechProb),
          compressionRatio: Math.max(lastSent.compressionRatio, firstSent.compressionRatio),
          audioEndOffsetMs: firstSent.audioEndOffsetMs,
          clockEndTimeMs: firstSent.clockEndTimeMs,
        });
        updateSentence(db, lectureId, firstSent.id, {
          status: "retired",
          stitchedInto: lastSent.id,
        });
        stitched.push(lastSent.id);
      }
    }
  }
  return stitched;
}

// ── Filler removal ────────────────────────────────────────────────────────────

export function removeFillerSentences(
  db: Database.Database,
  lectureId: string,
): void {
  const sentences = listSentencesByLecture(db, lectureId).filter((s) => s.status === "active");
  for (const sent of sentences) {
    if (FILLER_RE.test(sent.text)) {
      updateSentence(db, lectureId, sent.id, {
        status: "retired",
        flagReasons: ["filler"],
      });
    }
  }
}

// ── Known-terms set for a chunk ───────────────────────────────────────────────

function extractBlockTextsInRange(
  notesDoc: NotesDocument,
  clockStartMs: number,
  clockEndMs: number,
): string[] {
  const result: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function walkBlocks(blocks: any[]): void {
    for (const block of blocks) {
      const meta = notesDoc.meta[block.id as string];
      if (meta?.firstEditTime !== undefined) {
        if (meta.firstEditTime >= clockStartMs && meta.firstEditTime < clockEndMs) {
          const text = extractBlockText(block);
          if (text) result.push(text);
        }
      }
      if (Array.isArray(block.children) && block.children.length > 0) {
        walkBlocks(block.children as unknown[]);
      }
    }
  }

  const topBlocks = Array.isArray(notesDoc.blocks) ? (notesDoc.blocks as unknown[]) : [];
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

function buildKnownTermsForChunk(
  notesDoc: NotesDocument,
  chunkClockStartMs: number,
  chunkClockEndMs: number,
  abbrevPairs: AbbreviationPair[],
  subjectGlossary: string[],
): Set<string> {
  const known = new Set<string>();

  // Mini glossary terms: retained terms from notes in chunk's time range
  const blockTexts = extractBlockTextsInRange(notesDoc, chunkClockStartMs, chunkClockEndMs);
  const candidates: string[] = [];
  for (const text of blockTexts) {
    const expanded = expandAbbreviations(text, abbrevPairs);
    candidates.push(...tokenize(text), ...tokenize(expanded));
  }

  if (candidates.length > 0) {
    const retained = retainTerms(candidates).filter((r) => r.kept).map((r) => r.term);
    for (const t of retained) known.add(t.toLowerCase());
  } else {
    // Subject glossary fallback (same logic as mini glossary prompt)
    for (const t of subjectGlossary) known.add(t.toLowerCase());
  }

  // Abbreviation dictionary: keys and expansions
  for (const pair of abbrevPairs) {
    known.add(pair.abbreviation.toLowerCase());
    for (const tok of tokenize(pair.expansion)) {
      known.add(tok.toLowerCase());
    }
  }

  return known;
}

function hasMedicalTermAbsentFromGlossary(
  text: string,
  knownTerms: Set<string>,
): boolean {
  const tokens = tokenize(text);
  for (const token of tokens) {
    if (isMedicalLooking(token) && !knownTerms.has(token.toLowerCase())) {
      return true;
    }
  }
  return false;
}

// ── Flagging ──────────────────────────────────────────────────────────────────

// Untimed notes have no per-chunk notes in a time range, so the caller supplies each chunk's
// known terms (lecture glossary in pass 1, window mini glossary in pass 2). sentenceIds limits
// flagging to a subset of the lecture's sentences.
export type FlagScope = {
  sentenceIds?: Set<string>;
  knownTermsForChunk?: (chunkId: string) => Set<string> | undefined;
};

export function flagSentences(
  db: Database.Database,
  lectureId: string,
  notesDoc: NotesDocument,
  abbrevPairs: AbbreviationPair[],
  subjectGlossary: string[],
  thresholds: Config["thresholds"],
  scope: FlagScope = {},
): void {
  const sentences = listSentencesByLecture(db, lectureId).filter(
    (s) => s.status === "active" && (!scope.sentenceIds || scope.sentenceIds.has(s.id)),
  );

  for (const sent of sentences) {
    const chunk = getAudioChunk(db, sent.chunkId);
    const audioFile = chunk ? getAudioFile(db, chunk.audioFileId) : undefined;

    let knownTerms: Set<string> = new Set();
    const supplied = scope.knownTermsForChunk?.(sent.chunkId);
    if (supplied) {
      knownTerms = supplied;
    } else if (chunk && audioFile) {
      const clockStart = audioFile.recordingStartMs + chunk.startOffsetMs;
      const clockEnd = clockStart + chunk.durationMs;
      knownTerms = buildKnownTermsForChunk(notesDoc, clockStart, clockEnd, abbrevPairs, subjectGlossary);
    }

    const reasons: string[] = [];
    if (sent.avgLogprob < thresholds.whisperAvgLogprob) reasons.push("avg_logprob");
    if (sent.noSpeechProb > thresholds.whisperNoSpeechProb) reasons.push("no_speech_prob");
    if (sent.compressionRatio > thresholds.whisperCompressionRatio) reasons.push("compression_ratio");
    if (hasMedicalTermAbsentFromGlossary(sent.text, knownTerms)) reasons.push("unrecognized_medical_term");

    if (reasons.length > 0) {
      updateSentence(db, lectureId, sent.id, {
        flagState: "flagged_unhandled",
        flagReasons: reasons,
      });
    }
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function postProcessTranscript(
  db: Database.Database,
  lectureId: string,
  notesDoc: NotesDocument,
  abbrevPairs: AbbreviationPair[],
  subjectGlossary: string[],
  thresholds: Config["thresholds"],
  scope: FlagScope = {},
): void {
  stitchAcrossChunkBoundaries(db, lectureId);
  removeFillerSentences(db, lectureId);
  flagSentences(db, lectureId, notesDoc, abbrevPairs, subjectGlossary, thresholds, scope);
}
