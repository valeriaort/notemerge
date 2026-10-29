import type {
  SpeechToTextProvider,
  ClassifierProvider,
  WritingModelProvider,
  NotionProvider,
  NotionPage,
  NotionExportBlock,
  Providers,
} from "./interfaces.js";
import { TranscriptionHttpError } from "./interfaces.js";
import type {
  TranscriptionResult,
  WhisperSegment,
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
    return { segments: [] };
  }
}

export class ScriptedSpeechToText implements SpeechToTextProvider {
  private segmentsByPath: Map<string, WhisperSegment[]> = new Map();
  private defaultSegments: WhisperSegment[] = [];
  public capturedPrompts: Array<{ chunkPath: string; prompt: string }> = [];

  // Global fail-first-N-calls support
  private failFirstNCalls = 0;
  private failStatusCode = 429;
  private callsMade = 0;

  // Per-path fail support
  private failsByPath: Map<string, { remaining: number; statusCode: number }> = new Map();

  setSegments(chunkPath: string, segments: WhisperSegment[]): void {
    this.segmentsByPath.set(chunkPath, segments);
  }

  setDefaultSegments(segments: WhisperSegment[]): void {
    this.defaultSegments = segments;
  }

  /** Fail the first `count` transcription calls with the given HTTP status code. */
  setFailCount(count: number, statusCode: number = 429): void {
    this.failFirstNCalls = count;
    this.failStatusCode = statusCode;
    this.callsMade = 0;
  }

  /** Fail `count` calls for a specific chunk path with the given HTTP status code. */
  setChunkFailCount(chunkPath: string, count: number, statusCode: number = 429): void {
    this.failsByPath.set(chunkPath, { remaining: count, statusCode });
  }

  async transcribeChunk(
    chunkPath: string,
    prompt: string,
  ): Promise<TranscriptionResult> {
    this.capturedPrompts.push({ chunkPath, prompt });

    // Per-path failures take priority
    const perPath = this.failsByPath.get(chunkPath);
    if (perPath && perPath.remaining > 0) {
      perPath.remaining--;
      throw new TranscriptionHttpError(perPath.statusCode, `HTTP ${perPath.statusCode}`);
    }

    this.callsMade++;
    if (this.callsMade <= this.failFirstNCalls) {
      throw new TranscriptionHttpError(this.failStatusCode, `HTTP ${this.failStatusCode}`);
    }
    const segments = this.segmentsByPath.get(chunkPath) ?? this.defaultSegments;
    return { segments };
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
  private conflictMap: ConflictAnswers = {};

  addCoverageAnswers(answers: CoverageAnswers): void {
    Object.assign(this.coverageMap, answers);
  }

  addConflictAnswers(answers: ConflictAnswers): void {
    Object.assign(this.conflictMap, answers);
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
    const result: ConflictAnswers = {};
    for (const q of questions) {
      result[q.key] = this.conflictMap[q.key] ?? { label: "supported", probability: 0.99 };
    }
    return result;
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
  getOAuthUrl(redirectUri: string, state: string): string {
    return `https://api.notion.com/v1/oauth/authorize?client_id=fake&redirect_uri=${redirectUri}&state=${state}`;
  }

  async exchangeCode(_code: string, _redirectUri: string): Promise<{ accessToken: string }> {
    return { accessToken: "fake-token" };
  }

  async searchPages(_accessToken: string, _query: string): Promise<NotionPage[]> {
    return [];
  }

  async createPage(_accessToken: string, _parentPageId: string | null, title: string): Promise<NotionPage> {
    return { id: "fake-page-id", title, url: "https://notion.so/fake-page" };
  }

  async getPage(_accessToken: string, pageId: string): Promise<NotionPage | null> {
    return { id: pageId, title: "Fake Page", url: "https://notion.so/fake-page" };
  }

  async createChildPage(
    _accessToken: string,
    _parentPageId: string,
    _title: string,
    _blocks: NotionExportBlock[],
  ): Promise<{ pageId: string; pageUrl: string }> {
    return { pageId: "fake-child-id", pageUrl: "https://notion.so/fake-child" };
  }
}

export class ScriptedNotion implements NotionProvider {
  private exchangeResult: { accessToken: string } = { accessToken: "scripted-token" };
  private searchResults: NotionPage[] = [];
  private createPageResult: NotionPage = { id: "new-page-id", title: "New Page", url: "https://notion.so/new" };
  private getPageResult: NotionPage | null = { id: "page-id", title: "Page", url: "https://notion.so/page" };
  private createChildPageResult: { pageId: string; pageUrl: string } = { pageId: "child-id", pageUrl: "https://notion.so/child" };
  private createChildPageError: Error | null = null;

  public capturedSearchQueries: string[] = [];
  public capturedCreatedPages: Array<{ parentPageId: string | null; title: string }> = [];
  public capturedChildPages: Array<{ parentPageId: string; title: string; blocks: NotionExportBlock[] }> = [];
  public capturedGetPageIds: string[] = [];

  setSearchResults(pages: NotionPage[]): void { this.searchResults = pages; }
  setGetPageResult(page: NotionPage | null): void { this.getPageResult = page; }
  setCreateChildPageResult(result: { pageId: string; pageUrl: string }): void { this.createChildPageResult = result; }
  setCreateChildPageError(error: Error | null): void { this.createChildPageError = error; }

  getOAuthUrl(redirectUri: string, state: string): string {
    return `https://api.notion.com/v1/oauth/authorize?fake=1&redirect_uri=${redirectUri}&state=${state}`;
  }

  async exchangeCode(_code: string, _redirectUri: string): Promise<{ accessToken: string }> {
    return this.exchangeResult;
  }

  async searchPages(_accessToken: string, query: string): Promise<NotionPage[]> {
    this.capturedSearchQueries.push(query);
    return this.searchResults;
  }

  async createPage(_accessToken: string, parentPageId: string | null, title: string): Promise<NotionPage> {
    this.capturedCreatedPages.push({ parentPageId, title });
    return { ...this.createPageResult, title };
  }

  async getPage(_accessToken: string, pageId: string): Promise<NotionPage | null> {
    this.capturedGetPageIds.push(pageId);
    return this.getPageResult;
  }

  async createChildPage(
    _accessToken: string,
    parentPageId: string,
    title: string,
    blocks: NotionExportBlock[],
  ): Promise<{ pageId: string; pageUrl: string }> {
    if (this.createChildPageError) throw this.createChildPageError;
    this.capturedChildPages.push({ parentPageId, title, blocks });
    return this.createChildPageResult;
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
