import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import {
  getLecture,
  createSubject,
  getSubject,
  sealLecture,
  ensureDefaultUser,
  listMarkers,
  createAudioFile,
  createAudioChunk,
  listAudioFiles,
} from "../db.js";
import { strings } from "../../shared/strings.js";
import { extractSlidesFromPdf } from "../pdfExtraction.js";
import { chunkAudioFile } from "../chunking.js";
import { config } from "../config.js";
import { writeFileSync, mkdirSync } from "fs";

// ~2 hours maximum total audio duration
const MAX_TOTAL_DURATION_MS = 2.5 * 60 * 60 * 1000;

const storage = multer.memoryStorage();
const upload = multer({ storage });

export function audioSourcesRoutes(
  db: Database.Database,
  _dataDir: string,
  chunkTargetMs: number = config.chunkTargetMs ?? 120000,
): Router {
  const router = Router();

  // GET /:id/audio-files — list audio files for a lecture (used by review to check hasAudio)
  router.get("/:id/audio-files", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["id"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }
    const audioFiles = listAudioFiles(db, lecture.id);
    res.json({ audioFiles });
  });

  // Returns the suggested recording start time for the first audio file (first slide marker).
  router.get("/:id/audio-start-suggestion", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["id"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }
    const markers = listMarkers(db, lecture.id);
    const suggestedStartMs = markers.length > 0 ? markers[0]!.timestamp : null;
    res.json({ suggestedStartMs });
  });

  // Derive recording start time from an audio offset aligned to a slide marker (user stories 24, 25).
  // derivedStartMs = markerTimestamp − audioOffsetMs
  router.post("/:id/derive-audio-start", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["id"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }

    const body = req.body as { markerId?: unknown; audioOffsetMs?: unknown };

    if (!body.markerId || typeof body.markerId !== "string") {
      res.status(400).json({ error: strings.audio.alignMarkerRequired });
      return;
    }

    if (typeof body.audioOffsetMs !== "number" || body.audioOffsetMs < 0) {
      res.status(400).json({ error: strings.audio.alignOffsetInvalid });
      return;
    }

    const markers = listMarkers(db, lecture.id);
    const marker = markers.find((m) => m.id === body.markerId);
    if (!marker) {
      res.status(400).json({ error: strings.audio.alignMarkerNotFound });
      return;
    }

    const derivedStartMs = marker.timestamp - (body.audioOffsetMs as number);
    res.json({ derivedStartMs });
  });

  router.post(
    "/:id/sources",
    upload.fields([
      { name: "presentation", maxCount: 1 },
      { name: "audio1", maxCount: 1 },
      { name: "audio2", maxCount: 1 },
    ]),
    async (req: Request, res: Response) => {
      const lecture = getLecture(db, req.params["id"]!);
      if (!lecture) {
        res.status(404).json({ error: strings.errors.lectureNotFound });
        return;
      }

      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const presentationFile = files?.["presentation"]?.[0];
      const audio1File = files?.["audio1"]?.[0];
      const audio2File = files?.["audio2"]?.[0];

      // Valid combos: need at least a presentation or an audio file
      if (!presentationFile && !audio1File) {
        res.status(400).json({ error: strings.audio.notesAloneError });
        return;
      }

      // audio2 requires audio1
      if (audio2File && !audio1File) {
        res.status(400).json({ error: strings.audio.audio2WithoutAudio1Error });
        return;
      }

      const body = req.body as {
        subjectId?: string;
        subjectName?: string;
        audio1StartTime?: string;
        audio2StartTime?: string;
      };

      // audio2 requires its own start time
      if (audio2File && !body.audio2StartTime) {
        res.status(400).json({ error: strings.audio.audio2StartTimeRequired });
        return;
      }

      const user = ensureDefaultUser(db);

      let subject;
      if (body.subjectId) {
        subject = getSubject(db, body.subjectId);
        if (!subject) {
          res.status(400).json({ error: "Subject not found" });
          return;
        }
      } else if (body.subjectName && body.subjectName.trim() !== "") {
        subject = createSubject(db, uuidv4(), body.subjectName.trim(), user.id);
      } else {
        res.status(400).json({ error: strings.sources.subjectRequiredError });
        return;
      }

      // Save lecture data dir
      const lectureDir = lecture.dataDir;
      mkdirSync(lectureDir, { recursive: true });

      // Process presentation PDF if provided
      let presentationPath: string | null = null;
      let slides: unknown[] = [];
      if (presentationFile) {
        const extraction = await extractSlidesFromPdf(presentationFile.buffer);
        if (!extraction.ok) {
          res.status(400).json({ error: extraction.error });
          return;
        }
        presentationPath = path.join(lectureDir, "presentation.pdf");
        writeFileSync(presentationPath, presentationFile.buffer);
        writeFileSync(
          path.join(lectureDir, "slides.json"),
          JSON.stringify(extraction.slides),
        );
        slides = extraction.slides;
      }

      // Determine first start time: default to first slide marker if not provided (user story 22)
      const markers = listMarkers(db, lecture.id);
      const firstMarkerMs = markers.length > 0 ? markers[0]!.timestamp : Date.now();

      type ProcessedAudio = {
        audioFileId: string;
        index: number;
        filePath: string;
        recordingStartMs: number;
        durationMs: number;
        chunks: import("../chunking.js").AudioChunkInfo[];
      };

      const audioInputs: Array<{ file: Express.Multer.File; index: number; startTimeStr?: string }> = [];
      if (audio1File) audioInputs.push({ file: audio1File, index: 1, startTimeStr: body.audio1StartTime });
      if (audio2File) audioInputs.push({ file: audio2File, index: 2, startTimeStr: body.audio2StartTime });

      // Phase 1: chunk all audio files, validate before persisting
      const processed: ProcessedAudio[] = [];
      for (const { file, index, startTimeStr } of audioInputs) {
        // Determine recording start time
        let recordingStartMs: number;
        if (startTimeStr) {
          recordingStartMs = parseInt(startTimeStr, 10);
          if (isNaN(recordingStartMs)) {
            res.status(400).json({ error: `Invalid start time for audio file ${index}` });
            return;
          }
        } else if (index === 1) {
          recordingStartMs = firstMarkerMs;
        } else {
          res.status(400).json({ error: strings.audio.audio2StartTimeRequired });
          return;
        }

        // Save audio file to disk
        const ext = path.extname(file.originalname) || ".wav";
        const audioFilePath = path.join(lectureDir, `audio${index}${ext}`);
        writeFileSync(audioFilePath, file.buffer);

        // Chunk the audio file (ffmpeg runs for real)
        const chunksDir = path.join(lectureDir, `chunks_A${String(index).padStart(2, "0")}`);
        const result = await chunkAudioFile(audioFilePath, chunksDir, index, chunkTargetMs);
        if (!result.ok) {
          res.status(400).json({ error: strings.audio.chunkingFailed(result.error) });
          return;
        }

        processed.push({
          audioFileId: uuidv4(),
          index,
          filePath: audioFilePath,
          recordingStartMs,
          durationMs: result.durationMs,
          chunks: result.chunks,
        });
      }

      // Validate total duration before persisting
      const totalDurationMs = processed.reduce((sum, p) => sum + p.durationMs, 0);
      if (totalDurationMs > MAX_TOTAL_DURATION_MS) {
        res.status(400).json({ error: strings.audio.durationTooLongError });
        return;
      }

      // Phase 2: persist audio files and chunks to DB
      for (const p of processed) {
        const audioFile = createAudioFile(
          db,
          p.audioFileId,
          lecture.id,
          p.index,
          p.filePath,
          p.recordingStartMs,
          p.durationMs,
        );
        for (let ci = 0; ci < p.chunks.length; ci++) {
          const chunk = p.chunks[ci]!;
          createAudioChunk(
            db,
            chunk.id,
            audioFile.id,
            ci + 1,
            chunk.filePath,
            chunk.startOffsetMs,
            chunk.durationMs,
          );
        }
      }

      // Seal the lecture
      const sealed = sealLecture(db, lecture.id, subject.id, presentationPath);
      if (!sealed) {
        res.status(500).json({ error: "Failed to seal lecture" });
        return;
      }

      res.json({
        lecture: sealed,
        subject,
        ...(slides.length > 0 ? { slides } : {}),
      });
    },
  );

  return router;
}
