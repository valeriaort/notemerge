import { Router } from "express";
import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import { createMarker, deleteMarker, getLecture, listMarkers } from "../db.js";

export function markerRoutes(db: Database.Database): Router {
  const router = Router();

  router.get("/:lectureId/markers", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["lectureId"]!);
    if (!lecture) {
      res.status(404).json({ error: "Lecture not found" });
      return;
    }
    res.json(listMarkers(db, lecture.id));
  });

  router.post("/:lectureId/markers", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["lectureId"]!);
    if (!lecture) {
      res.status(404).json({ error: "Lecture not found" });
      return;
    }
    const { timestamp, blockId } = req.body as { timestamp?: unknown; blockId?: unknown };
    if (typeof timestamp !== "number" || typeof blockId !== "string") {
      res.status(400).json({ error: "timestamp (number) and blockId (string) required" });
      return;
    }
    const marker = createMarker(db, uuidv4(), lecture.id, timestamp, blockId);
    res.status(201).json(marker);
  });

  router.delete("/:lectureId/markers/:markerId", (req: Request, res: Response) => {
    const deleted = deleteMarker(db, req.params["markerId"]!, req.params["lectureId"]!);
    if (!deleted) {
      res.status(404).json({ error: "Marker not found" });
      return;
    }
    res.status(204).send();
  });

  return router;
}
