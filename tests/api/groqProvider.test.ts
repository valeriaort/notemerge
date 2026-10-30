import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GroqSpeechToText } from "../../src/providers/groq.js";
import { TranscriptionHttpError } from "../../src/providers/interfaces.js";
import path from "path";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";

// Capture the multipart body as text for assertion
async function readableToText(body: unknown): Promise<string> {
  if (Buffer.isBuffer(body)) return body.toString();
  if (body instanceof Uint8Array) return Buffer.from(body).toString();
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString();
}

describe("GroqSpeechToText", () => {
  let tmpDir: string;
  let chunkPath: string;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "groq-test-"));
    chunkPath = path.join(tmpDir, "chunk.wav");
    // minimal wav-like file
    writeFileSync(chunkPath, Buffer.from("RIFF fake wav data"));

    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function groqVerboseResponse(segments: object[]) {
    return new Response(JSON.stringify({ segments }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("sends the correct model, language, and response_format fields", async () => {
    fetchSpy.mockResolvedValueOnce(groqVerboseResponse([]));

    const provider = new GroqSpeechToText("test-key");
    await provider.transcribeChunk(chunkPath, "");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { body: unknown }];
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(init.method).toBe("POST");

    const bodyText = await readableToText(init.body);
    expect(bodyText).toContain("whisper-large-v3");
    expect(bodyText).toContain('name="model"');
    expect(bodyText).toContain("es");
    expect(bodyText).toContain('name="language"');
    expect(bodyText).toContain("verbose_json");
    expect(bodyText).toContain('name="response_format"');
  });

  it("passes the prompt through when non-empty", async () => {
    fetchSpy.mockResolvedValueOnce(groqVerboseResponse([]));

    const provider = new GroqSpeechToText("test-key");
    await provider.transcribeChunk(chunkPath, "riñón hígado páncreas");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { body: unknown }];
    const bodyText = await readableToText(init.body);
    expect(bodyText).toContain("riñón hígado páncreas");
    expect(bodyText).toContain('name="prompt"');
  });

  it("omits prompt field when prompt is empty", async () => {
    fetchSpy.mockResolvedValueOnce(groqVerboseResponse([]));

    const provider = new GroqSpeechToText("test-key");
    await provider.transcribeChunk(chunkPath, "");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { body: unknown }];
    const bodyText = await readableToText(init.body);
    expect(bodyText).not.toContain('name="prompt"');
  });

  it("includes the file field in the multipart body", async () => {
    fetchSpy.mockResolvedValueOnce(groqVerboseResponse([]));

    const provider = new GroqSpeechToText("test-key");
    await provider.transcribeChunk(chunkPath, "");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { body: unknown }];
    const bodyText = await readableToText(init.body);
    expect(bodyText).toContain('name="file"');
    expect(bodyText).toContain("RIFF fake wav data");
  });

  it("sends Authorization header with Bearer key", async () => {
    fetchSpy.mockResolvedValueOnce(groqVerboseResponse([]));

    const provider = new GroqSpeechToText("sk-secret");
    await provider.transcribeChunk(chunkPath, "");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-secret");
  });

  it("maps verbose_json segments to WhisperSegment fields", async () => {
    fetchSpy.mockResolvedValueOnce(
      groqVerboseResponse([
        {
          start: 0.5,
          end: 3.2,
          text: "El riñón filtra.",
          avg_logprob: -0.45,
          no_speech_prob: 0.02,
          compression_ratio: 1.1,
        },
        {
          start: 3.5,
          end: 7.0,
          text: "La sangre circula.",
          avg_logprob: -0.8,
          no_speech_prob: 0.05,
          compression_ratio: 1.3,
        },
      ]),
    );

    const provider = new GroqSpeechToText("test-key");
    const result = await provider.transcribeChunk(chunkPath, "");

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toEqual({
      startMs: 500,
      endMs: 3200,
      text: "El riñón filtra.",
      avgLogprob: -0.45,
      noSpeechProb: 0.02,
      compressionRatio: 1.1,
    });
    expect(result.segments[1]).toEqual({
      startMs: 3500,
      endMs: 7000,
      text: "La sangre circula.",
      avgLogprob: -0.8,
      noSpeechProb: 0.05,
      compressionRatio: 1.3,
    });
  });

  it("returns empty segments when the response has none", async () => {
    fetchSpy.mockResolvedValueOnce(groqVerboseResponse([]));

    const provider = new GroqSpeechToText("test-key");
    const result = await provider.transcribeChunk(chunkPath, "");

    expect(result.segments).toEqual([]);
  });

  it("throws TranscriptionHttpError with status 401 on unauthorized", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    const provider = new GroqSpeechToText("bad-key");
    await expect(provider.transcribeChunk(chunkPath, "")).rejects.toMatchObject({
      name: "TranscriptionHttpError",
      statusCode: 401,
    });
  });

  it("throws TranscriptionHttpError with status 429 on rate limit", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Too Many Requests", { status: 429 }),
    );

    const provider = new GroqSpeechToText("test-key");
    await expect(provider.transcribeChunk(chunkPath, "")).rejects.toMatchObject({
      name: "TranscriptionHttpError",
      statusCode: 429,
    });
  });

  it("throws TranscriptionHttpError with status 500 on server error", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const provider = new GroqSpeechToText("test-key");
    await expect(provider.transcribeChunk(chunkPath, "")).rejects.toMatchObject({
      name: "TranscriptionHttpError",
      statusCode: 500,
    });
  });

  it("distinguishes 429 from 4xx (401) via statusCode", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    fetchSpy.mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));

    const provider = new GroqSpeechToText("test-key");

    let err401: TranscriptionHttpError | null = null;
    let err429: TranscriptionHttpError | null = null;

    try {
      await provider.transcribeChunk(chunkPath, "");
    } catch (e) {
      err401 = e as TranscriptionHttpError;
    }
    try {
      await provider.transcribeChunk(chunkPath, "");
    } catch (e) {
      err429 = e as TranscriptionHttpError;
    }

    expect(err401?.statusCode).toBe(401);
    expect(err429?.statusCode).toBe(429);
    expect(err401?.statusCode).not.toBe(err429?.statusCode);
  });

  it("uses the provided model name in the request", async () => {
    fetchSpy.mockResolvedValueOnce(groqVerboseResponse([]));

    const provider = new GroqSpeechToText("test-key", "whisper-large-v3-turbo");
    await provider.transcribeChunk(chunkPath, "");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { body: unknown }];
    const bodyText = await readableToText(init.body);
    expect(bodyText).toContain("whisper-large-v3-turbo");
  });
});

describe("createProviders", () => {
  it("uses GroqSpeechToText when groq.apiKey is set", async () => {
    const { createProviders } = await import("../../src/providers/index.js");
    const { GroqSpeechToText: GroqClass } = await import("../../src/providers/groq.js");
    const config = {
      groq: { apiKey: "real-key" },
      transcriptionModel: "whisper-large-v3",
    } as Parameters<typeof createProviders>[0];

    const providers = createProviders(config);
    expect(providers.speechToText).toBeInstanceOf(GroqClass);
  });

  it("uses FakeSpeechToText when groq.apiKey is empty", async () => {
    const { createProviders } = await import("../../src/providers/index.js");
    const { FakeSpeechToText } = await import("../../src/providers/fakes.js");
    const config = {
      groq: { apiKey: "" },
      transcriptionModel: "whisper-large-v3",
    } as Parameters<typeof createProviders>[0];

    const providers = createProviders(config);
    expect(providers.speechToText).toBeInstanceOf(FakeSpeechToText);
  });
});
