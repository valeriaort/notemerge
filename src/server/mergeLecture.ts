import { readFileSync, existsSync } from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import type { Providers } from "../providers/interfaces.js";
import type {
  Citation,
  MergeRun,
  MergedBlock,
  NotesDocument,
  SlideWindow,
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
  listAbbreviationPairs,
  listEditListEntries,
  listMarkers,
  saveVerdicts,
  updateLectureStage,
  updateMergeRunState,
  updateWindowResultCoverage,
  updateWindowResultConflict,
} from "./db.js";
import { computeWindows } from "../shared/slideWindows.js";
import { expandAbbreviations } from "../shared/abbreviationExpansion.js";
import type { ExtractedSlide, SlideBullet } from "./pdfExtraction.js";

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
// Returns the index (in mergedList) after which to insert, or -1 to insert at end
function insertionPositionForWindow(
  windowId: string,
  mergedList: Array<{ origin: string; windowId: string | null; originalPos: number }>,
  windows: SlideWindow[],
): number {
  // Find the last student block that belongs to this window or earlier
  const winIdx = windows.findIndex((w) => w.id === windowId);

  // Find last student block in this window
  let lastIdx = -1;
  for (let i = 0; i < mergedList.length; i++) {
    const item = mergedList[i]!;
    if (item.origin === "student" && item.windowId === windowId) {
      lastIdx = i;
    }
  }

  if (lastIdx !== -1) return lastIdx;

  // No student blocks in this window — find last student block in previous windows
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

  // Load slides
  const slidesPath = path.join(lecture.dataDir, "slides.json");
  if (!existsSync(slidesPath)) {
    throw new Error("No slides found for this lecture");
  }
  const slides = JSON.parse(readFileSync(slidesPath, "utf-8")) as ExtractedSlide[];
  const slideMap = new Map<string, ExtractedSlide>(slides.map((s) => [s.id, s]));

  // Compute windows
  const notesData = JSON.parse(lecture.notesData) as NotesDocument;
  const markers = listMarkers(db, lectureId);
  const windows = computeWindows(markers, notesData, slides.length);

  // Load abbreviation pairs for expansion
  const abbrevPairs = listAbbreviationPairs(db);

  // Create merge run
  const mergeRun = createMergeRun(db, uuidv4(), lectureId);

  const contextMarginMs = config.contextMarginMs ?? 60000;
  const noiseThreshold = config.thresholds?.noiseMinProbability ?? 0.95;
  const concurrency = config.mergeWindowConcurrency ?? 4;

  // Process windows in parallel with bounded concurrency
  const allBlocks = (notesData.blocks as unknown[]);

  async function processWindow(window: SlideWindow): Promise<void> {
    // Find bullets for this window from mapped slides
    const bullets: SlideBullet[] = [];
    for (const slideId of window.mappedSlides) {
      const slide = slideMap.get(slideId);
      if (slide) {
        bullets.push(...slide.bullets);
      }
    }

    if (bullets.length === 0) return; // No bullets to classify

    // Retrieved notes: blocks with firstEditTime in [startMs - margin, endMs + margin]
    const marginStart = window.startMs - contextMarginMs;
    const marginEnd = window.endMs + contextMarginMs;

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

      // In-window blocks (strictly inside window) for conflict check
      if (meta.firstEditTime >= window.startMs && meta.firstEditTime < window.endMs) {
        inWindowBlocks.push({ id: bid, text: expanded });
      }
    }

    const coverageState = "Notes context:\n" + retrievedBlocks.map((b) => b.text).join("\n");

    // Build coverage questions
    const questions = bullets.map((b) => ({
      key: `coverage:${b.id}`,
      sourceId: b.id,
      text: b.text,
    }));

    const windowResult = createWindowResult(db, uuidv4(), mergeRun.id, window.id);

    // Coverage check
    try {
      const answers = await providers.classifier.classifyCoverage(coverageState, questions);

      // Save verdicts
      const verdictInputs = questions.map((q) => {
        const answer = answers[q.key] ?? { label: "missing" as const, probability: 0.0 };
        let effectiveLabel = answer.label as string;
        // Apply noise threshold: noise below threshold becomes missing
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

      // Create edit list entries for missing and partially_covered items
      for (let i = 0; i < verdictInputs.length; i++) {
        const v = verdictInputs[i]!;
        const bullet = bullets[i]!;
        if (v.effectiveLabel === "missing") {
          createEditListEntry(db, {
            id: uuidv4(),
            mergeRunId: mergeRun.id,
            type: "missing",
            windowId: window.id,
            sourceIds: [bullet.id],
            noteId: null,
            retrievedNoteIds: [],
            sourceText: bullet.text,
          });
        } else if (v.effectiveLabel === "partially_covered") {
          createEditListEntry(db, {
            id: uuidv4(),
            mergeRunId: mergeRun.id,
            type: "partial",
            windowId: window.id,
            sourceIds: [bullet.id],
            noteId: null,
            retrievedNoteIds: retrievedBlocks.map((b) => b.id),
            sourceText: bullet.text,
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

    // Conflict check: one question per in-window note block against the pool
    if (inWindowBlocks.length === 0) {
      updateWindowResultConflict(db, windowResult.id, "done");
      return;
    }

    const poolState = "Pool:\n" + bullets.map((b) => `${b.id}: ${b.text}`).join("\n");
    const conflictQuestions = inWindowBlocks.map((b) => ({
      key: `conflict:${b.id}`,
      noteBlockId: b.id,
      text: b.text,
    }));

    try {
      const conflictAnswers = await providers.classifier.checkConflicts(
        poolState,
        conflictQuestions,
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

      // Create edit list entries for conflicting blocks
      const allSourceIds = bullets.map((b) => b.id);
      for (let i = 0; i < conflictVerdictInputs.length; i++) {
        const v = conflictVerdictInputs[i]!;
        if (v.effectiveLabel === "conflicts") {
          const block = inWindowBlocks[i]!;
          createEditListEntry(db, {
            id: uuidv4(),
            mergeRunId: mergeRun.id,
            type: "conflict",
            windowId: window.id,
            sourceIds: allSourceIds,
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

  // Process windows with bounded concurrency
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

  updateMergeRunState(db, mergeRun.id, "haiku");

  // Haiku pass
  const editList = listEditListEntries(db, mergeRun.id);

  // Build all blocks with IDs and text for Haiku
  const sealedNotes = (allBlocks as unknown[]).map((b) => ({
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

    // Find which entry this operation answers
    let entryId: string | null = null;
    for (const [eid, entry] of entryById) {
      if (op.type === "rewrite") {
        // Rewrite ops match conflict entries by noteId and sourceIds overlap
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
        // Add ops match by sourceIds overlap
        if (op.sourceIds.some((sid) => entry.sourceIds.includes(sid))) {
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
  // Start with student blocks in document order
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

    // Build citations using slideMap for slide bullet text
    const citations: Citation[] = raw.sourceIds.map((sid) => {
      const kind: "slide" | "transcript" = sid.startsWith("S") ? "slide" : "transcript";
      let text = "";
      if (kind === "slide") {
        const slideId = sid.split("-B")[0];
        if (slideId) {
          const slide = slideMap.get(slideId);
          text = slide?.bullets.find((b) => b.id === sid)?.text ?? "";
        }
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

  // For each accepted addition op, insert new blocks
  const insertions: Array<{
    afterStudentNoteId: string | null;
    afterWindowId: string | null;
    item: MergedListItem;
  }> = [];

  for (let opIdx = 0; opIdx < rawOps.length; opIdx++) {
    const raw = rawOps[opIdx]!;
    if (raw.type !== "add_after" && raw.type !== "add_at_window") continue;
    if (!acceptedOpIndices.has(opIdx)) continue;

    // Build citations from sourceIds
    const citations: Citation[] = raw.sourceIds.map((sid) => {
      // Determine if slide or transcript
      const kind: "slide" | "transcript" = sid.startsWith("S") ? "slide" : "transcript";
      // Find source text from edit list
      const entry = editList.find((e) => e.sourceIds.includes(sid));
      return { sourceId: sid, kind, text: entry?.sourceText ?? "" };
    });

    // partial entries get partial_fix origin; everything else is addition
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

  // Apply insertions to mergedList
  // First do add_after insertions
  for (const ins of insertions.filter((i) => i.afterStudentNoteId !== null)) {
    const targetIdx = mergedList.findIndex(
      (b) => b.origin === "student" && b.noteId === ins.afterStudentNoteId,
    );
    if (targetIdx !== -1) {
      mergedList.splice(targetIdx + 1, 0, ins.item);
    }
  }

  // Then do add_at_window insertions
  for (const ins of insertions.filter((i) => i.afterWindowId !== null)) {
    ins.item.windowId = ins.afterWindowId;
    const insertAfter = insertionPositionForWindow(
      ins.afterWindowId!,
      mergedList,
      windows,
    );
    mergedList.splice(insertAfter + 1, 0, ins.item);
  }

  // Add fallback blocks/flags for unanswered entries
  for (const entry of editList) {
    if (answeredEntries.has(entry.id)) continue;

    if (entry.type === "conflict" && entry.noteId) {
      // Fallback: flag the student block as a conflict with no model-placed rewrite
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
      // Fallback for missing/partial entries: verbatim addition block
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

      // Insert at window position
      const insertAfter = insertionPositionForWindow(entry.windowId, mergedList, windows);
      mergedList.splice(insertAfter + 1, 0, fallbackItem);
    }
  }

  // Save merged blocks with final positions
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
    };
    createMergedBlock(db, block);
  }

  updateMergeRunState(db, mergeRun.id, "done");
  updateLectureStage(db, lectureId, "review");

  return getMergeRunByLectureId(db, lectureId)!;
}
