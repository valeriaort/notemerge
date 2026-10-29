import { Router } from "express";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { Providers } from "../../providers/interfaces.js";
import {
  getLecture,
  getTranscriptRunByLectureId,
  listSentencesByLecture,
  listAudioFiles,
  getWindowOverrides,
  listMarkers,
} from "../db.js";
import { transcribeLecture } from "../transcribeLecture.js";
import { computeWindows } from "../../shared/slideWindows.js";
import { strings } from "../../shared/strings.js";
import type { NotesDocument, Sentence, WindowOverride } from "../../shared/types.js";

export function transcriptionRoutes(
  db: Database.Database,
  providers: Providers,
  cfg: Config,
): Router {
  const router = Router();

  // POST /:id/transcribe — start transcription
  router.post("/:id/transcribe", async (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["id"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }
    if (lecture.stage !== "sealed") {
      res.status(409).json({ error: "Lecture is not sealed" });
      return;
    }
    const audioFiles = listAudioFiles(db, lecture.id);
    if (audioFiles.length === 0) {
      res.status(400).json({ error: "No audio files attached to this lecture" });
      return;
    }
    try {
      const result = await transcribeLecture(db, lecture.id, providers, cfg);
      res.status(201).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // GET /:id/transcribe — get transcript run status
  router.get("/:id/transcribe", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["id"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }
    const transcriptRun = getTranscriptRunByLectureId(db, lecture.id);
    if (!transcriptRun) {
      res.status(404).json({ error: "No transcript run found" });
      return;
    }
    res.json({ transcriptRun });
  });

  // GET /:id/sentences — sentences with window assignment
  router.get("/:id/sentences", (req: Request, res: Response) => {
    try {
    const lecture = getLecture(db, req.params["id"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }

    const sentences = listSentencesByLecture(db, lecture.id);

    // Compute windows so we can assign sentences
    const notesDoc = JSON.parse(lecture.notesData) as NotesDocument;
    const markers = listMarkers(db, lecture.id);
    const audioFiles = listAudioFiles(db, lecture.id);

    const audioBounds = audioFiles.length > 0 ? {
      startMs: Math.min(...audioFiles.map((af) => af.recordingStartMs)),
      endMs: Math.max(...audioFiles.map((af) => af.recordingStartMs + af.durationMs)),
    } : undefined;

    const storedOverrides = getWindowOverrides(db, lecture.id);
    let windows;
    if (storedOverrides !== null) {
      windows = (storedOverrides as WindowOverride[]).map((o) => ({ ...o, blockIds: [] as string[] }));
    } else {
      windows = computeWindows(markers, notesDoc, undefined, audioBounds);
    }

    // Assign each sentence to the window containing its clockStartTimeMs
    const sentencesWithWindow = sentences.map((s: Sentence) => {
      const win = windows.find(
        (w) => s.clockStartTimeMs >= w.startMs && s.clockStartTimeMs < w.endMs,
      );
      return { ...s, windowId: win?.id ?? null };
    });

    res.json({ sentences: sentencesWithWindow, windows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
