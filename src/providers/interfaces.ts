import type {
  TranscriptionResult,
  CoverageQuestion,
  ConflictQuestion,
  CoverageAnswers,
  ConflictAnswers,
  WritingOperation,
} from "../shared/types.js";

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
    editList: unknown[];
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
