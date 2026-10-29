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
}

export interface User {
  id: string;
  createdAt: number;
}

export type TranscriptionResult = {
  sentences: TranscriptSentence[];
};

export type TranscriptSentence = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  flagged: boolean;
  avgLogprob: number;
  noSpeechProb: number;
  compressionRatio: number;
};

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
export type ConflictAnswers = Record<string, { label: ConflictLabel; probability: number }>;

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

export type AudioFile = {
  id: string;
  lectureId: string;
  fileIndex: number;
  filePath: string;
  recordingStartMs: number;
  durationMs: number;
  createdAt: number;
};

export type AudioChunk = {
  id: string;
  audioFileId: string;
  chunkIndex: number;
  filePath: string;
  startOffsetMs: number;
  durationMs: number;
};
