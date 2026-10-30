export type NotesDocument = {
  blocks: unknown[];
  meta: Record<string, { firstEditTime?: number; lastEditTime?: number }>;
};

export const EMPTY_NOTES_DOCUMENT: NotesDocument = { blocks: [], meta: {} };

export type LectureStage =
  | "writing"
  | "sources"
  | "sealed"
  | "transcript-check"
  | "merge"
  | "review"
  | "exported";

export interface Lecture {
  id: string;
  userId: string;
  stage: LectureStage;
  subjectId: string | null;
  dataDir: string;
  notesData: string;
  presentationPath: string | null;
  notionPageUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Subject {
  id: string;
  name: string;
  userId: string;
  createdAt: number;
  glossaryTerms: string[];
  guiaDocente: string | null;
  notionParentPageId: string | null;
}

export interface User {
  id: string;
  createdAt: number;
}

export type WhisperSegment = {
  startMs: number;
  endMs: number;
  text: string;
  avgLogprob: number;
  noSpeechProb: number;
  compressionRatio: number;
};

export type TranscriptionResult = {
  segments: WhisperSegment[];
};

export type TranscriptRunState = "running" | "paused" | "done";

export interface TranscriptRun {
  id: string;
  lectureId: string;
  state: TranscriptRunState;
  model: string;
  failedChunkIds: string[];
  createdAt: number;
}

export type ChunkStatus = "pending" | "done" | "failed";
export type SentenceStatus = "active" | "retired";
export type SentenceFlagState = "unflagged" | "flagged_unhandled" | "corrected" | "advanced";

export interface Sentence {
  id: string;
  chunkId: string;
  audioStartOffsetMs: number;
  audioEndOffsetMs: number;
  clockStartTimeMs: number;
  clockEndTimeMs: number;
  textRaw: string;
  text: string;
  avgLogprob: number;
  noSpeechProb: number;
  compressionRatio: number;
  status: SentenceStatus;
  stitchedInto: string | null;
  flagState: SentenceFlagState;
  flagReasons: string[];
  correctedText: string | null;
}

export type CoverageLabel = "covered" | "partially_covered" | "missing" | "noise";
export type ConflictLabel = "supported" | "unsupported" | "conflicts";

export type CoverageQuestion = {
  key: string;
  sourceId: string;
  text: string;
};

export type ConflictQuestion = {
  key: string;
  noteBlockId: string;
  text: string;
};

export type CoverageAnswers = Record<string, { label: CoverageLabel; probability: number }>;
// evidenceIds: the pool item IDs that support a "conflicts" verdict
export type ConflictAnswers = Record<
  string,
  { label: ConflictLabel; probability: number; evidenceIds?: string[] }
>;

export type SlideMarker = {
  id: string;
  lectureId: string;
  timestamp: number;
  blockId: string;
};

export type WritingOperation =
  | { type: "add_after"; blockId: string; text: string; sourceIds: string[] }
  | { type: "add_at_window"; windowId: string; text: string; sourceIds: string[] }
  | { type: "rewrite"; blockId: string; text: string; sourceIds: string[] };

export interface AbbreviationPair {
  id: string;
  userId: string;
  abbreviation: string;
  expansion: string;
  matchCaseExactly: boolean;
  createdAt: number;
}

export interface UnknownToken {
  text: string;
  frequency: number;
}

export type SlideWindow = {
  id: string;
  startMs: number;
  endMs: number;
  mappedSlides: string[];
  blockIds: string[];
};

// Stored override entry (no blockIds — always recomputed from notes)
export type WindowOverride = {
  id: string;
  startMs: number;
  endMs: number;
  mappedSlides: string[];
};

export type AudioFile = {
  id: string;
  lectureId: string;
  fileIndex: number;
  filePath: string;
  recordingStartMs: number;
  durationMs: number;
  createdAt: number;
  transcriptionModel: string | null;
};

export type AudioChunk = {
  id: string;
  audioFileId: string;
  chunkIndex: number;
  filePath: string;
  startOffsetMs: number;
  durationMs: number;
  status: ChunkStatus;
  attempts: number;
  lastError: string | null;
  rawResponse: string | null;
};

export type MergeRunState = "pending" | "running" | "paused" | "haiku" | "done";

export interface MergeRun {
  id: string;
  lectureId: string;
  state: MergeRunState;
  failedWindowIds: string[];
  createdAt: number;
}

export type WindowResultStatus = "pending" | "done" | "failed";

export interface WindowResult {
  id: string;
  mergeRunId: string;
  windowId: string;
  coverageStatus: WindowResultStatus;
  coverageAttempts: number;
  coverageLastError: string | null;
  conflictStatus: WindowResultStatus;
  conflictAttempts: number;
  conflictLastError: string | null;
}

export interface Verdict {
  id: string;
  windowResultId: string;
  questionKey: string;
  chosenLabel: string;
  probability: number;
  confidence: number | null;
  effectiveLabel: string;
}

export type EditListEntryType = "missing" | "partial" | "conflict";

export interface EditListEntry {
  id: string;
  mergeRunId: string;
  type: EditListEntryType;
  windowId: string;
  sourceIds: string[];
  noteId: string | null;
  retrievedNoteIds: string[];
  sourceText: string;
}

export type OperationKind = "add_after" | "add_at_window" | "rewrite";
export type OperationStatus = "accepted" | "dropped";

export interface Operation {
  id: string;
  mergeRunId: string;
  entryId: string;
  kind: OperationKind;
  target: string;
  text: string;
  sourceIds: string[];
  status: OperationStatus;
  dropReason: string | null;
}

export type MergedBlockOrigin = "student" | "addition" | "partial_fix" | "conflict" | "fallback";
export type MergedBlockReviewState = "kept" | "reverted" | "unresolved" | "edited";

export interface Citation {
  sourceId: string;
  kind: "slide" | "transcript";
  text: string;
}

export interface MergedBlock {
  id: string;
  mergeRunId: string;
  position: number;
  windowId: string | null;
  origin: MergedBlockOrigin;
  noteId: string | null;
  text: string;
  originalText: string | null;
  proposedRewrite: string | null;
  citations: Citation[];
  modelPlaced: boolean;
  reviewState: MergedBlockReviewState | null;
  played: boolean;
  lowConfidence: boolean;
}
