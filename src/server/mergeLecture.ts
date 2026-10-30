import { readFileSync, existsSync } from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import type { Providers } from "../providers/interfaces.js";
import { ClassifierRetryableError } from "../providers/interfaces.js";
import type {
  Citation,
  MergeRun,
  MergedBlock,
  NotesDocument,
  Sentence,
  SlideWindow,
  WindowResult,
  WritingOperation,
} from "../shared/types.js";
import {
  createEditListEntry,
  createMergeRun,
  createMergedBlock,
  createOperation,
  createWindowResult,
  getLecture,
  getMergeRunByLectureId,
  getWindowResultsByMergeRunId,
  getWindowResultByWindowId,
  listAbbreviationPairs,
  listEditListEntries,
  listSentencesByLecture,
  saveVerdicts,
  updateLectureStage,
  updateMergeRunState,
  updateWindowResultCoverage,
  updateWindowResultConflict,
} from "./db.js";
import { resolveWindows } from "./lectureWindows.js";
import { expandAbbreviations } from "../shared/abbreviationExpansion.js";
import type { ExtractedSlide, SlideBullet } from "./pdfExtraction.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryClassifierCall<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ClassifierRetryableError && attempt < maxAttempts - 1) {
        const delay = err.retryAfterMs > 0 ? err.retryAfterMs : baseDelayMs * 2 ** attempt;
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
  throw new Error("unreachable");
}

function blockText(block: unknown): string {
  const b = block as { content?: unknown; children?: unknown[] };
  const parts: string[] = [];
  if (Array.isArray(b.content)) {
    for (const item of b.content) {
      const it = item as { type?: string; text?: string };
      if (it.type === "text" && typeof it.text === "string") parts.push(it.text);
    }
  }
  if (Array.isArray(b.children)) {
    for (const child of b.children) {
      parts.push(blockText(child));
    }
  }
  return parts.join(" ").trim();
}

function blockId(block: unknown): string {
  return (block as { id: string }).id;
}

function sentenceText(s: Sentence): string {
  return s.correctedText ?? s.text;
}

// Resolve cited source IDs to their texts with a slide/transcript label
function poolItemsFor(
  sourceIds: string[],
  slideMap: Map<string, ExtractedSlide>,
  sentenceMap: Map<string, Sentence>,
): Array<{ id: string; text: string; label: "slide" | "transcript" }> {
  const items: Array<{ id: string; text: string; label: "slide" | "transcript" }> = [];
  for (const id of sourceIds) {
    const sentence = sentenceMap.get(id);
    if (sentence) {
      items.push({ id, text: sentenceText(sentence), label: "transcript" });
      continue;
    }
    for (const slide of slideMap.values()) {
      const bullet = slide.bullets.find((b) => b.id === id);
      if (bullet) {
        items.push({ id, text: bullet.text, label: "slide" });
        break;
      }
    }
  }
  return items;
}

// Find which window a block belongs to (firstEditTime in [startMs, endMs))
function findWindowForBlock(
  firstEditTime: number,
  windows: SlideWindow[],
): SlideWindow | undefined {
  let result: SlideWindow | undefined;
  for (const w of windows) {
    if (w.startMs <= firstEditTime) result = w;
    else break;
  }
  return result;
}

// Find insertion position after last student block in a window
function insertionPositionForWindow(
  windowId: string,
  mergedList: Array<{ origin: string; windowId: string | null; originalPos: number }>,
  windows: SlideWindow[],
): number {
  const winIdx = windows.findIndex((w) => w.id === windowId);

  let lastIdx = -1;
  for (let i = 0; i < mergedList.length; i++) {
    const item = mergedList[i]!;
    if (item.origin === "student" && item.windowId === windowId) {
      lastIdx = i;
    }
  }

  if (lastIdx !== -1) return lastIdx;

  for (let wi = winIdx - 1; wi >= 0; wi--) {
    const prevWindowId = windows[wi]!.id;
    for (let i = mergedList.length - 1; i >= 0; i--) {
      const item = mergedList[i]!;
      if (item.origin === "student" && item.windowId === prevWindowId) {
        return i;
      }
    }
  }

  return -1;
}

type MergedListItem = {
  id: string;
  origin: string;
  windowId: string | null;
  noteId: string | null;
  text: string;
  originalText: string | null;
  proposedRewrite: string | null;
  citations: Citation[];
  modelPlaced: boolean;
  reviewState: string | null;
  originalPos: number;
};

async function runHaikuAndBuildNote(
  db: Database.Database,
  mergeRun: MergeRun,
  lectureId: string,
  windows: SlideWindow[],
  slideMap: Map<string, ExtractedSlide>,
  sentenceMap: Map<string, Sentence>,
  notesData: NotesDocument,
  providers: Providers,
  config: Config,
): Promise<void> {
  const allBlocks = notesData.blocks as unknown[];
  const editList = listEditListEntries(db, mergeRun.id);

  const sealedNotes = allBlocks.map((b) => ({
    id: blockId(b),
    text: blockText(b),
  }));

  const windowRanges = windows.map((w) => ({
    windowId: w.id,
    startMs: w.startMs,
    endMs: w.endMs,
  }));

  const haikuEditList = editList.map((e) => ({
    id: e.id,
    type: e.type,
    windowId: e.windowId,
    sourceIds: e.sourceIds,
    sourceText: e.sourceText,
    noteId: e.noteId ?? undefined,
    retrievedNoteIds: e.retrievedNoteIds,
    ...(e.type === "conflict" ? { poolItems: poolItemsFor(e.sourceIds, slideMap, sentenceMap) } : {}),
  }));

  const haikuTokenThreshold = config.haikuTokenThreshold ?? 100000;
  const haikuInput = { sealedNotes, windowRanges, editList: haikuEditList };

  let rawOps: WritingOperation[] = [];
  if (editList.length > 0) {
    const estimatedTokens = JSON.stringify(haikuInput).length / 4;
    if (estimatedTokens > haikuTokenThreshold && windows.length > 1) {
      // Split at window boundary: first half → call 1, second half → call 2
      const midIdx = Math.floor(windows.length / 2);
      const firstHalfIds = new Set(windows.slice(0, midIdx).map((w) => w.id));

      const editListFirst = haikuEditList.filter((e) => firstHalfIds.has(e.windowId));
      const editListSecond = haikuEditList.filter((e) => !firstHalfIds.has(e.windowId));

      const sealedFirst = sealedNotes.filter((n) => {
        const meta = notesData.meta[n.id];
        if (!meta?.firstEditTime) return true;
        const win = findWindowForBlock(meta.firstEditTime, windows);
        return !win || firstHalfIds.has(win.id);
      });
      const sealedSecond = sealedNotes.filter((n) => {
        const meta = notesData.meta[n.id];
        if (!meta?.firstEditTime) return false;
        const win = findWindowForBlock(meta.firstEditTime, windows);
        return win !== undefined && !firstHalfIds.has(win.id);
      });

      const windowRangesFirst = windowRanges.filter((w) => firstHalfIds.has(w.windowId));
      const windowRangesSecond = windowRanges.filter((w) => !firstHalfIds.has(w.windowId));

      const ops1 =
        editListFirst.length > 0
          ? await providers.writingModel.generateOperations({
              sealedNotes: sealedFirst,
              windowRanges: windowRangesFirst,
              editList: editListFirst,
            })
          : [];
      const ops2 =
        editListSecond.length > 0
          ? await providers.writingModel.generateOperations({
              sealedNotes: sealedSecond,
              windowRanges: windowRangesSecond,
              editList: editListSecond,
            })
          : [];
      rawOps = [...ops1, ...ops2];
    } else {
      rawOps = await providers.writingModel.generateOperations(haikuInput);
    }
  }

  // Validate operations
  const validBlockIds = new Set(sealedNotes.map((b) => b.id));
  const validWindowIds = new Set(windows.map((w) => w.id));
  const entryById = new Map(editList.map((e) => [e.id, e]));
  const validSourceIds = new Set(editList.flatMap((e) => e.sourceIds));

  // Track which entries get answered (for fallback detection) and which op indices are accepted
  const answeredEntries = new Set<string>();
  const acceptedOpIndices = new Set<number>();

  for (let opIdx = 0; opIdx < rawOps.length; opIdx++) {
    const op = rawOps[opIdx]!;
    let dropReason: string | null = null;

    if (op.type === "add_after") {
      if (!validBlockIds.has(op.blockId)) dropReason = `Unknown block ID: ${op.blockId}`;
    } else if (op.type === "add_at_window") {
      if (!validWindowIds.has(op.windowId)) dropReason = `Unknown window ID: ${op.windowId}`;
    } else if (op.type === "rewrite") {
      if (!validBlockIds.has(op.blockId)) dropReason = `Unknown block ID: ${op.blockId}`;
    }

    for (const sid of op.sourceIds) {
      if (!validSourceIds.has(sid)) {
        dropReason = `Unknown source ID: ${sid}`;
        break;
      }
    }

    let entryId: string | null = null;
    for (const [eid, entry] of entryById) {
      if (op.type === "rewrite") {
        if (
          entry.type === "conflict" &&
          entry.noteId === op.blockId &&
          op.sourceIds.some((sid) => entry.sourceIds.includes(sid))
        ) {
          if (!answeredEntries.has(eid)) {
            entryId = eid;
            break;
          }
        }
      } else {
        if (
          entry.type !== "conflict" &&
          op.sourceIds.some((sid) => entry.sourceIds.includes(sid))
        ) {
          if (!answeredEntries.has(eid)) {
            entryId = eid;
            break;
          }
        }
      }
    }

    if (entryId === null && dropReason === null) {
      dropReason = "No matching edit list entry";
    }

    const status = dropReason ? "dropped" : "accepted";
    const target =
      op.type === "add_after" || op.type === "rewrite"
        ? op.blockId
        : op.type === "add_at_window"
          ? op.windowId
          : "";

    createOperation(db, {
      id: uuidv4(),
      mergeRunId: mergeRun.id,
      entryId: entryId ?? "",
      kind: op.type,
      target,
      text: op.text,
      sourceIds: op.sourceIds,
      status,
      dropReason,
    });

    if (status === "accepted" && entryId) {
      answeredEntries.add(entryId);
      acceptedOpIndices.add(opIdx);
    }
  }

  // Build merged note
  const mergedList: MergedListItem[] = [];

  for (let i = 0; i < allBlocks.length; i++) {
    const block = allBlocks[i]!;
    const bid = blockId(block);
    const meta = notesData.meta[bid];
    const windowForBlock = meta?.firstEditTime
      ? findWindowForBlock(meta.firstEditTime, windows)
      : undefined;

    mergedList.push({
      id: uuidv4(),
      origin: "student",
      windowId: windowForBlock?.id ?? null,
      noteId: bid,
      text: blockText(block),
      originalText: null,
      proposedRewrite: null,
      citations: [],
      modelPlaced: false,
      reviewState: null,
      originalPos: i,
    });
  }

  // For each accepted rewrite op, mark the student block as a conflict block
  for (let opIdx = 0; opIdx < rawOps.length; opIdx++) {
    const raw = rawOps[opIdx]!;
    if (raw.type !== "rewrite") continue;
    if (!acceptedOpIndices.has(opIdx)) continue;

    const targetIdx = mergedList.findIndex(
      (b) => b.origin === "student" && b.noteId === raw.blockId,
    );
    if (targetIdx === -1) continue;

    const item = mergedList[targetIdx]!;

    const citations: Citation[] = raw.sourceIds.map((sid) => {
      const kind: "slide" | "transcript" = sid.startsWith("S") ? "slide" : "transcript";
      let text = "";
      if (kind === "slide") {
        const slideId = sid.split("-B")[0];
        if (slideId) {
          const slide = slideMap.get(slideId);
          text = slide?.bullets.find((b) => b.id === sid)?.text ?? "";
        }
      } else {
        const s = sentenceMap.get(sid);
        text = s ? sentenceText(s) : "";
      }
      return { sourceId: sid, kind, text };
    });

    mergedList[targetIdx] = {
      ...item,
      origin: "conflict",
      originalText: item.text,
      proposedRewrite: raw.text,
      citations,
      modelPlaced: true,
      reviewState: "unresolved",
    };
  }

  // Apply addition ops
  const insertions: Array<{
    afterStudentNoteId: string | null;
    afterWindowId: string | null;
    item: MergedListItem;
  }> = [];

  for (let opIdx = 0; opIdx < rawOps.length; opIdx++) {
    const raw = rawOps[opIdx]!;
    if (raw.type !== "add_after" && raw.type !== "add_at_window") continue;
    if (!acceptedOpIndices.has(opIdx)) continue;

    const citations: Citation[] = raw.sourceIds.map((sid) => {
      const kind: "slide" | "transcript" = sid.startsWith("S") ? "slide" : "transcript";
      const entry = editList.find((e) => e.sourceIds.includes(sid));
      return { sourceId: sid, kind, text: entry?.sourceText ?? "" };
    });

    const matchingEntry = [...entryById.values()].find((e) =>
      raw.sourceIds.some((sid) => e.sourceIds.includes(sid)),
    );
    const itemOrigin: MergedListItem["origin"] =
      matchingEntry?.type === "partial" ? "partial_fix" : "addition";

    const item: MergedListItem = {
      id: uuidv4(),
      origin: itemOrigin,
      windowId: raw.type === "add_at_window" ? raw.windowId : null,
      noteId: null,
      text: raw.text,
      originalText: null,
      proposedRewrite: null,
      citations,
      modelPlaced: true,
      reviewState: null,
      originalPos: -1,
    };

    if (raw.type === "add_after") {
      insertions.push({ afterStudentNoteId: raw.blockId, afterWindowId: null, item });
    } else {
      insertions.push({ afterStudentNoteId: null, afterWindowId: raw.windowId, item });
    }
  }

  for (const ins of insertions.filter((i) => i.afterStudentNoteId !== null)) {
    const targetIdx = mergedList.findIndex(
      (b) => b.origin === "student" && b.noteId === ins.afterStudentNoteId,
    );
    if (targetIdx !== -1) {
      mergedList.splice(targetIdx + 1, 0, ins.item);
    }
  }

  for (const ins of insertions.filter((i) => i.afterWindowId !== null)) {
    ins.item.windowId = ins.afterWindowId;
    const insertAfter = insertionPositionForWindow(
      ins.afterWindowId!,
      mergedList,
      windows,
    );
    mergedList.splice(insertAfter + 1, 0, ins.item);
  }

  // Fallback blocks for unanswered entries
  for (const entry of editList) {
    if (answeredEntries.has(entry.id)) continue;

    if (entry.type === "conflict" && entry.noteId) {
      const targetIdx = mergedList.findIndex(
        (b) => b.origin === "student" && b.noteId === entry.noteId,
      );
      if (targetIdx !== -1) {
        const item = mergedList[targetIdx]!;
        const citations: Citation[] = entry.sourceIds.map((sid) => {
          const kind: "slide" | "transcript" = sid.startsWith("S") ? "slide" : "transcript";
          let text = "";
          if (kind === "slide") {
            const slideId = sid.split("-B")[0];
            if (slideId) {
              const slide = slideMap.get(slideId);
              text = slide?.bullets.find((b) => b.id === sid)?.text ?? "";
            }
          } else {
            const s = sentenceMap.get(sid);
            text = s ? sentenceText(s) : "";
          }
          return { sourceId: sid, kind, text };
        });
        mergedList[targetIdx] = {
          ...item,
          origin: "conflict",
          originalText: item.text,
          proposedRewrite: null,
          citations,
          modelPlaced: false,
          reviewState: "unresolved",
        };
      }
    } else if (entry.type !== "conflict") {
      const citations: Citation[] = entry.sourceIds.map((sid) => ({
        sourceId: sid,
        kind: (sid.startsWith("S") ? "slide" : "transcript") as "slide" | "transcript",
        text: entry.sourceText,
      }));

      const fallbackItem: MergedListItem = {
        id: uuidv4(),
        origin: "fallback",
        windowId: entry.windowId,
        noteId: null,
        text: entry.sourceText,
        originalText: null,
        proposedRewrite: null,
        citations,
        modelPlaced: false,
        reviewState: null,
        originalPos: -1,
      };

      const insertAfter = insertionPositionForWindow(entry.windowId, mergedList, windows);
      mergedList.splice(insertAfter + 1, 0, fallbackItem);
    }
  }

  // Save merged blocks
  for (let pos = 0; pos < mergedList.length; pos++) {
    const item = mergedList[pos]!;
    const block: MergedBlock = {
      id: item.id,
      mergeRunId: mergeRun.id,
      position: pos,
      windowId: item.windowId,
      origin: item.origin as MergedBlock["origin"],
      noteId: item.noteId,
      text: item.text,
      originalText: item.originalText,
      proposedRewrite: item.proposedRewrite,
      citations: item.citations,
      modelPlaced: item.modelPlaced,
      reviewState: item.reviewState as MergedBlock["reviewState"],
      played: false,
      lowConfidence: false,
    };
    createMergedBlock(db, block);
  }
}

function buildProcessWindow(
  db: Database.Database,
  mergeRun: MergeRun,
  allBlocks: unknown[],
  notesData: NotesDocument,
  slideMap: Map<string, ExtractedSlide>,
  activeSentences: Sentence[],
  contextMarginMs: number,
  noiseThreshold: number,
  maxRetryAttempts: number,
  retryBaseMs: number,
  providers: Providers,
) {
  return async function processWindow(
    window: SlideWindow,
    existingWr?: WindowResult,
  ): Promise<boolean> {
    const bullets: SlideBullet[] = [];
    for (const slideId of window.mappedSlides) {
      const slide = slideMap.get(slideId);
      if (slide) {
        bullets.push(...slide.bullets);
      }
    }

    const marginStart = window.startMs - contextMarginMs;
    const marginEnd = window.endMs + contextMarginMs;

    const inWindowSentences = activeSentences.filter(
      (s) => s.clockStartTimeMs >= window.startMs && s.clockStartTimeMs < window.endMs,
    );
    const marginSentences = activeSentences.filter(
      (s) =>
        (s.clockStartTimeMs >= marginStart && s.clockStartTimeMs < window.startMs) ||
        (s.clockStartTimeMs >= window.endMs && s.clockStartTimeMs <= marginEnd),
    );

    if (bullets.length === 0 && inWindowSentences.length === 0) return true;

    const windowResult = existingWr ?? createWindowResult(db, uuidv4(), mergeRun.id, window.id);

    const abbrevPairs = listAbbreviationPairs(db);
    const retrievedBlocks: Array<{ id: string; text: string }> = [];
    const inWindowBlocks: Array<{ id: string; text: string }> = [];
    for (const block of allBlocks) {
      const bid = blockId(block);
      const meta = notesData.meta[bid];
      if (!meta?.firstEditTime) continue;
      const rawText = blockText(block);
      if (!rawText) continue;
      const expanded = expandAbbreviations(rawText, abbrevPairs);

      if (meta.firstEditTime >= marginStart && meta.firstEditTime <= marginEnd) {
        retrievedBlocks.push({ id: bid, text: expanded });
      }

      if (meta.firstEditTime >= window.startMs && meta.firstEditTime < window.endMs) {
        inWindowBlocks.push({ id: bid, text: expanded });
      }
    }

    let coverageState = "Notes context:\n" + retrievedBlocks.map((b) => b.text).join("\n");
    if (marginSentences.length > 0) {
      coverageState +=
        "\nTranscript context:\n" +
        marginSentences.map((s) => `${s.id}: ${sentenceText(s)}`).join("\n");
    }

    const questions = [
      ...bullets.map((b) => ({ key: `coverage:${b.id}`, sourceId: b.id, text: b.text })),
      ...inWindowSentences.map((s) => ({
        key: `coverage:${s.id}`,
        sourceId: s.id,
        text: sentenceText(s),
      })),
    ];

    // Coverage check (skip if already done)
    let coverageOk = windowResult.coverageStatus === "done";
    if (!coverageOk) {
      try {
        const answers = await retryClassifierCall(
          () => providers.classifier.classifyCoverage(coverageState, questions),
          maxRetryAttempts,
          retryBaseMs,
        );

        const verdictInputs = questions.map((q) => {
          const answer = answers[q.key] ?? { label: "missing" as const, probability: 0.0 };
          let effectiveLabel = answer.label as string;
          if (answer.label === "noise" && answer.probability < noiseThreshold) {
            effectiveLabel = "missing";
          }
          return {
            id: uuidv4(),
            questionKey: q.key,
            chosenLabel: answer.label,
            probability: answer.probability,
            effectiveLabel,
          };
        });

        saveVerdicts(db, windowResult.id, verdictInputs);
        updateWindowResultCoverage(db, windowResult.id, "done");
        coverageOk = true;

        for (let i = 0; i < verdictInputs.length; i++) {
          const v = verdictInputs[i]!;
          const q = questions[i]!;
          if (v.effectiveLabel === "missing") {
            createEditListEntry(db, {
              id: uuidv4(),
              mergeRunId: mergeRun.id,
              type: "missing",
              windowId: window.id,
              sourceIds: [q.sourceId],
              noteId: null,
              retrievedNoteIds: [],
              sourceText: q.text,
            });
          } else if (v.effectiveLabel === "partially_covered") {
            createEditListEntry(db, {
              id: uuidv4(),
              mergeRunId: mergeRun.id,
              type: "partial",
              windowId: window.id,
              sourceIds: [q.sourceId],
              noteId: null,
              retrievedNoteIds: retrievedBlocks.map((b) => b.id),
              sourceText: q.text,
            });
          }
        }
      } catch (err) {
        updateWindowResultCoverage(
          db,
          windowResult.id,
          "failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Conflict check (skip if already done)
    if (inWindowBlocks.length === 0) {
      if (windowResult.conflictStatus !== "done") {
        updateWindowResultConflict(db, windowResult.id, "done");
      }
      return coverageOk;
    }

    const poolParts: string[] = [
      ...bullets.map((b) => `${b.id} [slide]: ${b.text}`),
      ...inWindowSentences.map((s) => `${s.id} [transcript]: ${sentenceText(s)}`),
    ];
    const poolState = "Pool:\n" + poolParts.join("\n");
    const allPoolSourceIds = [
      ...bullets.map((b) => b.id),
      ...inWindowSentences.map((s) => s.id),
    ];
    const conflictQuestions = inWindowBlocks.map((b) => ({
      key: `conflict:${b.id}`,
      noteBlockId: b.id,
      text: b.text,
    }));

    let conflictOk = windowResult.conflictStatus === "done";
    if (!conflictOk) {
      try {
        const conflictAnswers = await retryClassifierCall(
          () => providers.classifier.checkConflicts(poolState, conflictQuestions),
          maxRetryAttempts,
          retryBaseMs,
        );

        const conflictVerdictInputs = conflictQuestions.map((q) => {
          const answer = conflictAnswers[q.key] ?? {
            label: "supported" as const,
            probability: 0.99,
          };
          return {
            id: uuidv4(),
            questionKey: q.key,
            chosenLabel: answer.label,
            probability: answer.probability,
            effectiveLabel: answer.label,
          };
        });

        saveVerdicts(db, windowResult.id, conflictVerdictInputs);
        updateWindowResultConflict(db, windowResult.id, "done");
        conflictOk = true;

        for (let i = 0; i < conflictVerdictInputs.length; i++) {
          const v = conflictVerdictInputs[i]!;
          if (v.effectiveLabel === "conflicts") {
            const block = inWindowBlocks[i]!;
            // Cite only the pool items the classifier named as evidence; if it named
            // none that exist in the pool, fall back to the whole pool so the flag is never uncited.
            const evidence = (conflictAnswers[conflictQuestions[i]!.key]?.evidenceIds ?? [])
              .filter((id) => allPoolSourceIds.includes(id));
            createEditListEntry(db, {
              id: uuidv4(),
              mergeRunId: mergeRun.id,
              type: "conflict",
              windowId: window.id,
              sourceIds: evidence.length > 0 ? [...new Set(evidence)] : allPoolSourceIds,
              noteId: block.id,
              retrievedNoteIds: [],
              sourceText: block.text,
            });
          }
        }
      } catch (err) {
        updateWindowResultConflict(
          db,
          windowResult.id,
          "failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return coverageOk && conflictOk;
  };
}

export async function mergeLecture(
  db: Database.Database,
  lectureId: string,
  providers: Providers,
  config: Config,
): Promise<MergeRun> {
  const lecture = getLecture(db, lectureId);
  if (!lecture) throw new Error("Lecture not found");

  const SEALED_STAGES = new Set(["sealed", "transcript-check", "merge", "review", "exported"]);
  if (!SEALED_STAGES.has(lecture.stage)) {
    throw new Error("Lecture is not sealed");
  }

  if (getMergeRunByLectureId(db, lectureId)) {
    throw new Error("ALREADY_MERGED");
  }

  const slidesPath = path.join(lecture.dataDir, "slides.json");
  let slides: ExtractedSlide[] = [];
  if (existsSync(slidesPath)) {
    slides = JSON.parse(readFileSync(slidesPath, "utf-8")) as ExtractedSlide[];
  }
  const slideMap = new Map<string, ExtractedSlide>(slides.map((s) => [s.id, s]));

  const allSentences = listSentencesByLecture(db, lectureId);
  const activeSentences = allSentences.filter((s) => s.status === "active");
  const sentenceMap = new Map<string, Sentence>(activeSentences.map((s) => [s.id, s]));

  const notesData = JSON.parse(lecture.notesData) as NotesDocument;
  const windows = resolveWindows(db, lecture, slides.length);

  const mergeRun = createMergeRun(db, uuidv4(), lectureId);

  const contextMarginMs = config.contextMarginMs ?? 60000;
  const noiseThreshold = config.thresholds?.noiseMinProbability ?? 0.95;
  const concurrency = config.mergeWindowConcurrency ?? 4;
  const maxRetryAttempts = config.mergeWindowRetryAttempts ?? 3;
  const retryBaseMs = config.mergeWindowRetryBaseMs ?? 100;

  const allBlocks = notesData.blocks as unknown[];

  const processWindow = buildProcessWindow(
    db, mergeRun, allBlocks, notesData, slideMap, activeSentences,
    contextMarginMs, noiseThreshold, maxRetryAttempts, retryBaseMs, providers,
  );

  const queue = [...windows];
  const running: Promise<void>[] = [];

  async function drainQueue(): Promise<void> {
    while (queue.length > 0 || running.length > 0) {
      while (running.length < concurrency && queue.length > 0) {
        const win = queue.shift()!;
        const p = processWindow(win).then(() => {
          running.splice(running.indexOf(p), 1);
        });
        running.push(p);
      }
      if (running.length > 0) await Promise.race(running);
    }
  }

  await drainQueue();

  // Check for failures
  const allWindowResults = getWindowResultsByMergeRunId(db, mergeRun.id);
  const failedWindowIds = allWindowResults
    .filter((wr) => wr.coverageStatus === "failed" || wr.conflictStatus === "failed")
    .map((wr) => wr.windowId);

  if (failedWindowIds.length > 0) {
    updateMergeRunState(db, mergeRun.id, "paused", failedWindowIds);
    return getMergeRunByLectureId(db, lectureId)!;
  }

  updateMergeRunState(db, mergeRun.id, "haiku");

  await runHaikuAndBuildNote(db, mergeRun, lectureId, windows, slideMap, sentenceMap, notesData, providers, config);

  updateMergeRunState(db, mergeRun.id, "done");
  updateLectureStage(db, lectureId, "review");

  return getMergeRunByLectureId(db, lectureId)!;
}

export async function retryMergeLecture(
  db: Database.Database,
  lectureId: string,
  providers: Providers,
  config: Config,
): Promise<MergeRun> {
  const lecture = getLecture(db, lectureId);
  if (!lecture) throw new Error("Lecture not found");

  const mergeRun = getMergeRunByLectureId(db, lectureId);
  if (!mergeRun) throw new Error("NO_MERGE_RUN");
  if (mergeRun.state !== "paused") throw new Error("MERGE_NOT_PAUSED");

  const slidesPath = path.join(lecture.dataDir, "slides.json");
  let slides: ExtractedSlide[] = [];
  if (existsSync(slidesPath)) {
    slides = JSON.parse(readFileSync(slidesPath, "utf-8")) as ExtractedSlide[];
  }
  const slideMap = new Map<string, ExtractedSlide>(slides.map((s) => [s.id, s]));

  const allSentences = listSentencesByLecture(db, lectureId);
  const activeSentences = allSentences.filter((s) => s.status === "active");
  const sentenceMap = new Map<string, Sentence>(activeSentences.map((s) => [s.id, s]));

  const notesData = JSON.parse(lecture.notesData) as NotesDocument;
  const windows = resolveWindows(db, lecture, slides.length);

  const contextMarginMs = config.contextMarginMs ?? 60000;
  const noiseThreshold = config.thresholds?.noiseMinProbability ?? 0.95;
  const concurrency = config.mergeWindowConcurrency ?? 4;
  const maxRetryAttempts = config.mergeWindowRetryAttempts ?? 3;
  const retryBaseMs = config.mergeWindowRetryBaseMs ?? 100;

  const allBlocks = notesData.blocks as unknown[];

  // Get existing window results
  const existingWindowResults = getWindowResultsByMergeRunId(db, mergeRun.id);
  const windowResultMap = new Map(existingWindowResults.map((wr) => [wr.windowId, wr]));

  // Reset state to running
  updateMergeRunState(db, mergeRun.id, "running", []);

  const processWindow = buildProcessWindow(
    db, mergeRun, allBlocks, notesData, slideMap, activeSentences,
    contextMarginMs, noiseThreshold, maxRetryAttempts, retryBaseMs, providers,
  );

  // Only retry windows that are not fully done
  const windowsToRetry = windows.filter((w) => {
    const wr = windowResultMap.get(w.id);
    if (!wr) return true;
    return wr.coverageStatus !== "done" || wr.conflictStatus !== "done";
  });

  const queue = [...windowsToRetry];
  const running: Promise<void>[] = [];

  async function drainQueue(): Promise<void> {
    while (queue.length > 0 || running.length > 0) {
      while (running.length < concurrency && queue.length > 0) {
        const win = queue.shift()!;
        const existingWr = windowResultMap.get(win.id);
        const p = processWindow(win, existingWr).then(() => {
          running.splice(running.indexOf(p), 1);
        });
        running.push(p);
      }
      if (running.length > 0) await Promise.race(running);
    }
  }

  await drainQueue();

  // Check for remaining failures
  const allWindowResults = getWindowResultsByMergeRunId(db, mergeRun.id);
  const failedWindowIds = allWindowResults
    .filter((wr) => wr.coverageStatus === "failed" || wr.conflictStatus === "failed")
    .map((wr) => wr.windowId);

  if (failedWindowIds.length > 0) {
    updateMergeRunState(db, mergeRun.id, "paused", failedWindowIds);
    return getMergeRunByLectureId(db, lectureId)!;
  }

  updateMergeRunState(db, mergeRun.id, "haiku");

  await runHaikuAndBuildNote(db, mergeRun, lectureId, windows, slideMap, sentenceMap, notesData, providers, config);

  updateMergeRunState(db, mergeRun.id, "done");
  updateLectureStage(db, lectureId, "review");

  return getMergeRunByLectureId(db, lectureId)!;
}
