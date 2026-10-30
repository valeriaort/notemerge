import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JevClassifier, estimateTokens } from "../../src/providers/jev.js";
import { ClassifierRetryableError } from "../../src/providers/interfaces.js";
import type { CoverageQuestion, ConflictQuestion } from "../../src/shared/types.js";

describe("JevClassifier", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function jevResponse(answers: Record<string, unknown>) {
    return new Response(
      JSON.stringify({ answers, usage: { input_tokens: 100, output_tokens: 10 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // --- Request shape ---

  it("sends POST to the System One URL with Bearer key and model", async () => {
    fetchSpy.mockResolvedValueOnce(
      jevResponse({
        "coverage:T0": {
          type: "choice",
          choice: "covered",
          confidence: 0.9,
          probabilities: { covered: 0.9, partially_covered: 0.05, missing: 0.04, noise: 0.01 },
        },
      }),
    );

    const classifier = new JevClassifier("test-api-key", "jev-1.14.0");
    await classifier.classifyCoverage("some state", [
      { key: "coverage:T0", sourceId: "T0", text: "a fact" },
    ]);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-api-key",
    );
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("jev-1.14.0");
  });

  it("sends state and coverage questions with correct structure", async () => {
    const coverageAnswer = {
      type: "choice",
      choice: "covered",
      confidence: 0.9,
      probabilities: { covered: 0.85, partially_covered: 0.1, missing: 0.04, noise: 0.01 },
    };
    fetchSpy.mockResolvedValueOnce(jevResponse({ "coverage:A01-T0001": coverageAnswer }));

    const classifier = new JevClassifier("key", "jev-1.14.0");
    const questions: CoverageQuestion[] = [
      { key: "coverage:A01-T0001", sourceId: "A01-T0001", text: "El riñón filtra la sangre." },
    ];
    await classifier.classifyCoverage("Notes context here.", questions);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.state).toBe("Notes context here.");
    expect(body.questions).toHaveProperty("coverage:A01-T0001");
    const q = body.questions["coverage:A01-T0001"];
    expect(q.type).toBe("choice");
    expect(q.instructions).toContain("El riñón filtra la sangre.");
    expect(q.criteria).toHaveProperty("covered");
    expect(q.criteria).toHaveProperty("partially_covered");
    expect(q.criteria).toHaveProperty("missing");
    expect(q.criteria).toHaveProperty("noise");
  });

  it("sends state and conflict questions with correct structure", async () => {
    const conflictAnswer = {
      type: "choice",
      choice: "conflicts",
      confidence: 0.8,
      probabilities: { supported: 0.05, unsupported: 0.1, conflicts: 0.85 },
    };
    fetchSpy.mockResolvedValueOnce(jevResponse({ "conflict:N0012": conflictAnswer }));

    const classifier = new JevClassifier("key", "jev-1.14.0");
    const questions: ConflictQuestion[] = [
      { key: "conflict:N0012", noteBlockId: "N0012", text: "El riñón no filtra." },
    ];
    await classifier.checkConflicts("Pool context here.", questions);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.state).toBe("Pool context here.");
    expect(body.questions).toHaveProperty("conflict:N0012");
    const q = body.questions["conflict:N0012"];
    expect(q.type).toBe("choice");
    expect(q.instructions).toContain("El riñón no filtra.");
    expect(q.criteria).toHaveProperty("supported");
    expect(q.criteria).toHaveProperty("unsupported");
    expect(q.criteria).toHaveProperty("conflicts");
  });

  // --- Answer mapping ---

  it("maps coverage answer choice to label and picks probability for that choice", async () => {
    fetchSpy.mockResolvedValueOnce(
      jevResponse({
        "coverage:A01-T0001": {
          type: "choice",
          choice: "partially_covered",
          confidence: 0.7,
          probabilities: {
            covered: 0.1,
            partially_covered: 0.72,
            missing: 0.15,
            noise: 0.03,
          },
        },
      }),
    );

    const classifier = new JevClassifier("key", "jev-1.14.0");
    const result = await classifier.classifyCoverage("state", [
      { key: "coverage:A01-T0001", sourceId: "A01-T0001", text: "some fact" },
    ]);

    expect(result["coverage:A01-T0001"]).toEqual({
      label: "partially_covered",
      probability: 0.72,
    });
  });

  it("maps conflict answer choice to label and picks probability for that choice", async () => {
    fetchSpy.mockResolvedValueOnce(
      jevResponse({
        "conflict:N0012": {
          type: "choice",
          choice: "conflicts",
          confidence: 0.85,
          probabilities: { supported: 0.05, unsupported: 0.1, conflicts: 0.85 },
        },
      }),
    );

    const classifier = new JevClassifier("key", "jev-1.14.0");
    const result = await classifier.checkConflicts("state", [
      { key: "conflict:N0012", noteBlockId: "N0012", text: "wrong claim" },
    ]);

    expect(result["conflict:N0012"]).toEqual({ label: "conflicts", probability: 0.85 });
  });

  it("returns empty answers when no questions are given", async () => {
    const classifier = new JevClassifier("key", "jev-1.14.0");
    const coverage = await classifier.classifyCoverage("state", []);
    const conflicts = await classifier.checkConflicts("state", []);
    expect(coverage).toEqual({});
    expect(conflicts).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("merges answers from multiple questions in one response", async () => {
    fetchSpy.mockResolvedValueOnce(
      jevResponse({
        "coverage:A01-T0001": {
          type: "choice",
          choice: "covered",
          confidence: 0.9,
          probabilities: { covered: 0.9, partially_covered: 0.05, missing: 0.04, noise: 0.01 },
        },
        "coverage:A01-T0002": {
          type: "choice",
          choice: "missing",
          confidence: 0.8,
          probabilities: { covered: 0.05, partially_covered: 0.1, missing: 0.8, noise: 0.05 },
        },
      }),
    );

    const classifier = new JevClassifier("key", "jev-1.14.0");
    const result = await classifier.classifyCoverage("state", [
      { key: "coverage:A01-T0001", sourceId: "A01-T0001", text: "fact one" },
      { key: "coverage:A01-T0002", sourceId: "A01-T0002", text: "fact two" },
    ]);

    expect(result["coverage:A01-T0001"].label).toBe("covered");
    expect(result["coverage:A01-T0002"].label).toBe("missing");
  });

  // --- Question splitting ---

  it("splits coverage questions into multiple requests when total tokens exceed 64k", async () => {
    // State that uses ~32k tokens (128k chars)
    const bigState = "s".repeat(128000);
    // Each question contributes ~8k tokens (32k chars), so 5 questions = 40k > remaining 32k
    const bigText = "q".repeat(32000);

    const questions: CoverageQuestion[] = Array.from({ length: 5 }, (_, i) => ({
      key: `coverage:T${i}`,
      sourceId: `T${i}`,
      text: bigText,
    }));

    // State tokens ≈ 32000; each question tokens > 8000
    // Two questions would exceed 32k remaining, so we expect multiple fetch calls
    for (let i = 0; i < 10; i++) {
      fetchSpy.mockResolvedValueOnce(
        jevResponse(
          Object.fromEntries(
            questions.slice(0, 5).map((q) => [
              q.key,
              {
                type: "choice",
                choice: "covered",
                confidence: 0.9,
                probabilities: { covered: 0.9, partially_covered: 0.05, missing: 0.04, noise: 0.01 },
              },
            ]),
          ),
        ),
      );
    }

    const classifier = new JevClassifier("key", "jev-1.14.0");
    await classifier.classifyCoverage(bigState, questions);

    // Should have made more than one fetch call due to splitting
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);

    // Each request should have a subset of all question keys
    const allKeys = new Set<string>();
    for (const [, init] of fetchSpy.mock.calls as [string, RequestInit][]) {
      const body = JSON.parse(init.body as string);
      for (const key of Object.keys(body.questions)) {
        expect(allKeys.has(key)).toBe(false); // no duplicates across batches
        allKeys.add(key);
      }
    }
    // All questions should appear exactly once
    expect(allKeys.size).toBe(questions.length);
  });

  it("keeps all questions in a single request when total tokens are under 64k", async () => {
    fetchSpy.mockResolvedValueOnce(
      jevResponse({
        "coverage:T0": {
          type: "choice",
          choice: "covered",
          confidence: 0.9,
          probabilities: { covered: 0.9, partially_covered: 0.05, missing: 0.04, noise: 0.01 },
        },
        "coverage:T1": {
          type: "choice",
          choice: "missing",
          confidence: 0.8,
          probabilities: { covered: 0.1, partially_covered: 0.05, missing: 0.8, noise: 0.05 },
        },
      }),
    );

    const classifier = new JevClassifier("key", "jev-1.14.0");
    const questions: CoverageQuestion[] = [
      { key: "coverage:T0", sourceId: "T0", text: "short fact" },
      { key: "coverage:T1", sourceId: "T1", text: "another fact" },
    ];
    await classifier.classifyCoverage("small state", questions);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body.questions)).toHaveLength(2);
  });

  // --- Error handling ---

  it("throws ClassifierRetryableError with statusCode 429 on rate limit", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));

    const classifier = new JevClassifier("key", "jev-1.14.0");
    await expect(
      classifier.classifyCoverage("state", [
        { key: "coverage:T0", sourceId: "T0", text: "fact" },
      ]),
    ).rejects.toMatchObject({
      name: "ClassifierRetryableError",
      statusCode: 429,
    });
  });

  it("throws ClassifierRetryableError with statusCode 500 on server error", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

    const classifier = new JevClassifier("key", "jev-1.14.0");
    await expect(
      classifier.classifyCoverage("state", [
        { key: "coverage:T0", sourceId: "T0", text: "fact" },
      ]),
    ).rejects.toMatchObject({
      name: "ClassifierRetryableError",
      statusCode: 500,
    });
  });

  it("throws ClassifierRetryableError with statusCode 529 on overload", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Overloaded", { status: 529 }));

    const classifier = new JevClassifier("key", "jev-1.14.0");
    await expect(
      classifier.classifyCoverage("state", [
        { key: "coverage:T0", sourceId: "T0", text: "fact" },
      ]),
    ).rejects.toMatchObject({
      name: "ClassifierRetryableError",
      statusCode: 529,
    });
  });

  it("parses Retry-After seconds header into retryAfterMs", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
    );

    const classifier = new JevClassifier("key", "jev-1.14.0");
    let err: ClassifierRetryableError | null = null;
    try {
      await classifier.classifyCoverage("state", [
        { key: "coverage:T0", sourceId: "T0", text: "fact" },
      ]);
    } catch (e) {
      err = e as ClassifierRetryableError;
    }

    expect(err?.statusCode).toBe(429);
    expect(err?.retryAfterMs).toBe(30000);
  });

  it("throws a non-retryable error on 401", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

    const classifier = new JevClassifier("key", "jev-1.14.0");
    await expect(
      classifier.classifyCoverage("state", [
        { key: "coverage:T0", sourceId: "T0", text: "fact" },
      ]),
    ).rejects.not.toMatchObject({ name: "ClassifierRetryableError" });
  });

  it("throws a non-retryable error on 422", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Unprocessable Entity", { status: 422 }));

    const classifier = new JevClassifier("key", "jev-1.14.0");
    await expect(
      classifier.classifyCoverage("state", [
        { key: "coverage:T0", sourceId: "T0", text: "fact" },
      ]),
    ).rejects.not.toMatchObject({ name: "ClassifierRetryableError" });
  });

  it("distinguishes retryable (429) from non-retryable (401) by error name", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    fetchSpy.mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));

    const classifier = new JevClassifier("key", "jev-1.14.0");

    let err401: Error | null = null;
    let err429: Error | null = null;
    try {
      await classifier.classifyCoverage("state", [
        { key: "coverage:T0", sourceId: "T0", text: "fact" },
      ]);
    } catch (e) {
      err401 = e as Error;
    }
    try {
      await classifier.classifyCoverage("state", [
        { key: "coverage:T0", sourceId: "T0", text: "fact" },
      ]);
    } catch (e) {
      err429 = e as Error;
    }

    expect(err401?.name).not.toBe("ClassifierRetryableError");
    expect(err429?.name).toBe("ClassifierRetryableError");
  });
});

describe("createProviders (classifier slot)", () => {
  it("uses JevClassifier when jev.apiKey is set", async () => {
    const { createProviders } = await import("../../src/providers/index.js");
    const { JevClassifier: JevClass } = await import("../../src/providers/jev.js");
    const config = {
      groq: { apiKey: "" },
      jev: { apiKey: "real-jev-key", model: "jev-1.14.0" },
      haiku: { apiKey: "" },
      notion: { clientId: "", clientSecret: "" },
      transcriptionModel: "whisper-large-v3",
    } as Parameters<typeof createProviders>[0];

    const providers = createProviders(config);
    expect(providers.classifier).toBeInstanceOf(JevClass);
  });

  it("uses FakeClassifier when jev.apiKey is empty", async () => {
    const { createProviders } = await import("../../src/providers/index.js");
    const { FakeClassifier } = await import("../../src/providers/fakes.js");
    const config = {
      groq: { apiKey: "" },
      jev: { apiKey: "", model: "jev-1.14.0" },
      haiku: { apiKey: "" },
      notion: { clientId: "", clientSecret: "" },
      transcriptionModel: "whisper-large-v3",
    } as Parameters<typeof createProviders>[0];

    const providers = createProviders(config);
    expect(providers.classifier).toBeInstanceOf(FakeClassifier);
  });
});
