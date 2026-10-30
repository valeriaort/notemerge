import type Database from "better-sqlite3";
import { listMarkers, listAudioFiles, getWindowOverrides } from "./db.js";
import { computeWindows } from "../shared/slideWindows.js";
import type { NotesDocument, SlideWindow } from "../shared/types.js";

// Audio start/end become part of the lecture bounds (spec: lecture start/end include audio)
export function getAudioBounds(
  db: Database.Database,
  lectureId: string,
): { startMs: number; endMs: number } | undefined {
  const audioFiles = listAudioFiles(db, lectureId);
  if (audioFiles.length === 0) return undefined;
  const startMs = Math.min(...audioFiles.map((af) => af.recordingStartMs));
  const endMs = Math.max(
    ...audioFiles.map((af) => af.recordingStartMs + af.durationMs),
  );
  return { startMs, endMs };
}

// The one place windows are built: stored manual overrides win, otherwise computed from
// markers, notes and audio bounds. Used by the windows route, transcription and merge so
// window IDs and boundaries cannot drift between them.
export function resolveWindows(
  db: Database.Database,
  lecture: { id: string; notesData: string },
  slideCount?: number,
): SlideWindow[] {
  const notesData = JSON.parse(lecture.notesData) as NotesDocument;
  const stored = getWindowOverrides(db, lecture.id);
  if (stored !== null) {
    return assignBlockIds(stored, notesData);
  }
  const markers = listMarkers(db, lecture.id);
  return computeWindows(markers, notesData, slideCount, getAudioBounds(db, lecture.id));
}

export function assignBlockIds(
  overrides: { id: string; startMs: number; endMs: number; mappedSlides: string[] }[],
  notesData: NotesDocument,
): SlideWindow[] {
  const result: SlideWindow[] = overrides.map((o) => ({ ...o, blockIds: [] }));
  for (const [blockId, meta] of Object.entries(notesData.meta)) {
    if (meta.firstEditTime === undefined) continue;
    const t = meta.firstEditTime;
    let target: SlideWindow | undefined;
    for (const w of result) {
      if (w.startMs <= t) target = w;
      else break;
    }
    if (target) target.blockIds.push(blockId);
  }
  return result;
}
