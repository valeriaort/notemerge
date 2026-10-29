import type { SlideMarker, NotesDocument, SlideWindow } from "./types.js";

const FOUR_MINUTES_MS = 4 * 60 * 1000;

function lectureBounds(
  notesData: NotesDocument,
): { startMs: number; endMs: number } | null {
  let startMs: number | null = null;
  let endMs: number | null = null;

  for (const meta of Object.values(notesData.meta)) {
    if (meta.firstEditTime === undefined) continue;
    if (startMs === null || meta.firstEditTime < startMs) startMs = meta.firstEditTime;
    const last = meta.lastEditTime ?? meta.firstEditTime;
    if (endMs === null || last > endMs) endMs = last;
  }

  if (startMs === null) return null;
  return { startMs, endMs: endMs ?? startMs };
}

export function computeWindows(
  markers: SlideMarker[],
  notesData: NotesDocument,
  slideCount?: number,
): SlideWindow[] {
  const bounds = lectureBounds(notesData);
  if (bounds === null) return [];

  const { startMs: lectureStart, endMs: lectureEnd } = bounds;

  let boundaries: number[];

  if (markers.length === 0) {
    // Fixed 4-minute windows
    boundaries = [lectureStart];
    let t = lectureStart + FOUR_MINUTES_MS;
    while (t < lectureEnd) {
      boundaries.push(t);
      t += FOUR_MINUTES_MS;
    }
    boundaries.push(lectureEnd);
  } else {
    // N markers → N+1 windows; a marker at lectureStart deduplicates to a dropped empty window
    const boundarySet = new Set<number>([lectureStart, lectureEnd]);
    for (const m of markers) {
      if (m.timestamp > lectureStart && m.timestamp < lectureEnd) {
        boundarySet.add(m.timestamp);
      }
      // marker at lectureStart: lectureStart already in set, empty window dropped automatically
    }
    boundaries = Array.from(boundarySet).sort((a, b) => a - b);
  }

  // Build windows from consecutive boundary pairs
  const windows: SlideWindow[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!;
    const end = boundaries[i + 1]!;
    if (start === end) continue; // zero-duration window, skip

    const n = windows.length + 1;
    const id = `W${String(n).padStart(3, "0")}`;
    const mappedSlides: string[] = [];
    if (slideCount !== undefined && slideCount > 0 && n <= slideCount) {
      mappedSlides.push(`S${String(n).padStart(3, "0")}`);
    }

    windows.push({ id, startMs: start, endMs: end, mappedSlides, blockIds: [] });
  }

  // Place each block in the window whose startMs is the largest one <= firstEditTime
  for (const [blockId, meta] of Object.entries(notesData.meta)) {
    if (meta.firstEditTime === undefined) continue;
    const t = meta.firstEditTime;
    let target: SlideWindow | undefined;
    for (const w of windows) {
      if (w.startMs <= t) target = w;
      else break;
    }
    if (target) target.blockIds.push(blockId);
  }

  return windows;
}
