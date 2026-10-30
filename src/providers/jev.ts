import type { ClassifierProvider } from "./interfaces.js";
import { ClassifierRetryableError } from "./interfaces.js";
import type {
  CoverageQuestion,
  ConflictQuestion,
  CoverageAnswers,
  ConflictAnswers,
  CoverageLabel,
  ConflictLabel,
} from "../shared/types.js";

const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_TOTAL_TOKENS = 64000;

interface JevQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

interface JevAnswerRaw {
  type: string;
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

interface JevResponse {
  answers: Record<string, JevAnswerRaw>;
  usage: { input_tokens: number; output_tokens: number };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function parseRetryAfter(header: string): number {
  const secs = parseFloat(header);
  if (!isNaN(secs)) return Math.round(secs * 1000);
  const date = Date.parse(header);
  if (!isNaN(date)) return Math.max(0, date - Date.now());
  return 0;
}

const COVERAGE_INSTRUCTIONS =
  "Classify how well the student's notes cover the following lecture source item.";

const COVERAGE_CRITERIA: Record<string, string> = {
  covered:
    "The notes contain the same fact as the source item. A paraphrase counts, and the notes may sit anywhere in the retrieved range.",
  partially_covered:
    "The notes contain the topic but lack a specific fact the source states (a name, number, cause, or relationship).",
  missing: "The fact appears nowhere in the retrieved notes.",
  noise:
    "The source item has no examinable subject content: class logistics, off-topic chatter, or transitional phrases. Exam hints, emphasis, clinical examples, mnemonics, and repeated facts are never noise.",
};

const CONFLICT_INSTRUCTIONS =
  "Classify whether this student note block conflicts with the lecture source material in the pool.";

const CONFLICT_CRITERIA: Record<string, string> = {
  supported: "The note block is supported by the source material in the pool.",
  unsupported:
    "The note block is not supported by the source material but does not contradict it.",
  conflicts: "The note block contradicts a source item in the pool.",
};

export class JevClassifier implements ClassifierProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async classifyCoverage(
    state: string,
    questions: CoverageQuestion[],
  ): Promise<CoverageAnswers> {
    const jevQuestions: [string, JevQuestion][] = questions.map((q) => [
      q.key,
      {
        type: "choice",
        instructions: `${COVERAGE_INSTRUCTIONS}\n\nSource item: ${q.text}`,
        criteria: COVERAGE_CRITERIA,
      },
    ]);

    const rawAnswers = await this.sendBatched(state, jevQuestions);

    const result: CoverageAnswers = {};
    for (const [key, answer] of Object.entries(rawAnswers)) {
      const label = answer.choice as CoverageLabel;
      result[key] = {
        label,
        probability: answer.probabilities[answer.choice] ?? 0,
      };
    }
    return result;
  }

  async checkConflicts(
    state: string,
    questions: ConflictQuestion[],
  ): Promise<ConflictAnswers> {
    const jevQuestions: [string, JevQuestion][] = questions.map((q) => [
      q.key,
      {
        type: "choice",
        instructions: `${CONFLICT_INSTRUCTIONS}\n\nNote block: ${q.text}`,
        criteria: CONFLICT_CRITERIA,
      },
    ]);

    const rawAnswers = await this.sendBatched(state, jevQuestions);

    const result: ConflictAnswers = {};
    for (const [key, answer] of Object.entries(rawAnswers)) {
      const label = answer.choice as ConflictLabel;
      result[key] = {
        label,
        probability: answer.probabilities[answer.choice] ?? 0,
      };
    }
    return result;
  }

  private async sendBatched(
    state: string,
    questions: [string, JevQuestion][],
  ): Promise<Record<string, JevAnswerRaw>> {
    if (questions.length === 0) return {};

    const stateTokens = estimateTokens(state);
    const batches: [string, JevQuestion][][] = [];
    let currentBatch: [string, JevQuestion][] = [];
    let currentBatchTokens = 0;

    for (const [key, question] of questions) {
      const qTokens = estimateTokens(JSON.stringify({ [key]: question }));
      if (
        currentBatch.length > 0 &&
        stateTokens + currentBatchTokens + qTokens > MAX_TOTAL_TOKENS
      ) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBatchTokens = 0;
      }
      currentBatch.push([key, question]);
      currentBatchTokens += qTokens;
    }
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    const results: Record<string, JevAnswerRaw> = {};
    for (const batch of batches) {
      const questionsMap: Record<string, JevQuestion> = {};
      for (const [key, q] of batch) {
        questionsMap[key] = q;
      }
      const batchAnswers = await this.sendRequest(state, questionsMap);
      Object.assign(results, batchAnswers);
    }
    return results;
  }

  private async sendRequest(
    state: string,
    questions: Record<string, JevQuestion>,
  ): Promise<Record<string, JevAnswerRaw>> {
    const response = await fetch(SYSTEM_ONE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, state, questions }),
    });

    if (!response.ok) {
      let message = response.statusText;
      try {
        const body = await response.text();
        if (body) message = body;
      } catch {
        // keep statusText
      }

      if (response.status === 429 || response.status >= 500) {
        const retryAfterHeader = response.headers.get("Retry-After");
        const retryAfterMs = retryAfterHeader ? parseRetryAfter(retryAfterHeader) : 0;
        throw new ClassifierRetryableError(response.status, retryAfterMs, message);
      }

      throw new Error(`Classifier error ${response.status}: ${message}`);
    }

    const data = (await response.json()) as JevResponse;
    return data.answers;
  }
}
