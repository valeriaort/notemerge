import { Router } from "express";
import type { Request, Response } from "express";
import { mkdirSync } from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import {
  createLecture,
  getLecture,
  listLectures,
  updateLectureNotes,
  ensureDefaultUser,
} from "../db.js";

const SEALED_STAGES = new Set(["sealed", "transcript-check", "merge", "review", "exported"]);

export function lectureRoutes(db: Database.Database, dataDir: string): Router {
  const router = Router();

  router.post("/", (req: Request, res: Response) => {
    const user = ensureDefaultUser(db);
    const id = uuidv4();
    const lectureDir = path.join(dataDir, id);
    mkdirSync(lectureDir, { recursive: true });

    const lecture = createLecture(db, id, user.id, lectureDir);
    res.status(201).json(lecture);
  });

  router.get("/", (_req: Request, res: Response) => {
    const lectures = listLectures(db);
    res.json(lectures);
  });

  router.get("/:id", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["id"]!);
    if (!lecture) {
      res.status(404).json({ error: "Lecture not found" });
      return;
    }
    res.json(lecture);
  });

  router.put("/:id/notes", (req: Request, res: Response) => {
    const { notesData } = req.body as { notesData?: string };
    if (typeof notesData !== "string") {
      res.status(400).json({ error: "notesData must be a string" });
      return;
    }

    const existing = getLecture(db, req.params["id"]!);
    if (!existing) {
      res.status(404).json({ error: "Lecture not found" });
      return;
    }
    if (SEALED_STAGES.has(existing.stage)) {
      res.status(403).json({ error: "Notes are sealed and cannot be edited" });
      return;
    }

    const lecture = updateLectureNotes(db, req.params["id"]!, notesData);
    if (!lecture) {
      res.status(404).json({ error: "Lecture not found" });
      return;
    }
    res.json(lecture);
  });

  return router;
}
