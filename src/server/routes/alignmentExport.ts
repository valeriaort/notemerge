import { Router } from "express";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { getAlignment, getBlockScores, getLecture, getMergeRunByLectureId } from "../db.js";
import { DEFAULT_CONTENT_ALIGNMENT } from "../contentAlignment.js";
import type { AlignmentExport } from "../../shared/types.js";

// Developer tool: a lecture's content alignment, one entry per scored note block, for labelling
// by hand and feeding to scripts/evaluate-alignment.ts. Not part of the student's flow.
export function alignmentExportRoutes(db: Database.Database, config: Config): Router {
  const router = Router();

  router.get("/:lectureId/alignment/export", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["lectureId"]!);
    if (!lecture) {
      res.status(404).json({ error: "Lecture not found." });
      return;
    }
    if (lecture.mode !== "untimed") {
      res.status(409).json({ error: "Only untimed notes are aligned by content." });
      return;
    }
    const mergeRun = getMergeRunByLectureId(db, lecture.id);
    const windows = mergeRun ? getAlignment(db, mergeRun.id) : null;
    if (!mergeRun || !windows) {
      res.status(404).json({ error: "No alignment found for this lecture." });
      return;
    }
    const threshold = config.contentAlignment?.weakMatchThreshold ?? DEFAULT_CONTENT_ALIGNMENT.weakMatchThreshold;
    const body: AlignmentExport = {
      lectureId: lecture.id,
      weakMatchThreshold: threshold,
      windows: windows.map((w) => ({ id: w.id, mappedSlides: w.mappedSlides, sentenceIds: w.sentenceIds })),
      blocks: getBlockScores(db, mergeRun.id).map((b) => ({
        ...b,
        weak: !b.placed || b.score < threshold,
        // To fill in by hand: the correct window id, or "not taught"
        correctWindowId: null,
      })),
    };
    res.json(body);
  });

  return router;
}
