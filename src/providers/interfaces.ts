import type {
  TranscriptionResult,
  CoverageQuestion,
  ConflictQuestion,
  CoverageAnswers,
  ConflictAnswers,
  WritingOperation,
} from "../shared/types.js";

export class ClassifierRetryableError extends Error {
  readonly statusCode: number;
  readonly retryAfterMs: number;

  constructor(statusCode: number, retryAfterMs: number, message: string) {
    super(message);
    this.name = "ClassifierRetryableError";
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface SpeechToTextProvider {
  transcribeChunk(chunkPath: string, prompt: string): Promise<TranscriptionResult>;
}

export interface ClassifierProvider {
  classifyCoverage(
    state: string,
    questions: CoverageQuestion[],
  ): Promise<CoverageAnswers>;
  checkConflicts(
    state: string,
    questions: ConflictQuestion[],
  ): Promise<ConflictAnswers>;
}

export interface WritingModelProvider {
  generateOperations(input: {
    sealedNotes: Array<{ id: string; text: string }>;
    windowRanges: Array<{ windowId: string; startMs: number; endMs: number }>;
    editList: Array<{
      id: string;
      type: string;
      windowId: string;
      sourceIds: string[];
      sourceText: string;
      noteId?: string;
      retrievedNoteIds?: string[];
    }>;
  }): Promise<WritingOperation[]>;
}

export interface NotionProvider {
  exportNote(
    note: { blocks: Array<{ id: string; text: string }> },
    subjectPageId: string,
  ): Promise<{ pageUrl: string }>;
}

export interface Providers {
  speechToText: SpeechToTextProvider;
  classifier: ClassifierProvider;
  writingModel: WritingModelProvider;
  notion: NotionProvider;
}
