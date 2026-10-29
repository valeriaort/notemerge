import { Router } from "express";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import {
  getLecture,
  listAudioFiles,
  getAudioFileById,
  updateAudioFileRecordingStart,
  hasReviewDecision,
} from "../db.js";
import { strings } from "../../shared/strings.js";

export function reviewLockRoutes(db: Database.Database): Router {
  const router = Router();

  // PATCH /:id/transcription-model — rejected after any review decision
  router.patch("/:id/transcription-model", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["id"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }

    if (hasReviewDecision(db, lecture.id)) {
      res.status(409).json({ error: strings.review.lockedAfterReview });
      return;
    }

    const { model } = req.body as { model?: unknown };
    if (typeof model !== "string" || model.trim() === "") {
      res.status(400).json({ error: "model must be a non-empty string." });
      return;
    }

    const audioFiles = listAudioFiles(db, lecture.id);
    for (const af of audioFiles) {
      db.prepare("UPDATE audio_files SET transcription_model = ? WHERE id = ?").run(model.trim(), af.id);
    }

    res.json({ model: model.trim() });
  });

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
