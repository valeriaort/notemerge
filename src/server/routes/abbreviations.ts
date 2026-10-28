import { Router } from "express";
import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import {
  listAbbreviationPairs,
  createAbbreviationPair,
  deleteAbbreviationPair,
  addIgnoredToken,
  listIgnoredTokens,
  getLecture,
  ensureDefaultUser,
} from "../db.js";
import { expandNotesData, extractTextFromNotesData } from "../../shared/abbreviationExpansion.js";
import { findUnknownTokens } from "../../shared/unknownTokens.js";

export function abbreviationRoutes(db: Database.Database): Router {
  const router = Router();

  router.get("/", (_req: Request, res: Response) => {
    const pairs = listAbbreviationPairs(db);
    res.json(pairs);
  });

  router.post("/", (req: Request, res: Response) => {
    const { abbreviation, expansion, matchCaseExactly } = req.body as {
      abbreviation?: string;
      expansion?: string;
      matchCaseExactly?: boolean;
    };

    if (!abbreviation || typeof abbreviation !== "string" || abbreviation.trim() === "") {
      res.status(400).json({ error: "abbreviation is required" });
      return;
    }
    if (!expansion || typeof expansion !== "string" || expansion.trim() === "") {
      res.status(400).json({ error: "expansion is required" });
      return;
    }

    const user = ensureDefaultUser(db);
    const pair = createAbbreviationPair(
      db,
      uuidv4(),
      user.id,
      abbreviation.trim(),
      expansion.trim(),
      matchCaseExactly === true,
    );
    res.status(201).json(pair);
  });

  // Must be declared before /:id to avoid route shadowing
  router.post("/ignored", (req: Request, res: Response) => {
    const { token } = req.body as { token?: string };
    if (!token || typeof token !== "string" || token.trim() === "") {
      res.status(400).json({ error: "token is required" });
      return;
    }
    const user = ensureDefaultUser(db);
    addIgnoredToken(db, user.id, token.trim());
    res.status(201).json({ token: token.trim().toLowerCase() });
  });

  router.delete("/:id", (req: Request, res: Response) => {
    const deleted = deleteAbbreviationPair(db, req.params["id"]!);
    if (!deleted) {
      res.status(404).json({ error: "Abbreviation pair not found" });
      return;
    }
    res.status(204).send();
  });

  return router;
}

export function abbreviationLectureRoutes(db: Database.Database): Router {
  const router = Router();

  router.get("/:id/unknown-tokens", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["id"]!);
    if (!lecture) {
      res.status(404).json({ error: "Lecture not found" });
      return;
    }

    const pairs = listAbbreviationPairs(db);
    const user = ensureDefaultUser(db);
    const ignored = listIgnoredTokens(db, user.id);
    const text = extractTextFromNotesData(lecture.notesData);
    const tokens = findUnknownTokens(text, pairs, ignored);
    res.json(tokens);
  });

  router.get("/:id/notes/expanded", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["id"]!);
    if (!lecture) {
      res.status(404).json({ error: "Lecture not found" });
      return;
    }

    const pairs = listAbbreviationPairs(db);
    const notesData = expandNotesData(lecture.notesData, pairs);
    res.json({ notesData });
  });

  return router;
}
