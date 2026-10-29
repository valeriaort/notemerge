import { Router } from "express";
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import type { Providers } from "../../providers/interfaces.js";
import type { NotionExportBlock } from "../../providers/interfaces.js";
import type { Config } from "../config.js";
import {
  getLecture,
  getMergeRunByLectureId,
  hasUnresolvedConflicts,
  computeFinalNoteBlocks,
  updateLectureStage,
  listMergedBlocks,
  getSubject,
  updateLectureNotionUrl,
  countLectureNotionExportsForDay,
} from "../db.js";
import { strings } from "../../shared/strings.js";

function toNotionType(blockNoteType: string, level?: number): string {
  switch (blockNoteType) {
    case "paragraph": return "paragraph";
    case "heading": return `heading_${Math.min(Math.max(level ?? 1, 1), 3)}`;
    case "heading1": return "heading_1";
    case "heading2": return "heading_2";
    case "heading3": return "heading_3";
    case "bulletListItem": return "bulleted_list_item";
    case "numberedListItem": return "numbered_list_item";
    default: return "paragraph";
  }
}

function flattenNotesBlocksMeta(
  blocks: unknown[],
  result: Map<string, { type: string; level?: number; parentId?: string }>,
  parentId?: string,
): void {
  for (const b of blocks as Array<{ id: string; type: string; props?: { level?: number }; children?: unknown[] }>) {
    result.set(b.id, { type: b.type, level: b.props?.level, parentId });
    if (b.children?.length) {
      flattenNotesBlocksMeta(b.children, result, b.id);
    }
  }
}

function computeNotionBlocks(
  db: Database.Database,
  lectureId: string,
  mergeRunId: string,
  notesDataJson: string,
): NotionExportBlock[] {
  const markerRows = db.prepare(
    "SELECT block_id FROM slide_markers WHERE lecture_id = ?",
  ).all(lectureId) as { block_id: string }[];
  const markerBlockIds = new Set(markerRows.map((r) => r.block_id));

  const notesMeta = new Map<string, { type: string; level?: number; parentId?: string }>();
  try {
    const notesData = JSON.parse(notesDataJson) as { blocks?: unknown[] };
    if (Array.isArray(notesData.blocks)) {
      flattenNotesBlocksMeta(notesData.blocks, notesMeta);
    }
  } catch { /* ignore parse errors */ }

  const allBlocks = listMergedBlocks(db, mergeRunId);

  interface WorkBlock {
    text: string;
    noteId: string | null;
    notionType: string;
    parentNoteId?: string;
  }

  const finalFlat: WorkBlock[] = [];
  for (const block of allBlocks) {
    if (block.reviewState === "reverted") continue;
    if (block.origin === "conflict" && block.reviewState === "unresolved") continue;
    if (block.origin === "student" && block.noteId !== null && markerBlockIds.has(block.noteId)) continue;

    const meta = block.noteId ? notesMeta.get(block.noteId) : null;
    finalFlat.push({
      text: block.text,
      noteId: block.noteId,
      notionType: meta ? toNotionType(meta.type, meta.level) : "paragraph",
      parentNoteId: meta?.parentId,
    });
  }

  const finalNoteIds = new Set(finalFlat.map((b) => b.noteId).filter(Boolean) as string[]);
  const blockByNoteId = new Map(
    finalFlat.filter((b) => b.noteId !== null).map((b) => [b.noteId!, b]),
  );
  const notionBlockMap = new Map<WorkBlock, NotionExportBlock>();
  const result: NotionExportBlock[] = [];

  for (const flat of finalFlat) {
    const notionBlock: NotionExportBlock = { type: flat.notionType, text: flat.text, children: [] };
    notionBlockMap.set(flat, notionBlock);

    if (flat.parentNoteId && finalNoteIds.has(flat.parentNoteId)) {
      const parentFlat = blockByNoteId.get(flat.parentNoteId);
      const parentNotion = parentFlat ? notionBlockMap.get(parentFlat) : undefined;
      if (parentNotion) {
        parentNotion.children.push(notionBlock);
      } else {
        result.push(notionBlock);
      }
    } else {
      result.push(notionBlock);
    }
  }

  return result;
}

export function exportRoutes(db: Database.Database, providers: Providers, cfg: Config): Router {
  const router = Router();

  // GET /:lectureId/final-note — compute final note, gate on unresolved conflicts
  router.get("/:lectureId/final-note", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["lectureId"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }

    const mergeRun = getMergeRunByLectureId(db, lecture.id);
    if (!mergeRun) {
      res.status(404).json({ error: strings.export.noMerge });
      return;
    }

    if (hasUnresolvedConflicts(db, lecture.id)) {
      res.status(409).json({ error: strings.export.unresolvedConflicts });
      return;
    }

    const blocks = computeFinalNoteBlocks(db, lecture.id, mergeRun.id);
    res.json({ blocks });
  });

  // POST /:lectureId/export/pdf — gate on conflicts, then set stage to exported
  router.post("/:lectureId/export/pdf", (req: Request, res: Response) => {
    const lecture = getLecture(db, req.params["lectureId"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }

    if (lecture.stage !== "review" && lecture.stage !== "exported") {
      res.status(409).json({ error: strings.export.notInReview });
      return;
    }

    const mergeRun = getMergeRunByLectureId(db, lecture.id);
    if (!mergeRun) {
      res.status(409).json({ error: strings.export.noMerge });
      return;
    }

    if (hasUnresolvedConflicts(db, lecture.id)) {
      res.status(409).json({ error: strings.export.unresolvedConflicts });
      return;
    }

    updateLectureStage(db, lecture.id, "exported");
    const updated = getLecture(db, lecture.id);
    res.json({ lecture: updated });
  });

  // POST /:lectureId/export/notion — push final note to Notion as a new child page
  router.post("/:lectureId/export/notion", async (req: Request, res: Response) => {
    if (!cfg.notion?.accessToken) {
      res.status(401).json({ error: strings.notion.notConnected });
      return;
    }

    const lecture = getLecture(db, req.params["lectureId"]!);
    if (!lecture) {
      res.status(404).json({ error: strings.errors.lectureNotFound });
      return;
    }

    if (lecture.stage !== "review" && lecture.stage !== "exported") {
      res.status(409).json({ error: strings.export.notInReview });
      return;
    }

    const mergeRun = getMergeRunByLectureId(db, lecture.id);
    if (!mergeRun) {
      res.status(409).json({ error: strings.export.noMerge });
      return;
    }

    if (hasUnresolvedConflicts(db, lecture.id)) {
      res.status(409).json({ error: strings.export.unresolvedConflicts });
      return;
    }

    if (!lecture.subjectId) {
      res.status(422).json({ error: strings.notion.noSubject });
      return;
    }

    const subject = getSubject(db, lecture.subjectId);
    if (!subject?.notionParentPageId) {
      res.status(422).json({ error: strings.notion.pickerRequired });
      return;
    }

    let parentPage;
    try {
      parentPage = await providers.notion.getPage(cfg.notion.accessToken, subject.notionParentPageId);
    } catch {
      parentPage = null;
    }
    if (!parentPage) {
      res.status(404).json({ error: strings.notion.parentPageMissing, needsPicker: true });
      return;
    }

    const lectureDate = new Date(lecture.createdAt);
    const dateStr = lectureDate.toISOString().slice(0, 10);
    const count = countLectureNotionExportsForDay(db, lecture.subjectId, dateStr);
    const formattedDate = lectureDate.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const title = count === 0 ? formattedDate : `${formattedDate} (${count + 1})`;

    const notionBlocks = computeNotionBlocks(db, lecture.id, mergeRun.id, lecture.notesData);

    let pageUrl: string;
    try {
      const result = await providers.notion.createChildPage(
        cfg.notion.accessToken,
        subject.notionParentPageId,
        title,
        notionBlocks,
      );
      pageUrl = result.pageUrl;
    } catch {
      res.status(502).json({ error: strings.notion.exportFailed });
      return;
    }

    updateLectureNotionUrl(db, lecture.id, pageUrl);
    updateLectureStage(db, lecture.id, "exported");

    res.json({ pageUrl, title });
  });

  return router;
}
