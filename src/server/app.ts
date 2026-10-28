import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import type Database from "better-sqlite3";
import type { Providers } from "../providers/interfaces.js";
import { lectureRoutes } from "./routes/lectures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(
  db: Database.Database,
  dataDir: string,
  _providers: Providers,
) {
  const app = express();

  app.use(express.json());

  app.use("/api/lectures", lectureRoutes(db, dataDir));

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
