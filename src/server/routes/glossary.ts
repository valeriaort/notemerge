import { Router } from "express";
import type { Request, Response } from "express";
import multer from "multer";
import path from "path";
import { mkdirSync } from "fs";
import { writeFileSync } from "fs";
import type Database from "better-sqlite3";
import { getSubject, updateSubjectGlossary } from "../db.js";
import { buildSubjectGlossary } from "../../shared/termRetention.js";

const upload = multer({ storage: multer.memoryStorage() });

export function glossaryRoutes(db: Database.Database, dataDir: string): Router {
  const router = Router();

  router.post(
    "/:id/guia",
    upload.single("guia"),
    async (req: Request, res: Response) => {
      const subject = getSubject(db, req.params["id"]!);
      if (!subject) {
        res.status(404).json({ error: "Subject not found" });
        return;
      }

      if (!req.file) {
        res.status(400).json({ error: "A guía docente PDF is required" });
        return;
      }

      let pdfText = "";
      try {
        const { PDFParse } = await import("pdf-parse");
        const data = new Uint8Array(req.file.buffer);
        const parser = new PDFParse({ data, verbosity: 0 });
        const result = await parser.getText();
        pdfText = result.text ?? "";
        await parser.destroy();
      } catch {
        res.status(400).json({ error: "Failed to parse the PDF" });
        return;
      }

      if (pdfText.trim().length < 20) {
        res.status(400).json({ error: "The PDF has no extractable text" });
        return;
      }

      const terms = buildSubjectGlossary(pdfText);

      // Save the PDF to a subject subfolder
      const subjectDir = path.join(dataDir, "subjects", subject.id);
      mkdirSync(subjectDir, { recursive: true });
      const guiaPath = path.join(subjectDir, "guia.pdf");
      writeFileSync(guiaPath, req.file.buffer);

      const updated = updateSubjectGlossary(db, subject.id, terms, guiaPath);
      if (!updated) {
        res.status(500).json({ error: "Failed to update glossary" });
        return;
      }

      res.json(updated);
    },
  );

  return router;
}
