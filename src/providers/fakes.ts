import type {
  SpeechToTextProvider,
  ClassifierProvider,
  WritingModelProvider,
  NotionProvider,
  Providers,
} from "./interfaces.js";
import type {
  TranscriptionResult,
  CoverageQuestion,
  ConflictQuestion,
  CoverageAnswers,
  ConflictAnswers,
  WritingOperation,
} from "../shared/types.js";

export class FakeSpeechToText implements SpeechToTextProvider {
  async transcribeChunk(
    _chunkPath: string,
    _prompt: string,
  ): Promise<TranscriptionResult> {
    return { sentences: [] };
  }
}

export class FakeClassifier implements ClassifierProvider {
  async classifyCoverage(
    _state: string,
    questions: CoverageQuestion[],
  ): Promise<CoverageAnswers> {
    const answers: CoverageAnswers = {};
    for (const q of questions) {
      answers[q.key] = { label: "covered", probability: 0.99 };
    }
    return answers;
  }

  async checkConflicts(
    _state: string,
    questions: ConflictQuestion[],
  ): Promise<ConflictAnswers> {
    const answers: ConflictAnswers = {};
    for (const q of questions) {
      answers[q.key] = { label: "supported", probability: 0.99 };
    }
    return answers;
  }
}

export class FakeWritingModel implements WritingModelProvider {
  async generateOperations(_input: {
    sealedNotes: Array<{ id: string; text: string }>;
    windowRanges: Array<{ windowId: string; startMs: number; endMs: number }>;
    editList: unknown[];
  }): Promise<WritingOperation[]> {
    return [];
  }
}

export class ScriptedClassifier implements ClassifierProvider {
  private coverageMap: CoverageAnswers = {};

  addCoverageAnswers(answers: CoverageAnswers): void {
    Object.assign(this.coverageMap, answers);
  }

  async classifyCoverage(
    _state: string,
    questions: CoverageQuestion[],
  ): Promise<CoverageAnswers> {
    const result: CoverageAnswers = {};
    for (const q of questions) {
      result[q.key] = this.coverageMap[q.key] ?? { label: "covered", probability: 0.99 };
    }
    return result;
  }

  async checkConflicts(
    _state: string,
    questions: ConflictQuestion[],
  ): Promise<ConflictAnswers> {
    const answers: ConflictAnswers = {};
    for (const q of questions) {
      answers[q.key] = { label: "supported", probability: 0.99 };
    }
    return answers;
  }
}

export class ScriptedWritingModel implements WritingModelProvider {
  private ops: WritingOperation[] = [];

  setOperations(ops: WritingOperation[]): void {
    this.ops = [...ops];
  }

  async generateOperations(_input: unknown): Promise<WritingOperation[]> {
    return this.ops;
  }
}

export class FakeNotion implements NotionProvider {
  async exportNote(
    _note: { blocks: Array<{ id: string; text: string }> },
    _subjectPageId: string,
  ): Promise<{ pageUrl: string }> {
    return { pageUrl: "https://notion.so/fake-page" };
  }
}

export function createFakeProviders(): Providers {
  return {
    speechToText: new FakeSpeechToText(),
    classifier: new FakeClassifier(),
    writingModel: new FakeWritingModel(),
    notion: new FakeNotion(),
  };
}
