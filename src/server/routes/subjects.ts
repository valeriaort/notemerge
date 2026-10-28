import { Router } from "express";
import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import {
  createSubject,
  listSubjects,
  getLastUsedSubject,
  ensureDefaultUser,
} from "../db.js";

export function subjectRoutes(db: Database.Database): Router {
  const router = Router();

  router.get("/last-used", (_req: Request, res: Response) => {
    const subject = getLastUsedSubject(db);
    res.json({ subject });
  });

  router.get("/", (_req: Request, res: Response) => {
    const subjects = listSubjects(db);
    res.json(subjects);
  });

  router.post("/", (req: Request, res: Response) => {
    const { name } = req.body as { name?: string };
    if (typeof name !== "string" || name.trim() === "") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const user = ensureDefaultUser(db);
    const subject = createSubject(db, uuidv4(), name.trim(), user.id);
    res.status(201).json(subject);
  });

  return router;
}
