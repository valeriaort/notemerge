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
} from "../db.js";
import { strings } from "../../shared/strings.js";

const SEALED_STAGES = new Set(["sealed", "transcript-check", "merge", "review", "exported"]);

// Store uploads in the lecture's data dir; multer config set per-request via diskStorage
const storage = multer.memoryStorage();
const upload = multer({ storage });

export function sourcesRoutes(db: Database.Database): Router {
  const router = Router();

  router.post(
    "/:id/sources",
    upload.single("presentation"),
    async (req: Request, res: Response) => {
      const lecture = getLecture(db, req.params["id"]!);
      if (!lecture) {
        res.status(404).json({ error: strings.errors.lectureNotFound });
        return;
      }

      if (!req.file) {
        res.status(400).json({ error: strings.sources.notesAloneError });
        return;
      }

      const { subjectId, subjectName } = req.body as {
        subjectId?: string;
        subjectName?: string;
      };

      const user = ensureDefaultUser(db);

      let subject;
      if (subjectId) {
        subject = getSubject(db, subjectId);
        if (!subject) {
          res.status(400).json({ error: "Subject not found" });
          return;
        }
      } else if (subjectName && subjectName.trim() !== "") {
        subject = createSubject(db, uuidv4(), subjectName.trim(), user.id);
      } else {
        res.status(400).json({ error: strings.sources.subjectRequiredError });
        return;
      }

      // Save the PDF to the lecture's data directory
      const { writeFileSync } = await import("fs");
      const presentationPath = path.join(lecture.dataDir, "presentation.pdf");
      writeFileSync(presentationPath, req.file.buffer);

      const sealed = sealLecture(db, lecture.id, subject.id, presentationPath);
      if (!sealed) {
        res.status(500).json({ error: "Failed to seal lecture" });
        return;
      }

      res.json({ lecture: sealed, subject });
    },
  );

  return router;
}
