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

    const retrievedTexts: string[] = [];
    for (const block of allBlocks) {
      const bid = blockId(block);
      const meta = notesData.meta[bid];
      if (!meta?.firstEditTime) continue;
      if (meta.firstEditTime >= marginStart && meta.firstEditTime <= marginEnd) {
        const text = blockText(block);
        if (text) {
          const expanded = expandAbbreviations(text, abbrevPairs);
          retrievedTexts.push(expanded);
        }
      }
    }

    const state = "Notes context:\n" + retrievedTexts.join("\n");

    // Build coverage questions
    const questions = bullets.map((b) => ({
      key: `coverage:${b.id}`,
      sourceId: b.id,
      text: b.text,
    }));

    const windowResult = createWindowResult(db, uuidv4(), mergeRun.id, window.id);

    try {
      const answers = await providers.classifier.classifyCoverage(state, questions);

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

      // Create edit list entries for missing items
      for (let i = 0; i < verdictInputs.length; i++) {
        const v = verdictInputs[i]!;
        if (v.effectiveLabel === "missing") {
          const bullet = bullets[i]!;
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

  let rawOps: WritingOperation[] = [];
  if (editList.length > 0) {
    rawOps = await providers.writingModel.generateOperations({
      sealedNotes,
      windowRanges,
      editList: haikuEditList,
    });
  }

  // Validate operations
  const validBlockIds = new Set(sealedNotes.map((b) => b.id));
  const validWindowIds = new Set(windows.map((w) => w.id));
  const entryById = new Map(editList.map((e) => [e.id, e]));
  const validSourceIds = new Set(editList.flatMap((e) => e.sourceIds));

  // Track which entries get answered (for fallback detection)
  const answeredEntries = new Set<string>();

  for (const op of rawOps) {
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

    // Find which entry this operation answers (match by sourceIds overlap)
    let entryId: string | null = null;
    for (const [eid, entry] of entryById) {
      if (op.sourceIds.some((sid) => entry.sourceIds.includes(sid))) {
        if (!answeredEntries.has(eid)) {
          entryId = eid;
          break;
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
      citations: [],
      modelPlaced: false,
      reviewState: null,
      originalPos: i,
    });
  }

  // For each accepted operation, insert addition blocks
  const acceptedOps = rawOps
    .map((op) => {
      const target =
        op.type === "add_after" || op.type === "rewrite"
          ? op.blockId
          : op.type === "add_at_window"
            ? op.windowId
            : "";
      return { op, target };
    })
    .filter(({ op, target }) => {
      const opTarget =
        op.type === "add_after" || op.type === "rewrite"
          ? op.blockId
          : op.type === "add_at_window"
            ? op.windowId
            : "";
      // Check it was accepted
      return op.sourceIds.some((sid) => validSourceIds.has(sid)) &&
        (op.type === "add_after" ? validBlockIds.has(target) :
         op.type === "add_at_window" ? validWindowIds.has(target) : false);
    });

  // Collect add_after and add_at_window ops (in order they come from Haiku)
  const insertions: Array<{
    afterStudentNoteId: string | null;
    afterWindowId: string | null;
    item: MergedListItem;
  }> = [];

  for (const raw of rawOps) {
    if (raw.type !== "add_after" && raw.type !== "add_at_window") continue;

    // Check if this was accepted (not dropped)
    const opTarget = raw.type === "add_after" ? raw.blockId : raw.windowId;
    const isValidTarget =
      raw.type === "add_after" ? validBlockIds.has(opTarget) : validWindowIds.has(opTarget);
    const hasValidSources = raw.sourceIds.some((sid) => validSourceIds.has(sid));
    if (!isValidTarget || !hasValidSources) continue;

    // Find if it was dropped
    // Check answeredEntries — if its sources are in answeredEntries indirectly; simpler: check DB
    // For simplicity, re-check the logic: an op is accepted if no dropReason was set
    // We need to re-derive that. Let's just use the same validation logic:
    let dropReason: string | null = null;
    if (raw.type === "add_after" && !validBlockIds.has(raw.blockId)) {
      dropReason = "invalid";
    } else if (raw.type === "add_at_window" && !validWindowIds.has(raw.windowId)) {
      dropReason = "invalid";
    }
    for (const sid of raw.sourceIds) {
      if (!validSourceIds.has(sid)) { dropReason = "invalid"; break; }
    }
    if (dropReason) continue;

    // Build citations from sourceIds
    const citations: Citation[] = raw.sourceIds.map((sid) => {
      // Determine if slide or transcript
      const kind: "slide" | "transcript" = sid.startsWith("S") ? "slide" : "transcript";
      // Find source text from edit list
      const entry = editList.find((e) => e.sourceIds.includes(sid));
      return { sourceId: sid, kind, text: entry?.sourceText ?? "" };
    });

    const item: MergedListItem = {
      id: uuidv4(),
      origin: "addition",
      windowId: raw.type === "add_at_window" ? raw.windowId : null,
      noteId: null,
      text: raw.text,
      citations,
      modelPlaced: true,
      reviewState: "kept",
      originalPos: -1,
    };

    if (raw.type === "add_after") {
      insertions.push({ afterStudentNoteId: raw.blockId, afterWindowId: null, item });
    } else {
      insertions.push({ afterStudentNoteId: null, afterWindowId: raw.windowId, item });
    }
  }

  // Apply insertions to mergedList
  // Process from end to start to keep indices valid for add_after
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

  // Add fallback blocks for unanswered entries
  for (const entry of editList) {
    if (!answeredEntries.has(entry.id)) {
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
        citations,
        modelPlaced: false,
        reviewState: "kept",
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
      originalText: null,
      proposedRewrite: null,
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
