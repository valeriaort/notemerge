import { Router } from "express";
import type { Request, Response } from "express";
import { readFileSync, existsSync } from "fs";
import path from "path";
import type Database from "better-sqlite3";
import {
  getLecture,
  listMarkers,
  getWindowOverrides,
  saveWindowOverrides,
} from "../db.js";
import { computeWindows } from "../../shared/slideWindows.js";
import { strings } from "../../shared/strings.js";
import type { NotesDocument, SlideWindow, WindowOverride } from "../../shared/types.js";
import type { ExtractedSlide } from "../pdfExtraction.js";

// Stages that allow mapping edits; blocked at "merge" and beyond
const STAGES_ALLOW_MAPPING = new Set(["writing", "sources", "sealed", "transcript-check"]);

function getSlideCount(dataDir: string): number | undefined {
  const slidesPath = path.join(dataDir, "slides.json");
  if (!existsSync(slidesPath)) return undefined;
  const slides = JSON.parse(readFileSync(slidesPath, "utf-8")) as ExtractedSlide[];
  return slides.length;
}

function toOverrides(windows: SlideWindow[]): WindowOverride[] {
  return windows.map((w) => ({
    id: w.id,
    startMs: w.startMs,
    endMs: w.endMs,
    mappedSlides: w.mappedSlides,
  }));
}

function assignBlockIds(
  overrides: WindowOverride[],
  notesData: NotesDocument,
): SlideWindow[] {
  const result: SlideWindow[] = overrides.map((o) => ({ ...o, blockIds: [] }));
  for (const [blockId, meta] of Object.entries(notesData.meta)) {
    if (meta.firstEditTime === undefined) continue;
    const t = meta.firstEditTime;
    let target: SlideWindow | undefined;
    for (const w of result) {
      if (w.startMs <= t) target = w;
      else break;
    }
    if (target) target.blockIds.push(blockId);
  }
  return result;
}

// Returns the current override state, initialising from computed windows on first use
function getCurrentOverrides(
  db: Database.Database,
  lecture: { id: string; dataDir: string; notesData: string },
  markers: ReturnType<typeof listMarkers>,
): WindowOverride[] {
  const existing = getWindowOverrides(db, lecture.id);
  if (existing !== null) return existing;
  const notesData = JSON.parse(lecture.notesData) as NotesDocument;
  const slideCount = getSlideCount(lecture.dataDir);
  return toOverrides(computeWindows(markers, notesData, slideCount));
}

export function windowRoutes(db: Database.Database): Router {
  const router = Router();

  // GET /:lectureId/windows
  router.get("/:lectureId/windows", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["lectureId"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }

    const notesData = JSON.parse(lecture.notesData) as NotesDocument;
    const markers = listMarkers(db, lecture.id);
    const slideCount = getSlideCount(lecture.dataDir);

    const storedOverrides = getWindowOverrides(db, lecture.id);
    let windows: SlideWindow[];
    if (storedOverrides !== null) {
      windows = assignBlockIds(storedOverrides, notesData);
    } else {
      windows = computeWindows(markers, notesData, slideCount);
    }

    let notice: string | undefined;
    if (slideCount !== undefined && windows.length !== slideCount) {
      notice = strings.windows.countDiffNotice(windows.length, slideCount);
    }

    res.json({ windows, ...(notice !== undefined ? { notice } : {}) });
  });

  // PATCH /:lectureId/windows/:windowId — reassign a window's mapped slides
  router.patch("/:lectureId/windows/:windowId", (req: Request, res: Response) => {
    const lectureId = req.params["lectureId"]!;
    const windowId = req.params["windowId"]!;
    const { mappedSlides } = req.body as { mappedSlides: unknown };

    if (!Array.isArray(mappedSlides) || !mappedSlides.every((s) => typeof s === "string")) {
      res.status(400).json({ error: strings.windows.invalidMappedSlides });
      return;
    }

    const lecture = getLecture(db, lectureId);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }
    if (!STAGES_ALLOW_MAPPING.has(lecture.stage)) {
      res.status(403).json({ error: strings.windows.mappingLockedAfterMerge });
      return;
    }

    const markers = listMarkers(db, lecture.id);
    const overrides = getCurrentOverrides(db, lecture, markers);
    const idx = overrides.findIndex((o) => o.id === windowId);
    if (idx === -1) {
      res.status(404).json({ error: strings.windows.windowNotFound });
      return;
    }

    overrides[idx]!.mappedSlides = mappedSlides as string[];
    saveWindowOverrides(db, lecture.id, overrides);

    const notesData = JSON.parse(lecture.notesData) as NotesDocument;
    res.json({ windows: assignBlockIds(overrides, notesData) });
  });

  // POST /:lectureId/windows/merge — merge two adjacent windows
  router.post("/:lectureId/windows/merge", (req: Request, res: Response) => {
    const lectureId = req.params["lectureId"]!;
    const { windowIds } = req.body as { windowIds: unknown };

    if (
      !Array.isArray(windowIds) ||
      windowIds.length !== 2 ||
      !windowIds.every((id) => typeof id === "string")
    ) {
      res.status(400).json({ error: strings.windows.mergeRequiresTwoIds });
      return;
    }

    const lecture = getLecture(db, lectureId);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }
    if (!STAGES_ALLOW_MAPPING.has(lecture.stage)) {
      res.status(403).json({ error: strings.windows.mappingLockedAfterMerge });
      return;
    }

    const markers = listMarkers(db, lecture.id);
    const overrides = getCurrentOverrides(db, lecture, markers);

    const [id1, id2] = windowIds as [string, string];
    const idx1 = overrides.findIndex((o) => o.id === id1);
    const idx2 = overrides.findIndex((o) => o.id === id2);

    if (idx1 === -1 || idx2 === -1) {
      res.status(404).json({ error: strings.windows.windowNotFound });
      return;
    }

    const [lowIdx, highIdx] = idx1 < idx2 ? [idx1, idx2] : [idx2, idx1];
    if (highIdx !== lowIdx + 1) {
      res.status(400).json({ error: strings.windows.windowsNotAdjacent });
      return;
    }

    const low = overrides[lowIdx]!;
    const high = overrides[highIdx]!;
    const merged: WindowOverride = {
      id: low.id,
      startMs: Math.min(low.startMs, high.startMs),
      endMs: Math.max(low.endMs, high.endMs),
      mappedSlides: [...new Set([...low.mappedSlides, ...high.mappedSlides])],
    };

    const newOverrides = [
      ...overrides.slice(0, lowIdx),
      merged,
      ...overrides.slice(highIdx + 1),
    ];
    saveWindowOverrides(db, lecture.id, newOverrides);

    const notesData = JSON.parse(lecture.notesData) as NotesDocument;
    res.json({ windows: assignBlockIds(newOverrides, notesData) });
  });

  // DELETE /:lectureId/windows/:windowId — delete a window
  router.delete("/:lectureId/windows/:windowId", (req: Request, res: Response) => {
    const lectureId = req.params["lectureId"]!;
    const windowId = req.params["windowId"]!;

    const lecture = getLecture(db, lectureId);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }
    if (!STAGES_ALLOW_MAPPING.has(lecture.stage)) {
      res.status(403).json({ error: strings.windows.mappingLockedAfterMerge });
      return;
    }

    const markers = listMarkers(db, lecture.id);
    const overrides = getCurrentOverrides(db, lecture, markers);
    const idx = overrides.findIndex((o) => o.id === windowId);
    if (idx === -1) {
      res.status(404).json({ error: strings.windows.windowNotFound });
      return;
    }
    if (overrides.length === 1) {
      res.status(403).json({ error: strings.windows.cannotDeleteOnlyWindow });
      return;
    }

    const toDelete = overrides[idx]!;
    const newOverrides = [...overrides];

    if (idx === 0) {
      // First window: next window inherits the time range (start moves back)
      newOverrides[1]!.startMs = toDelete.startMs;
    } else {
      // Middle or last window: previous window extends its end
      newOverrides[idx - 1]!.endMs = toDelete.endMs;
    }
    // Deleted window's slides are dropped (not transferred)
    newOverrides.splice(idx, 1);
    saveWindowOverrides(db, lecture.id, newOverrides);

    const notesData = JSON.parse(lecture.notesData) as NotesDocument;
    res.json({ windows: assignBlockIds(newOverrides, notesData) });
  });

  return router;
}
