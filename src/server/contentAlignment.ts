import type { EmbeddingProvider } from "../providers/interfaces.js";
import type { AbbreviationPair, AlignedWindow, BlockScore, NotesDocument, Sentence, WeakMatch } from "../shared/types.js";
import { expandAbbreviations } from "../shared/abbreviationExpansion.js";
import type { ExtractedSlide } from "./pdfExtraction.js";

export interface ContentAlignmentOptions {
  // Transcript span length (consecutive active sentences) used as the unit to match
  spanMs: number;
  // Audio-only windows: a window is cut at the first sentence boundary at or after this length
  audioWindowMs: number;
  // Note blocks shorter than this (characters) take their neighbours' placement
  shortItemChars: number;
  // A placed block whose best similarity to its window is below this is a weak match
  weakMatchThreshold: number;
  // A match must beat this similarity to be worth placing; the alignment skips below it
  skipFloor: number;
}

export const DEFAULT_CONTENT_ALIGNMENT: ContentAlignmentOptions = {
  spanMs: 30_000,
  audioWindowMs: 4 * 60_000,
  shortItemChars: 15,
  weakMatchThreshold: 0.5,
  skipFloor: 0.3,
};

export interface ContentAlignmentInput {
  slides: ExtractedSlide[];
  // Active sentences in audio order; their clockStartTimeMs is on the audio-relative timeline
  sentences: Sentence[];
  notesData: NotesDocument;
  abbreviationPairs: AbbreviationPair[];
  audioBounds?: { startMs: number; endMs: number };
  embeddings: EmbeddingProvider;
  options?: Partial<ContentAlignmentOptions>;
}

export interface ContentAlignmentResult {
  windows: AlignedWindow[];
  weakMatches: WeakMatch[];
  blockScores: BlockScore[];
}

type Span = { startMs: number; sentenceIds: string[]; text: string };
type NoteUnit = {
  id: string;
  isHeading: boolean;
  text: string;
  embedText: string;
};

function sentenceText(s: Sentence): string {
  return s.correctedText ?? s.text;
}

export function blockText(block: unknown): string {
  const b = block as { content?: unknown; children?: unknown[] };
  const parts: string[] = [];
  if (Array.isArray(b.content)) {
    for (const item of b.content) {
      const it = item as { type?: string; text?: string };
      if (it.type === "text" && typeof it.text === "string") parts.push(it.text);
    }
  }
  if (Array.isArray(b.children)) for (const child of b.children) parts.push(blockText(child));
  return parts.join(" ").trim();
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export function slideEmbeddingText(slide: ExtractedSlide): string {
  return [slide.title ?? "", ...slide.bullets.map((b) => b.text)].filter(Boolean).join("\n");
}

export function buildSpans(sentences: Sentence[], spanMs: number): Span[] {
  const spans: Span[] = [];
  let current: { startMs: number; sentences: Sentence[] } | null = null;
  for (const s of sentences) {
    if (current && s.clockStartTimeMs - current.startMs < spanMs) {
      current.sentences.push(s);
    } else {
      if (current) spans.push(toSpan(current));
      current = { startMs: s.clockStartTimeMs, sentences: [s] };
    }
  }
  if (current) spans.push(toSpan(current));
  return spans;
}

function toSpan(c: { startMs: number; sentences: Sentence[] }): Span {
  return {
    startMs: c.startMs,
    sentenceIds: c.sentences.map((s) => s.id),
    text: c.sentences.map(sentenceText).join(" "),
  };
}

// Top-level note blocks (the unit the merge judges), each with its heading path prefix.
function buildNoteUnits(notesData: NotesDocument, pairs: AbbreviationPair[]): NoteUnit[] {
  const units: NoteUnit[] = [];
  const path: Array<{ level: number; text: string }> = [];
  for (const block of notesData.blocks) {
    const b = block as { id: string; type?: string; props?: { level?: number } };
    const text = expandAbbreviations(blockText(block), pairs);
    const isHeading = b.type === "heading" && text.length > 0;
    if (isHeading) {
      const level = b.props?.level ?? 1;
      while (path.length > 0 && path[path.length - 1]!.level >= level) path.pop();
      path.push({ level, text });
    }
    // A heading's own path already ends with itself
    const prefix = path.map((h) => h.text);
    units.push({
      id: b.id,
      isHeading,
      text,
      embedText: isHeading ? prefix.join(" › ") : [...prefix, text].join(" › "),
    });
  }
  return units;
}

// Monotonic assignment with skips on both sides. gains[i][j] is the value of matching item i
// to target j; items are assigned non-decreasing targets, an item with no positive gain is
// left unassigned (null). Maximises the total gain.
export function monotonicAssign(gains: number[][], targetCount: number): Array<number | null> {
  const n = gains.length;
  const result: Array<number | null> = new Array(n).fill(null);
  if (n === 0 || targetCount === 0) return result;
  type Choice = "match" | "skip" | "left";
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(targetCount).fill(0));
  const choice: Choice[][] = Array.from({ length: n + 1 }, () => new Array<Choice>(targetCount).fill("skip"));
  for (let i = 1; i <= n; i++) {
    for (let j = 0; j < targetCount; j++) {
      const g = gains[i - 1]![j]!;
      const skipVal = dp[i - 1]![j]!;
      const matchVal = skipVal + g;
      const leftVal = j > 0 ? dp[i]![j - 1]! : -Infinity;
      const best = Math.max(skipVal, leftVal, g > 0 ? matchVal : -Infinity);
      dp[i]![j] = best;
      choice[i]![j] = g > 0 && matchVal >= best ? "match" : skipVal >= best ? "skip" : "left";
    }
  }
  let i = n;
  let j = targetCount - 1;
  while (i > 0 && j >= 0) {
    const c = choice[i]![j]!;
    if (c === "match") {
      result[i - 1] = j;
      i--;
    } else if (c === "skip") {
      i--;
    } else {
      j--;
    }
  }
  return result;
}

type WindowDraft = {
  mappedSlides: string[];
  startMs?: number;
  endMs?: number;
  slides: ExtractedSlide[];
};

function slideItems(slide: ExtractedSlide): string[] {
  return slide.bullets.length > 0 ? slide.bullets.map((b) => b.text) : [slideEmbeddingText(slide)].filter(Boolean);
}

// Content alignment (untimed notes): decides which slides, transcript sentences and note
// blocks belong to each window by embedding similarity, and returns the same AlignedWindow
// shape as time alignment. Pure: persists nothing (a provisional run can call it too).
export async function contentAlign(input: ContentAlignmentInput): Promise<ContentAlignmentResult> {
  const opts = { ...DEFAULT_CONTENT_ALIGNMENT, ...input.options };
  const { slides, embeddings } = input;
  const sentences = [...input.sentences].sort((a, b) => a.clockStartTimeMs - b.clockStartTimeMs);
  const spans = buildSpans(sentences, opts.spanMs);
  const units = buildNoteUnits(input.notesData, input.abbreviationPairs);

  const texts = new Set<string>();
  for (const u of units) if (u.text) texts.add(u.embedText);
  for (const sp of spans) texts.add(sp.text);
  for (const s of slides) {
    texts.add(slideEmbeddingText(s));
    for (const t of slideItems(s)) texts.add(t);
  }
  const textList = [...texts];
  const vectors = textList.length > 0 ? await embeddings.embed(textList) : [];
  const vec = new Map(textList.map((t, i) => [t, vectors[i]!]));
  const sim = (a: string, b: string): number => cosine(vec.get(a)!, vec.get(b)!);

  const hasSlides = slides.length > 0;
  const hasAudio = sentences.length > 0;
  const startOfLecture = input.audioBounds?.startMs ?? sentences[0]?.clockStartTimeMs ?? 0;
  const endOfLecture =
    input.audioBounds?.endMs ?? sentences[sentences.length - 1]?.clockEndTimeMs ?? startOfLecture;

  // 1. Windows
  const drafts: WindowDraft[] = [];
  if (hasSlides && hasAudio) {
    const gains = spans.map((sp) => slides.map((s) => sim(sp.text, slideEmbeddingText(s)) - opts.skipFloor));
    const spanSlide = monotonicAssign(gains, slides.length);
    const firstSpanOf = new Map<number, number>();
    spanSlide.forEach((slideIdx, spanIdx) => {
      if (slideIdx !== null && !firstSpanOf.has(slideIdx)) firstSpanOf.set(slideIdx, spans[spanIdx]!.startMs);
    });
    // Window k starts where its first matched span starts; a skipped slide gets an empty window
    // at the next matched boundary; the first window starts at the lecture start.
    const starts: number[] = new Array(slides.length).fill(endOfLecture);
    let next = endOfLecture;
    for (let k = slides.length - 1; k >= 0; k--) {
      next = firstSpanOf.get(k) ?? next;
      starts[k] = next;
    }
    starts[0] = startOfLecture;
    slides.forEach((slide, k) => {
      drafts.push({
        mappedSlides: [slide.id],
        slides: [slide],
        startMs: starts[k]!,
        endMs: k + 1 < slides.length ? starts[k + 1]! : endOfLecture,
      });
    });
  } else if (hasAudio) {
    const cuts: number[] = [startOfLecture];
    for (const s of sentences) {
      if (s.clockStartTimeMs - cuts[cuts.length - 1]! >= opts.audioWindowMs) cuts.push(s.clockStartTimeMs);
    }
    cuts.forEach((start, k) => {
      drafts.push({
        mappedSlides: [],
        slides: [],
        startMs: start,
        endMs: k + 1 < cuts.length ? cuts[k + 1]! : endOfLecture,
      });
    });
  } else {
    for (const slide of slides) drafts.push({ mappedSlides: [slide.id], slides: [slide] });
  }

  const windowCount = drafts.length;
  const timed = hasAudio;
  const inWindow = (draft: WindowDraft, k: number, startMs: number): boolean =>
    startMs >= draft.startMs! && (startMs < draft.endMs! || (k === windowCount - 1 && startMs <= draft.endMs!));

  // Sentences and spans belong to the window whose range holds their start
  const sentenceIdsByWindow: string[][] = drafts.map(() => []);
  const itemsByWindow: string[][] = drafts.map((d) => d.slides.flatMap(slideItems));
  if (timed) {
    for (const s of sentences) {
      const k = drafts.findIndex((d, idx) => inWindow(d, idx, s.clockStartTimeMs));
      if (k !== -1) sentenceIdsByWindow[k]!.push(s.id);
    }
    for (const sp of spans) {
      const k = drafts.findIndex((d, idx) => inWindow(d, idx, sp.startMs));
      if (k !== -1) itemsByWindow[k]!.push(sp.text);
    }
  }

  // 2. Note blocks to windows
  const blockWindowSim = (unit: NoteUnit, k: number): number =>
    itemsByWindow[k]!.reduce((best, item) => Math.max(best, sim(unit.embedText, item)), 0);

  const isFollower = (u: NoteUnit): boolean => u.isHeading || u.text.length < opts.shortItemChars;
  const matchable = units.filter((u) => !isFollower(u));
  const simMatrix = matchable.map((u) => drafts.map((_, k) => blockWindowSim(u, k)));
  const assignment = monotonicAssign(
    simMatrix.map((row) => row.map((s) => s - opts.skipFloor)),
    windowCount,
  );

  const placedWindow = new Map<string, number>(); // block id -> window index (DP-placed)
  matchable.forEach((u, i) => {
    if (assignment[i] !== null) placedWindow.set(u.id, assignment[i]!);
  });

  const nearestPlaced = (idx: number, direction: -1 | 1): number | undefined => {
    for (let i = idx + direction; i >= 0 && i < units.length; i += direction) {
      const w = placedWindow.get(units[i]!.id);
      if (w !== undefined) return w;
    }
    return undefined;
  };

  const blockWindow = new Map<string, number>();
  const weakMatches: WeakMatch[] = [];
  const blockScores: BlockScore[] = [];
  const weakIds = new Set<string>();
  units.forEach((u, idx) => {
    if (!u.text && !u.isHeading) {
      blockWindow.set(u.id, nearestPlaced(idx, -1) ?? nearestPlaced(idx, 1) ?? 0);
      return;
    }
    if (isFollower(u)) {
      // Headings introduce what follows; short items continue what precedes
      const w = u.isHeading
        ? (nearestPlaced(idx, 1) ?? nearestPlaced(idx, -1) ?? 0)
        : (nearestPlaced(idx, -1) ?? nearestPlaced(idx, 1) ?? 0);
      blockWindow.set(u.id, w);
      return;
    }
    const placed = placedWindow.get(u.id);
    const assigned = placed ?? nearestPlaced(idx, -1) ?? nearestPlaced(idx, 1) ?? 0;
    const row = simMatrix[matchable.indexOf(u)]!;
    const score = row[assigned] ?? 0;
    blockWindow.set(u.id, assigned);
    blockScores.push({ blockId: u.id, text: u.text, windowId: windowId(assigned), score, placed: placed !== undefined });
    if (placed === undefined || score < opts.weakMatchThreshold) {
      weakIds.add(u.id);
      const similarWindowIds = row
        .map((s, k) => ({ s, k }))
        .sort((a, b) => b.s - a.s || a.k - b.k)
        .slice(0, 3)
        .map(({ k }) => windowId(k));
      weakMatches.push({ blockId: u.id, score, windowId: windowId(assigned), similarWindowIds });
    }
  });

  // 3. Assemble the persisted shape; context is the neighbouring window on each side
  const blockIdsByWindow: string[][] = drafts.map(() => []);
  const weakByWindow: string[][] = drafts.map(() => []);
  for (const u of units) {
    const k = blockWindow.get(u.id)!;
    if (weakIds.has(u.id)) weakByWindow[k]!.push(u.id);
    else blockIdsByWindow[k]!.push(u.id);
  }

  const windows: AlignedWindow[] = drafts.map((d, k) => {
    const neighbours = [k - 1, k + 1].filter((n) => n >= 0 && n < windowCount);
    return {
      id: windowId(k),
      mappedSlides: d.mappedSlides,
      sentenceIds: sentenceIdsByWindow[k]!,
      blockIds: blockIdsByWindow[k]!,
      contextSentenceIds: neighbours.flatMap((n) => sentenceIdsByWindow[n]!),
      // The window's own blocks, its neighbours' blocks, and the weak matches assigned to
      // its neighbours (a weak match is not trusted as context for its own window)
      contextBlockIds: [
        ...blockIdsByWindow[k]!,
        ...neighbours.flatMap((n) => [...blockIdsByWindow[n]!, ...weakByWindow[n]!]),
      ],
      ...(d.startMs !== undefined ? { startMs: d.startMs, endMs: d.endMs } : {}),
    };
  });

  return { windows, weakMatches, blockScores };
}

export function windowId(index: number): string {
  return `W${String(index + 1).padStart(3, "0")}`;
}
