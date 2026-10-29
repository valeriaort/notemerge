import { Router } from "express";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import {
  getLecture,
  getAudioFileById,
  updateAudioFileRecordingStart,
  hasReviewDecision,
} from "../db.js";
import { strings } from "../../shared/strings.js";

export function reviewLockRoutes(db: Database.Database): Router {
  const router = Router();

  // Note: PATCH /:id/transcription-model is handled in transcriptionRoutes,
  // which unifies the #24 review-decision lock with the #16 re-run warning.

  // PATCH /:id/audio/:fileId/recording-start — rejected after any review decision
  router.patch("/:id/audio/:fileId/recording-start", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["id"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }

    if (hasReviewDecision(db, lecture.id)) {
      res.status(409).json({ error: strings.review.lockedAfterReview });
      return;
    }

    const audioFile = getAudioFileById(db, req.params["fileId"]!);
    if (!audioFile || audioFile.lectureId !== lecture.id) {
      res.status(404).json({ error: "Audio file not found." });
      return;
    }

    const { recordingStartMs } = req.body as { recordingStartMs?: unknown };
    if (typeof recordingStartMs !== "number" || !Number.isFinite(recordingStartMs)) {
      res.status(400).json({ error: "recordingStartMs must be a number." });
      return;
    }

    updateAudioFileRecordingStart(db, audioFile.id, recordingStartMs);
    res.json({ recordingStartMs });
  });

  return router;
}
