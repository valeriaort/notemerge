import { Router } from "express";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import type { Providers } from "../../providers/interfaces.js";
import type { Config } from "../config.js";
import { notionCallbackUri } from "../config.js";
import { strings } from "../../shared/strings.js";

export function notionRoutes(_db: Database.Database, providers: Providers, cfg: Config): Router {
  const router = Router();

  router.get("/auth-url", (_req: Request, res: Response) => {
    const redirectUri = notionCallbackUri(cfg.port);
    const state = Math.random().toString(36).slice(2);
    const url = providers.notion.getOAuthUrl(redirectUri, state);
    res.json({ url });
  });

  router.get("/callback", async (req: Request, res: Response) => {
    const { code } = req.query as { code?: string };
    if (!code) {
      res.status(400).json({ error: strings.notion.missingCode });
      return;
    }
    try {
      const redirectUri = notionCallbackUri(cfg.port);
      const { accessToken } = await providers.notion.exchangeCode(code, redirectUri);
      cfg.notion = { ...cfg.notion, accessToken };
      res.json({ success: true });
    } catch {
      res.status(502).json({ error: strings.notion.oauthFailed });
    }
  });

  router.get("/status", (_req: Request, res: Response) => {
    res.json({ connected: !!cfg.notion?.accessToken });
  });

  router.get("/search-pages", async (req: Request, res: Response) => {
    if (!cfg.notion?.accessToken) {
      res.status(401).json({ error: strings.notion.notConnected });
      return;
    }
    const q = (req.query["q"] as string) ?? "";
    try {
      const pages = await providers.notion.searchPages(cfg.notion.accessToken, q);
      res.json({ pages });
    } catch {
      res.status(502).json({ error: strings.notion.searchFailed });
    }
  });

  router.post("/root-pages", async (req: Request, res: Response) => {
    if (!cfg.notion?.accessToken) {
      res.status(401).json({ error: strings.notion.notConnected });
      return;
    }
    const { title } = req.body as { title?: string };
    if (!title?.trim()) {
      res.status(400).json({ error: strings.notion.titleRequired });
      return;
    }
    try {
      const page = await providers.notion.createPage(cfg.notion.accessToken, null, title.trim());
      res.status(201).json({ page });
    } catch {
      res.status(502).json({ error: strings.notion.createPageFailed });
    }
  });

  return router;
}
