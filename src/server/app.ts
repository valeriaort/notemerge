import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import type Database from "better-sqlite3";
import type { Providers } from "../providers/interfaces.js";
import { lectureRoutes } from "./routes/lectures.js";
import { markerRoutes } from "./routes/markers.js";
import { subjectRoutes } from "./routes/subjects.js";
import { audioSourcesRoutes } from "./routes/audio.js";
import { abbreviationRoutes, abbreviationLectureRoutes } from "./routes/abbreviations.js";
import { glossaryRoutes } from "./routes/glossary.js";
import { windowRoutes } from "./routes/windows.js";
import { mergeRoutes } from "./routes/merge.js";
import { transcriptionRoutes } from "./routes/transcription.js";
import { config } from "./config.js";
import type { Config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(
  db: Database.Database,
  dataDir: string,
  _providers: Providers,
  cfgOverride: Partial<Config> = {},
) {
  const cfg = { ...config, ...cfgOverride };
  const app = express();

  app.use(express.json());

  app.use("/api/lectures", lectureRoutes(db, dataDir));
  app.use("/api/lectures", markerRoutes(db));
  app.use("/api/lectures", audioSourcesRoutes(db, dataDir, cfg.chunkTargetMs ?? 120000));
  app.use("/api/lectures", abbreviationLectureRoutes(db));
  app.use("/api/lectures", windowRoutes(db));
  app.use("/api/lectures", mergeRoutes(db, _providers, cfg));
  app.use("/api/lectures", transcriptionRoutes(db, _providers, cfg));
  app.use("/api/subjects", subjectRoutes(db));
  app.use("/api/subjects", glossaryRoutes(db, dataDir));
  app.use("/api/abbreviations", abbreviationRoutes(db));

  // Reserved for Notion OAuth ticket (#29)
  app.get("/api/notion/callback", (_req, res) => {
    res.status(501).json({ error: "Not implemented — see ticket #29" });
  });

  // Serve React client in production
  const clientDist = path.resolve(__dirname, "../../dist/client");
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  return app;
}
