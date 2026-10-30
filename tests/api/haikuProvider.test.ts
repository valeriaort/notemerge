import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicWritingModel } from "../../src/providers/haiku.js";
import { WritingModelHttpError } from "../../src/providers/interfaces.js";

const MINIMAL_INPUT = {
  sealedNotes: [{ id: "B01", text: "riñón filtra sangre" }],
  windowRanges: [{ windowId: "W01", startMs: 0, endMs: 60000 }],
  editList: [
    {
      id: "E01",
      type: "missing",
      windowId: "W01",
      sourceIds: ["S013-B02"],
      sourceText: "El riñón produce eritropoyetina.",
    },
  ],
};

function toolUseResponse(operations: object[]) {
  return new Response(
    JSON.stringify({
      content: [
        {
          type: "tool_use",
          name: "write_operations",
          input: { operations },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("AnthropicWritingModel", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // --- request shape ---

  it("sends a POST to the Anthropic messages endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(toolUseResponse([]));
    await new AnthropicWritingModel("test-key").generateOperations(MINIMAL_INPUT);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
  });

  it("sends x-api-key and anthropic-version headers", async () => {
    fetchSpy.mockResolvedValueOnce(toolUseResponse([]));
    await new AnthropicWritingModel("sk-secret").generateOperations(MINIMAL_INPUT);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-secret");
    expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
  });

  it("sends the default model claude-haiku-5-5 in the request body", async () => {
    fetchSpy.mockResolvedValueOnce(toolUseResponse([]));
    await new AnthropicWritingModel("test-key").generateOperations(MINIMAL_INPUT);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("claude-haiku-5-5");
  });

  it("uses the configured model when one is provided", async () => {
    fetchSpy.mockResolvedValueOnce(toolUseResponse([]));
    await new AnthropicWritingModel("test-key", "claude-haiku-4-5").generateOperations(MINIMAL_INPUT);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("claude-haiku-4-5");
  });

  it("includes a system prompt in the request body", async () => {
    fetchSpy.mockResolvedValueOnce(toolUseResponse([]));
    await new AnthropicWritingModel("test-key").generateOperations(MINIMAL_INPUT);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { system: string };
    expect(typeof body.system).toBe("string");
    expect(body.system.length).toBeGreaterThan(0);
  });

  it("includes a write_operations tool in the request", async () => {
    fetchSpy.mockResolvedValueOnce(toolUseResponse([]));
    await new AnthropicWritingModel("test-key").generateOperations(MINIMAL_INPUT);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { tools: Array<{ name: string }> };
    expect(body.tools).toBeInstanceOf(Array);
    const tool = body.tools.find((t) => t.name === "write_operations");
    expect(tool).toBeDefined();
  });

  it("includes tool_choice in the request", async () => {
    fetchSpy.mockResolvedValueOnce(toolUseResponse([]));
    await new AnthropicWritingModel("test-key").generateOperations(MINIMAL_INPUT);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { tool_choice: object };
    expect(body.tool_choice).toBeDefined();
  });

  // --- response parsing ---

  it("parses an add_after operation from the tool response", async () => {
    fetchSpy.mockResolvedValueOnce(
      toolUseResponse([
        { type: "add_after", blockId: "B01", text: "produce eritropoyetina", sourceIds: ["S013-B02"] },
      ]),
    );
    const ops = await new AnthropicWritingModel("test-key").generateOperations(MINIMAL_INPUT);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      type: "add_after",
      blockId: "B01",
      text: "produce eritropoyetina",
      sourceIds: ["S013-B02"],
    });
  });

  it("parses an add_at_window operation from the tool response", async () => {
    fetchSpy.mockResolvedValueOnce(
      toolUseResponse([
        { type: "add_at_window", windowId: "W01", text: "eritropoyetina", sourceIds: ["S013-B02"] },
      ]),
    );
    const ops = await new AnthropicWritingModel("test-key").generateOperations(MINIMAL_INPUT);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      type: "add_at_window",
      windowId: "W01",
      text: "eritropoyetina",
      sourceIds: ["S013-B02"],
    });
  });

  it("parses a rewrite operation from the tool response", async () => {
    fetchSpy.mockResolvedValueOnce(
      toolUseResponse([
        { type: "rewrite", blockId: "B01", text: "filtrado glomerular", sourceIds: ["S013-B03"] },
      ]),
    );
    const ops = await new AnthropicWritingModel("test-key").generateOperations(MINIMAL_INPUT);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      type: "rewrite",
      blockId: "B01",
      text: "filtrado glomerular",
      sourceIds: ["S013-B03"],
    });
  });

  // --- malformed output handling ---

  it("returns empty array when no tool_use block is present", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "I'll add a note." }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const ops = await new AnthropicWritingModel("test-key").generateOperations(MINIMAL_INPUT);
    expect(ops).toEqual([]);
  });

  it("returns empty array when operations array is missing", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ type: "tool_use", name: "write_operations", input: {} }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const ops = await new AnthropicWritingModel("test-key").generateOperations(MINIMAL_INPUT);
    expect(ops).toEqual([]);
  });

  it("drops operations with an unrecognised type and keeps valid ones", async () => {
    fetchSpy.mockResolvedValueOnce(
      toolUseResponse([
        { type: "invalid_type", blockId: "B01", text: "x", sourceIds: ["S1"] },
        { type: "add_after", blockId: "B01", text: "válido", sourceIds: ["S013-B02"] },
      ]),
    );
    const ops = await new AnthropicWritingModel("test-key").generateOperations(MINIMAL_INPUT);
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("add_after");
  });

  it("drops add_after operations missing blockId", async () => {
    fetchSpy.mockResolvedValueOnce(
      toolUseResponse([
        { type: "add_after", text: "sin blockId", sourceIds: ["S1"] },
      ]),
    );
    const ops = await new AnthropicWritingModel("test-key").generateOperations(MINIMAL_INPUT);
    expect(ops).toEqual([]);
  });

  it("drops add_at_window operations missing windowId", async () => {
    fetchSpy.mockResolvedValueOnce(
      toolUseResponse([
        { type: "add_at_window", text: "sin windowId", sourceIds: ["S1"] },
      ]),
    );
    const ops = await new AnthropicWritingModel("test-key").generateOperations(MINIMAL_INPUT);
    expect(ops).toEqual([]);
  });

  // --- HTTP error propagation ---

  it("throws WritingModelHttpError with statusCode 401 on unauthorized", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    await expect(
      new AnthropicWritingModel("bad-key").generateOperations(MINIMAL_INPUT),
    ).rejects.toMatchObject({ name: "WritingModelHttpError", statusCode: 401 });
  });

  it("throws WritingModelHttpError with statusCode 429 on rate limit", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));
    await expect(
      new AnthropicWritingModel("test-key").generateOperations(MINIMAL_INPUT),
    ).rejects.toMatchObject({ name: "WritingModelHttpError", statusCode: 429 });
  });

  it("throws WritingModelHttpError with statusCode 500 on server error", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));
    await expect(
      new AnthropicWritingModel("test-key").generateOperations(MINIMAL_INPUT),
    ).rejects.toMatchObject({ name: "WritingModelHttpError", statusCode: 500 });
  });

  it("distinguishes 401 from 429 via statusCode", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    fetchSpy.mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));
    const provider = new AnthropicWritingModel("test-key");

    let err401: WritingModelHttpError | null = null;
    let err429: WritingModelHttpError | null = null;
    try {
      await provider.generateOperations(MINIMAL_INPUT);
    } catch (e) {
      err401 = e as WritingModelHttpError;
    }
    try {
      await provider.generateOperations(MINIMAL_INPUT);
    } catch (e) {
      err429 = e as WritingModelHttpError;
    }
    expect(err401?.statusCode).toBe(401);
    expect(err429?.statusCode).toBe(429);
  });
});

describe("createProviders - writing model selection", () => {
  it("uses AnthropicWritingModel when haiku.apiKey is set", async () => {
    const { createProviders } = await import("../../src/providers/index.js");
    const { AnthropicWritingModel: HaikuClass } = await import("../../src/providers/haiku.js");
    const config = {
      groq: { apiKey: "" },
      haiku: { apiKey: "real-key" },
      transcriptionModel: "whisper-large-v3",
    } as Parameters<typeof createProviders>[0];
    const providers = createProviders(config);
    expect(providers.writingModel).toBeInstanceOf(HaikuClass);
  });

  it("uses FakeWritingModel when haiku.apiKey is empty", async () => {
    const { createProviders } = await import("../../src/providers/index.js");
    const { FakeWritingModel } = await import("../../src/providers/fakes.js");
    const config = {
      groq: { apiKey: "" },
      haiku: { apiKey: "" },
      transcriptionModel: "whisper-large-v3",
    } as Parameters<typeof createProviders>[0];
    const providers = createProviders(config);
    expect(providers.writingModel).toBeInstanceOf(FakeWritingModel);
  });
});
