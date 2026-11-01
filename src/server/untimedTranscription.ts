import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import type { AbbreviationPair, AlignedWindow, NotesDocument, Sentence } from "../shared/types.js";
import type { ExtractedSlide } from "./pdfExtraction.js";
import {
  listAudioFiles,
  listAudioChunks,
  listSentencesByChunk,
  listSentencesByLecture,
  listSentencesStitchedInto,
  getSentenceStitchBackup,
  setSentenceStitchBackup,
  updateSentence,
} from "./db.js";
import { blockText } from "./contentAlignment.js";
import {
  stitchAcrossChunkBoundaries,
  removeFillerSentences,
  flagSentences,
} from "./transcriptCleanup.js";
import { expandAbbreviations } from "../shared/abbreviationExpansion.js";
import { retainTerms } from "../shared/termRetention.js";
import { tokenize } from "../shared/unknownTokens.js";

// Two-pass transcription for untimed notes (ADR 0001, decision 7). Untimed notes have no note
// clock, so pass 1 prompts every chunk with one lecture glossary and pass 2 re-transcribes only
// the flagged chunks with the mini glossary of the window(s) they overlap.

export const PROMPT_WORD_CAP = 224;

export function capTerms(words: string[], max: number = PROMPT_WORD_CAP): string[] {
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

function dedupe(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of terms) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

// Retained terms of the given texts (original and abbreviation-expanded), rare ones first.
export function rankedTerms(texts: string[], abbrevPairs: AbbreviationPair[]): string[] {
  const candidates: string[] = [];
  for (const text of texts) {
    candidates.push(...tokenize(text), ...tokenize(expandAbbreviations(text, abbrevPairs)));
  }
  const kept = retainTerms(candidates).filter((r) => r.kept);
  const rare = kept.filter((r) => r.signals.includes("rarity"));
  const rest = kept.filter((r) => !r.signals.includes("rarity"));
  return dedupe([...rare, ...rest].map((r) => r.term));
}

export function slideTexts(slides: ExtractedSlide[]): string[] {
  return slides.map((s) => [s.title, ...s.bullets.map((b) => b.text)].filter(Boolean).join(" "));
}

export function topLevelBlockTexts(doc: NotesDocument): Map<string, string> {
  const blocks = Array.isArray(doc.blocks) ? (doc.blocks as Array<{ id: string }>) : [];
  return new Map(blocks.map((b) => [b.id, blockText(b)]));
}

// Terms a chunk's sentences are checked against when flagging, mirroring the live-notes rule:
// the glossary terms plus the abbreviation dictionary.
export function knownTermSet(terms: string[], abbrevPairs: AbbreviationPair[]): Set<string> {
  const known = new Set<string>();
  for (const t of terms) known.add(t.toLowerCase());
  for (const pair of abbrevPairs) {
    known.add(pair.abbreviation.toLowerCase());
    for (const tok of tokenize(pair.expansion)) known.add(tok.toLowerCase());
  }
  return known;
}

export type Glossary = { prompt: string; known: Set<string> };

// Pass 1: one glossary for the whole lecture. Subject glossary terms only fill leftover space.
export function buildLectureGlossary(
  slides: ExtractedSlide[],
  notesDoc: NotesDocument,
  abbrevPairs: AbbreviationPair[],
  subjectGlossary: string[],
): Glossary {
  const lectureTerms = rankedTerms([...slideTexts(slides), ...topLevelBlockTexts(notesDoc).values()], abbrevPairs);
  const prompt = capTerms(dedupe([...lectureTerms, ...subjectGlossary]));
  return { prompt: prompt.join(" "), known: knownTermSet([...lectureTerms, ...prompt], abbrevPairs) };
}

// Pass 2: the mini glossary of the windows a chunk's audio range overlaps. A chunk that
// overlaps no window with notes falls back to the subject glossary, as live notes do.
export function buildChunkGlossary(
  chunkStartMs: number,
  chunkEndMs: number,
  windows: AlignedWindow[],
  blockTexts: Map<string, string>,
  abbrevPairs: AbbreviationPair[],
  subjectGlossary: string[],
): Glossary {
  const overlapping = windows.filter(
    (w) => w.startMs !== undefined && w.endMs !== undefined && w.endMs > w.startMs && w.startMs < chunkEndMs && w.endMs > chunkStartMs,
  );
  const texts = overlapping.flatMap((w) => w.blockIds.map((id) => blockTexts.get(id) ?? "").filter(Boolean));
  const terms = rankedTerms(texts, abbrevPairs);
  if (terms.length === 0) {
    const fallback = capTerms(subjectGlossary);
    return { prompt: fallback.join(" "), known: knownTermSet(subjectGlossary, abbrevPairs) };
  }
  return { prompt: capTerms(terms).join(" "), known: knownTermSet(terms, abbrevPairs) };
}

// ── Replacing a chunk's sentences ─────────────────────────────────────────────

// Retire a chunk's pass-1 sentences ahead of its new ones. Stitches across the chunk's
// boundaries are undone so they can be applied again to the new sentences: the previous chunk's
// last sentence gets back the text it had before absorbing this chunk's first sentence, and the
// next chunk's first sentence, absorbed by this chunk's last, becomes active again.
export function retireChunkSentences(db: Database.Database, chunkId: string): void {
  const old = listSentencesByChunk(db, chunkId);
  for (const s of old) {
    if (s.stitchedInto === null) continue;
    const backup = getSentenceStitchBackup(db, s.stitchedInto);
    if (backup) {
      updateSentence(db, s.stitchedInto, { ...backup, flagState: "unflagged", flagReasons: [] });
      setSentenceStitchBackup(db, s.stitchedInto, null);
    }
    updateSentence(db, s.id, { stitchedInto: null });
  }
  for (const victim of listSentencesStitchedInto(db, old.map((s) => s.id))) {
    updateSentence(db, victim.id, { status: "active", stitchedInto: null });
  }
  for (const s of old) {
    if (s.status === "active") updateSentence(db, s.id, { status: "retired" });
  }
}

// Clean-up after the last pass-2 chunk: stitching, filler removal and flagging run again, but
// only where pass 2 changed something (the re-transcribed chunks and the sentences next to
// them), so pass-1 sentences elsewhere are never stitched or flagged a second time.
export function finishPass2(
  db: Database.Database,
  lectureId: string,
  retranscribed: Set<string>,
  notesDoc: NotesDocument,
  abbrevPairs: AbbreviationPair[],
  subjectGlossary: string[],
  thresholds: Config["thresholds"],
  knownTermsForChunk: (chunkId: string) => Set<string> | undefined,
): void {
  stitchAcrossChunkBoundaries(db, lectureId, retranscribed);
  removeFillerSentences(db, lectureId);

  const targets = new Set<string>();
  const active = (chunkId: string): Sentence[] => listSentencesByChunk(db, chunkId).filter((s) => s.status === "active");
  for (const audioFile of listAudioFiles(db, lectureId)) {
    const chunks = listAudioChunks(db, audioFile.id);
    chunks.forEach((chunk, i) => {
      if (!retranscribed.has(chunk.id)) return;
      for (const s of active(chunk.id)) targets.add(s.id);
      const prev = i > 0 ? active(chunks[i - 1]!.id) : [];
      const next = i + 1 < chunks.length ? active(chunks[i + 1]!.id) : [];
      if (prev.length > 0) targets.add(prev[prev.length - 1]!.id);
      if (next.length > 0) targets.add(next[0]!.id);
    });
  }
  for (const s of listSentencesByLecture(db, lectureId)) {
    if (targets.has(s.id)) updateSentence(db, s.id, { flagState: "unflagged", flagReasons: [] });
  }
  flagSentences(db, lectureId, notesDoc, abbrevPairs, subjectGlossary, thresholds, {
    sentenceIds: targets,
    knownTermsForChunk,
  });
}
