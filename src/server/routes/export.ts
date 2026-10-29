import { Router } from "express";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import {
  getLecture,
  getMergeRunByLectureId,
  hasUnresolvedConflicts,
  computeFinalNoteBlocks,
  updateLectureStage,
} from "../db.js";
import { strings } from "../../shared/strings.js";

export function exportRoutes(db: Database.Database): Router {
  const router = Router();

  // GET /:lectureId/final-note — compute final note, gate on unresolved conflicts
  router.get("/:lectureId/final-note", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["lectureId"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }

    const mergeRun = getMergeRunByLectureId(db, lecture.id);
    if (!mergeRun) {
      res.status(404).json({ error: strings.export.noMerge });
      return;
    }

    if (hasUnresolvedConflicts(db, lecture.id)) {
      res.status(409).json({ error: strings.export.unresolvedConflicts });
      return;
    }

    const blocks = computeFinalNoteBlocks(db, lecture.id, mergeRun.id);
    res.json({ blocks });
  });

  // POST /:lectureId/export/pdf — gate on conflicts, then set stage to exported
  router.post("/:lectureId/export/pdf", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["lectureId"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }

    if (lecture.stage !== "review" && lecture.stage !== "exported") {
      res.status(409).json({ error: strings.export.notInReview });
      return;
    }

    const mergeRun = getMergeRunByLectureId(db, lecture.id);
    if (!mergeRun) {
      res.status(409).json({ error: strings.export.noMerge });
      return;
    }

    if (hasUnresolvedConflicts(db, lecture.id)) {
      res.status(409).json({ error: strings.export.unresolvedConflicts });
      return;
    }

    updateLectureStage(db, lecture.id, "exported");
    const updated = getLecture(db, lecture.id);
    res.json({ lecture: updated });
  });

  return router;
}
