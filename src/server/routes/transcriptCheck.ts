import { Router, type Request, type Response } from "express";
import { createReadStream, existsSync } from "fs";
import path from "path";
import type Database from "better-sqlite3";
import type { Providers } from "../../providers/interfaces.js";
import type { Config } from "../config.js";
import {
  getLecture,
  getSentence,
  updateSentence,
  listFlaggedUnhandledSentencesByLecture,
  countHandledFlaggedSentencesByLecture,
  countTotalFlaggedSentencesByLecture,
  sentenceBelongsToLecture,
  getAudioChunk,
  listMergedBlocks,
} from "../db.js";
import { mergeLecture } from "../mergeLecture.js";
import { strings } from "../../shared/strings.js";

export function transcriptCheckRoutes(
  db: Database.Database,
  providers: Providers,
  cfg: Config,
): Router {
  const router = Router();

  // GET /:id/transcript-check — queue status
  router.get("/:id/transcript-check", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["id"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }
    if (lecture.stage !== "transcript-check") {
      res.status(409).json({ error: strings.transcriptCheck.notInCheckStage });
      return;
    }
    const queue = listFlaggedUnhandledSentencesByLecture(db, lecture.id);
    const handled = countHandledFlaggedSentencesByLecture(db, lecture.id);
    const total = countTotalFlaggedSentencesByLecture(db, lecture.id);
    res.json({ queue, handled, total });
  });

  // PATCH /:id/sentences/:sentenceId — advance or correct a flagged sentence
  router.patch("/:id/sentences/:sentenceId", async (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["id"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }
    if (lecture.stage !== "transcript-check") {
      res.status(409).json({ error: strings.transcriptCheck.notInCheckStage });
      return;
    }

    const sentenceId = req.params["sentenceId"]!;
    if (!sentenceBelongsToLecture(db, sentenceId, lecture.id)) {
      res.status(404).json({ error: strings.transcriptCheck.sentenceNotInLecture });
      return;
    }

    const sentence = getSentence(db, sentenceId);
    if (!sentence) {
      res.status(404).json({ error: strings.transcriptCheck.sentenceNotFound });
      return;
    }
    if (sentence.flagState !== "flagged_unhandled") {
      res.status(409).json({ error: strings.transcriptCheck.sentenceNotFlagged });
      return;
    }

    const body = req.body as { action?: unknown; correctedText?: unknown };
    const action = body.action;
    if (action !== "advance" && action !== "correct") {
      res.status(400).json({ error: strings.transcriptCheck.invalidAction });
      return;
    }
    if (action === "correct") {
      if (typeof body.correctedText !== "string" || body.correctedText.trim() === "") {
        res.status(400).json({ error: strings.transcriptCheck.correctedTextRequired });
        return;
      }
      updateSentence(db, sentenceId, {
        flagState: "corrected",
        correctedText: body.correctedText as string,
      });
    } else {
      updateSentence(db, sentenceId, { flagState: "advanced" });
    }

    const updatedSentence = getSentence(db, sentenceId)!;

    // Auto-start merge when queue is now empty
    const remaining = listFlaggedUnhandledSentencesByLecture(db, lecture.id);
    if (remaining.length === 0) {
      try {
        const mergeRun = await mergeLecture(db, lecture.id, providers, cfg);
        const mergedNote = listMergedBlocks(db, mergeRun.id);
        res.json({ sentence: updatedSentence, mergeStarted: true, mergeRun, mergedNote });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
      return;
    }

    res.json({ sentence: updatedSentence, mergeStarted: false });
  });

  // POST /:id/transcript-check/skip — skip all remaining flags and start merge
  router.post("/:id/transcript-check/skip", async (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["id"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }
    if (lecture.stage !== "transcript-check") {
      res.status(409).json({ error: strings.transcriptCheck.notInCheckStage });
      return;
    }
    // Skipped flags keep state flagged_unhandled — no state changes

    try {
      const mergeRun = await mergeLecture(db, lecture.id, providers, cfg);
      const mergedNote = listMergedBlocks(db, mergeRun.id);
      res.status(201).json({ mergeRun, mergedNote });
    } catch (err) {
      if (err instanceof Error && err.message === "ALREADY_MERGED") {
        res.status(409).json({ error: strings.merge.alreadyMerged });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // GET /:id/sentences/:sentenceId/audio-clip — serve chunk audio for playback
  router.get("/:id/sentences/:sentenceId/audio-clip", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["id"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }
    const sentenceId = req.params["sentenceId"]!;
    if (!sentenceBelongsToLecture(db, sentenceId, lecture.id)) {
      res.status(404).json({ error: strings.transcriptCheck.sentenceNotInLecture });
      return;
    }
    const sentence = getSentence(db, sentenceId);
    if (!sentence) {
      res.status(404).json({ error: strings.transcriptCheck.sentenceNotFound });
      return;
    }
    const chunk = getAudioChunk(db, sentence.chunkId);
    if (!chunk || !existsSync(chunk.filePath)) {
      res.status(404).json({ error: "Audio chunk file not found." });
      return;
    }
    const ext = path.extname(chunk.filePath).toLowerCase();
    const contentType = ext === ".mp3" ? "audio/mpeg" : "audio/wav";
    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Sentence-Start-Ms", String(sentence.audioStartOffsetMs));
    res.setHeader("X-Sentence-End-Ms", String(sentence.audioEndOffsetMs));
    createReadStream(chunk.filePath).pipe(res);
  });

  return router;
}
