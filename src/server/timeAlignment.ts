import type { AlignedWindow, NotesDocument, Sentence, Window } from "../shared/types.js";

// Time alignment (live notes): turns time windows into the persisted ID lists. This is the
// only place the merge's window membership compares times.
export function timeAlign(
  windows: Window[],
  notesData: NotesDocument,
  activeSentences: Sentence[],
  contextMarginMs: number,
): AlignedWindow[] {
  return windows.map((w) => {
    const marginStart = w.startMs - contextMarginMs;
    const marginEnd = w.endMs + contextMarginMs;

    const sentenceIds = activeSentences
      .filter((s) => s.clockStartTimeMs >= w.startMs && s.clockStartTimeMs < w.endMs)
      .map((s) => s.id);
    const contextSentenceIds = activeSentences
      .filter(
        (s) =>
          (s.clockStartTimeMs >= marginStart && s.clockStartTimeMs < w.startMs) ||
          (s.clockStartTimeMs >= w.endMs && s.clockStartTimeMs <= marginEnd),
      )
      .map((s) => s.id);

    // "Notes context" includes the window's own blocks.
    const contextBlockIds: string[] = [];
    for (const [blockId, meta] of Object.entries(notesData.meta)) {
      if (!meta.firstEditTime) continue;
      if (meta.firstEditTime >= marginStart && meta.firstEditTime <= marginEnd) {
        contextBlockIds.push(blockId);
      }
    }

    return {
      id: w.id,
      mappedSlides: w.mappedSlides,
      sentenceIds,
      blockIds: w.blockIds,
      contextSentenceIds,
      contextBlockIds,
      startMs: w.startMs,
      endMs: w.endMs,
    };
  });
}
