import { Router } from "express";
import type { Request, Response } from "express";
import { readFileSync, existsSync } from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { getLecture, listMarkers, listAudioFiles } from "../db.js";
import { computeWindows } from "../../shared/slideWindows.js";
import { strings } from "../../shared/strings.js";
import type { NotesDocument } from "../../shared/types.js";
import type { ExtractedSlide } from "../pdfExtraction.js";

export function windowRoutes(db: Database.Database): Router {
  const router = Router();

  router.get("/:lectureId/windows", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["lectureId"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }

    const notesData = JSON.parse(lecture.notesData) as NotesDocument;
    const markers = listMarkers(db, lecture.id);

    let slideCount: number | undefined;
    const slidesPath = path.join(lecture.dataDir, "slides.json");
    if (existsSync(slidesPath)) {
      const slides = JSON.parse(readFileSync(slidesPath, "utf-8")) as ExtractedSlide[];
      slideCount = slides.length;
    }

    // Incorporate audio start/end into lecture bounds (spec: lecture start/end include audio)
    let audioBounds: { startMs: number; endMs: number } | undefined;
    const audioFiles = listAudioFiles(db, lecture.id);
    if (audioFiles.length > 0) {
      const audioStart = Math.min(...audioFiles.map((af) => af.recordingStartMs));
      const audioEnd = Math.max(
        ...audioFiles.map((af) => af.recordingStartMs + af.durationMs),
      );
      audioBounds = { startMs: audioStart, endMs: audioEnd };
    }

    const windows = computeWindows(markers, notesData, slideCount, audioBounds);

    let notice: string | undefined;
    if (slideCount !== undefined && windows.length !== slideCount) {
      notice = strings.windows.countDiffNotice(windows.length, slideCount);
    }

    res.json({ windows, ...(notice !== undefined ? { notice } : {}) });
  });

  return router;
}
