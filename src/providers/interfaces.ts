import type {
  TranscriptionResult,
  CoverageQuestion,
  ConflictQuestion,
  CoverageAnswers,
  ConflictAnswers,
  WritingOperation,
} from "../shared/types.js";

export class TranscriptionHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "TranscriptionHttpError";
    this.statusCode = statusCode;
  }
}

export class WritingModelHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "WritingModelHttpError";
    this.statusCode = statusCode;
  }
}

export class NotionHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "NotionHttpError";
    this.statusCode = statusCode;
  }
}

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
      // Conflict entries only: the cited pool items with their texts and source labels
      poolItems?: Array<{ id: string; text: string; label: "slide" | "transcript" }>;
    }>;
  }): Promise<WritingOperation[]>;
}

export interface NotionPage {
  id: string;
  title: string;
  url: string;
}

export interface NotionExportBlock {
  type: string;
  text: string;
  children: NotionExportBlock[];
}

export interface NotionProvider {
  getOAuthUrl(redirectUri: string, state: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }>;
  searchPages(accessToken: string, query: string): Promise<NotionPage[]>;
  createPage(accessToken: string, parentPageId: string | null, title: string): Promise<NotionPage>;
  getPage(accessToken: string, pageId: string): Promise<NotionPage | null>;
  createChildPage(
    accessToken: string,
    parentPageId: string,
    title: string,
    blocks: NotionExportBlock[],
  ): Promise<{ pageId: string; pageUrl: string }>;
}

export interface Providers {
  speechToText: SpeechToTextProvider;
  classifier: ClassifierProvider;
  writingModel: WritingModelProvider;
  notion: NotionProvider;
}
