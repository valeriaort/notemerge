import { Router } from "express";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import type { Providers } from "../../providers/interfaces.js";
import type { Config } from "../config.js";
import { getLecture, getMergeRunByLectureId, listMergedBlocks } from "../db.js";
import { mergeLecture, retryMergeLecture } from "../mergeLecture.js";
import { strings } from "../../shared/strings.js";

export function mergeRoutes(
  db: Database.Database,
  providers: Providers,
  config: Config,
): Router {
  const router = Router();

  router.post("/:lectureId/merge", async (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["lectureId"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }

    const SEALED_STAGES = new Set(["sealed", "transcript-check"]);
    if (!SEALED_STAGES.has(lecture.stage)) {
      if (lecture.stage === "writing" || lecture.stage === "sources") {
        res.status(400).json({ error: "Lecture is not yet sealed." });
        return;
      }
      // Already merged or further
      res.status(409).json({ error: strings.merge.alreadyMerged });
      return;
    }

    try {
      const mergeRun = await mergeLecture(db, lecture.id, providers, config);
      const blocks = listMergedBlocks(db, mergeRun.id);
      res.status(201).json({ mergeRun, mergedNote: blocks });
    } catch (err) {
      if (err instanceof Error && err.message === "ALREADY_MERGED") {
        res.status(409).json({ error: strings.merge.alreadyMerged });
        return;
      }
      if (err instanceof Error && err.message === "Lecture is not sealed") {
        res.status(400).json({ error: "Lecture is not yet sealed." });
        return;
      }
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: msg });
    }
  });

  router.get("/:lectureId/merge", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["lectureId"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }

    const mergeRun = getMergeRunByLectureId(db, lecture.id);
    if (!mergeRun) {
      res.status(404).json({ error: "No merge run found for this lecture." });
      return;
    }

    res.json({ mergeRun });
  });

  router.get("/:lectureId/merged-note", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["lectureId"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }

    const mergeRun = getMergeRunByLectureId(db, lecture.id);
    if (!mergeRun) {
      res.status(404).json({ error: "No merge run found for this lecture." });
      return;
    }

    const blocks = listMergedBlocks(db, mergeRun.id);
    res.json({ blocks });
  });

  router.post("/:lectureId/merge/retry", async (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["lectureId"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }

    const mergeRun = getMergeRunByLectureId(db, lecture.id);
    if (!mergeRun) {
      res.status(404).json({ error: "No merge run found for this lecture." });
      return;
    }

    if (mergeRun.state !== "paused") {
      res.status(409).json({ error: strings.merge.retryNotAllowed });
      return;
    }

    try {
      const updatedRun = await retryMergeLecture(db, lecture.id, providers, config);
      const blocks = updatedRun.state === "done" ? listMergedBlocks(db, updatedRun.id) : [];
      res.status(200).json({ mergeRun: updatedRun, mergedNote: blocks });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
