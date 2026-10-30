import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RealNotionProvider } from "../../src/providers/notion.js";
import { NotionHttpError } from "../../src/providers/interfaces.js";
import type { NotionExportBlock } from "../../src/providers/interfaces.js";

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test-client-secret";
const ACCESS_TOKEN = "test-access-token";
const REDIRECT_URI = "http://localhost:3000/api/notion/callback";

describe("RealNotionProvider", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function okJson(data: unknown): Response {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function notionPageResult(id: string, title: string, url: string) {
    return {
      id,
      url,
      object: "page",
      properties: { title: { title: [{ plain_text: title }] } },
    };
  }

  // --- getOAuthUrl ---

  describe("getOAuthUrl", () => {
    it("returns authorization URL with client_id, response_type, redirect_uri, owner, and state", () => {
      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const url = provider.getOAuthUrl(REDIRECT_URI, "random-state-123");

      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
      expect(parsed.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
      expect(parsed.searchParams.get("owner")).toBe("user");
      expect(parsed.searchParams.get("state")).toBe("random-state-123");
    });

    it("encodes different client IDs correctly", () => {
      const provider = new RealNotionProvider("other-client", CLIENT_SECRET);
      const url = provider.getOAuthUrl(REDIRECT_URI, "s");
      expect(new URL(url).searchParams.get("client_id")).toBe("other-client");
    });
  });

  // --- exchangeCode ---

  describe("exchangeCode", () => {
    it("posts to /v1/oauth/token with Basic auth, grant_type, code, redirect_uri", async () => {
      fetchSpy.mockResolvedValueOnce(okJson({ access_token: "new-token" }));

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const result = await provider.exchangeCode("auth-code-123", REDIRECT_URI);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string>; body: string }];
      expect(url).toBe("https://api.notion.com/v1/oauth/token");
      expect(init.method).toBe("POST");

      const expectedCreds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
      expect(init.headers["Authorization"]).toBe(`Basic ${expectedCreds}`);
      expect(init.headers["Notion-Version"]).toBe("2022-06-28");

      const body = JSON.parse(init.body) as Record<string, string>;
      expect(body.grant_type).toBe("authorization_code");
      expect(body.code).toBe("auth-code-123");
      expect(body.redirect_uri).toBe(REDIRECT_URI);

      expect(result.accessToken).toBe("new-token");
    });

    it("maps access_token from response to accessToken", async () => {
      fetchSpy.mockResolvedValueOnce(okJson({ access_token: "tok-abc" }));
      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const result = await provider.exchangeCode("code", REDIRECT_URI);
      expect(result.accessToken).toBe("tok-abc");
    });

    it("throws NotionHttpError with status 401 on invalid credentials", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      await expect(provider.exchangeCode("bad-code", REDIRECT_URI)).rejects.toMatchObject({
        name: "NotionHttpError",
        statusCode: 401,
      });
    });

    it("throws NotionHttpError with status 429 on rate limit", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));
      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      await expect(provider.exchangeCode("code", REDIRECT_URI)).rejects.toMatchObject({
        name: "NotionHttpError",
        statusCode: 429,
      });
    });

    it("throws NotionHttpError with status 500 on server error", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));
      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      await expect(provider.exchangeCode("code", REDIRECT_URI)).rejects.toMatchObject({
        name: "NotionHttpError",
        statusCode: 500,
      });
    });
  });

  // --- searchPages ---

  describe("searchPages", () => {
    it("posts to /v1/search with query and page filter", async () => {
      fetchSpy.mockResolvedValueOnce(okJson({ results: [] }));

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      await provider.searchPages(ACCESS_TOKEN, "Anatomy");

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string>; body: string }];
      expect(url).toBe("https://api.notion.com/v1/search");
      expect(init.method).toBe("POST");
      expect(init.headers["Authorization"]).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(init.headers["Notion-Version"]).toBe("2022-06-28");

      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.query).toBe("Anatomy");
      expect(body.filter).toEqual({ value: "page", property: "object" });
    });

    it("maps results to NotionPage objects", async () => {
      fetchSpy.mockResolvedValueOnce(
        okJson({
          results: [
            notionPageResult("page-1", "Anatomy 101", "https://notion.so/anatomy"),
            notionPageResult("page-2", "Physiology", "https://notion.so/physiology"),
          ],
        }),
      );

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const pages = await provider.searchPages(ACCESS_TOKEN, "");

      expect(pages).toHaveLength(2);
      expect(pages[0]).toEqual({ id: "page-1", title: "Anatomy 101", url: "https://notion.so/anatomy" });
      expect(pages[1]).toEqual({ id: "page-2", title: "Physiology", url: "https://notion.so/physiology" });
    });

    it("returns empty array when no results", async () => {
      fetchSpy.mockResolvedValueOnce(okJson({ results: [] }));
      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const pages = await provider.searchPages(ACCESS_TOKEN, "nothing");
      expect(pages).toHaveLength(0);
    });

    it("throws NotionHttpError with status 401 on expired token", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      await expect(provider.searchPages(ACCESS_TOKEN, "q")).rejects.toMatchObject({
        name: "NotionHttpError",
        statusCode: 401,
      });
    });

    it("throws NotionHttpError with status 429 on rate limit", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));
      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      await expect(provider.searchPages(ACCESS_TOKEN, "q")).rejects.toMatchObject({
        name: "NotionHttpError",
        statusCode: 429,
      });
    });
  });

  // --- createPage ---

  describe("createPage", () => {
    it("posts to /v1/pages with page_id parent and title property", async () => {
      fetchSpy.mockResolvedValueOnce(okJson(notionPageResult("new-id", "My Page", "https://notion.so/my-page")));

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const page = await provider.createPage(ACCESS_TOKEN, "parent-id", "My Page");

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string>; body: string }];
      expect(url).toBe("https://api.notion.com/v1/pages");
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.parent).toEqual({ type: "page_id", page_id: "parent-id" });
      expect((body.properties as Record<string, unknown>).title).toBeDefined();

      expect(page).toEqual({ id: "new-id", title: "My Page", url: "https://notion.so/my-page" });
    });

    it("uses workspace parent when parentPageId is null", async () => {
      fetchSpy.mockResolvedValueOnce(okJson(notionPageResult("root-id", "Root Page", "https://notion.so/root")));

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      await provider.createPage(ACCESS_TOKEN, null, "Root Page");

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { body: string }];
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body.parent).toEqual({ type: "workspace", workspace: true });
    });

    it("throws NotionHttpError with status 403 when parent is not shared", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      await expect(provider.createPage(ACCESS_TOKEN, "unshared-parent", "Title")).rejects.toMatchObject({
        name: "NotionHttpError",
        statusCode: 403,
      });
    });

    it("throws NotionHttpError on 5xx errors", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Server Error", { status: 502 }));
      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      await expect(provider.createPage(ACCESS_TOKEN, "parent-id", "Title")).rejects.toMatchObject({
        name: "NotionHttpError",
        statusCode: 502,
      });
    });
  });

  // --- getPage ---

  describe("getPage", () => {
    it("fetches GET /v1/pages/:id with Bearer token", async () => {
      fetchSpy.mockResolvedValueOnce(okJson(notionPageResult("page-id", "Some Page", "https://notion.so/some")));

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const page = await provider.getPage(ACCESS_TOKEN, "page-id");

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
      expect(url).toBe("https://api.notion.com/v1/pages/page-id");
      expect(init.headers["Authorization"]).toBe(`Bearer ${ACCESS_TOKEN}`);

      expect(page).toEqual({ id: "page-id", title: "Some Page", url: "https://notion.so/some" });
    });

    it("returns null when page is not found (404)", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const page = await provider.getPage(ACCESS_TOKEN, "missing-id");
      expect(page).toBeNull();
    });

    it("throws NotionHttpError on 401", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      await expect(provider.getPage(ACCESS_TOKEN, "page-id")).rejects.toMatchObject({
        name: "NotionHttpError",
        statusCode: 401,
      });
    });

    it("throws NotionHttpError on 5xx", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("Server Error", { status: 503 }));
      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      await expect(provider.getPage(ACCESS_TOKEN, "page-id")).rejects.toMatchObject({
        name: "NotionHttpError",
        statusCode: 503,
      });
    });
  });

  // --- createChildPage ---

  describe("createChildPage", () => {
    it("creates the page then appends blocks via PATCH /blocks/:id/children", async () => {
      fetchSpy
        .mockResolvedValueOnce(okJson(notionPageResult("child-id", "Child Title", "https://notion.so/child")))
        .mockResolvedValueOnce(okJson({}));

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const blocks: NotionExportBlock[] = [{ type: "paragraph", text: "Hello world", children: [] }];
      const result = await provider.createChildPage(ACCESS_TOKEN, "parent-id", "Child Title", blocks);

      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const [createUrl, createInit] = fetchSpy.mock.calls[0] as [string, RequestInit & { body: string }];
      expect(createUrl).toBe("https://api.notion.com/v1/pages");
      const createBody = JSON.parse(createInit.body) as Record<string, unknown>;
      expect(createBody.parent).toEqual({ type: "page_id", page_id: "parent-id" });

      const [patchUrl, patchInit] = fetchSpy.mock.calls[1] as [string, RequestInit & { body: string }];
      expect(patchUrl).toBe("https://api.notion.com/v1/blocks/child-id/children");
      expect(patchInit.method).toBe("PATCH");
      const patchBody = JSON.parse(patchInit.body) as { children: unknown[] };
      expect(patchBody.children).toHaveLength(1);

      expect(result).toEqual({ pageId: "child-id", pageUrl: "https://notion.so/child" });
    });

    it("skips the append call when blocks array is empty", async () => {
      fetchSpy.mockResolvedValueOnce(okJson(notionPageResult("empty-page", "Empty", "https://notion.so/empty")));

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      await provider.createChildPage(ACCESS_TOKEN, "parent-id", "Empty", []);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("maps paragraph blocks to Notion paragraph format", async () => {
      fetchSpy
        .mockResolvedValueOnce(okJson(notionPageResult("p-id", "Page", "https://notion.so/p")))
        .mockResolvedValueOnce(okJson({}));

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const blocks: NotionExportBlock[] = [{ type: "paragraph", text: "Note content", children: [] }];
      await provider.createChildPage(ACCESS_TOKEN, "parent-id", "Page", blocks);

      const [, patchInit] = fetchSpy.mock.calls[1] as [string, RequestInit & { body: string }];
      const body = JSON.parse(patchInit.body) as { children: Array<Record<string, unknown>> };
      expect(body.children[0]!.type).toBe("paragraph");
      expect((body.children[0]!["paragraph"] as Record<string, unknown>).rich_text).toEqual([
        { text: { content: "Note content" } },
      ]);
    });

    it("maps heading_2 and heading_3 block types correctly", async () => {
      fetchSpy
        .mockResolvedValueOnce(okJson(notionPageResult("h-id", "Page", "https://notion.so/h")))
        .mockResolvedValueOnce(okJson({}));

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const blocks: NotionExportBlock[] = [
        { type: "heading_2", text: "Section", children: [] },
        { type: "heading_3", text: "Subsection", children: [] },
      ];
      await provider.createChildPage(ACCESS_TOKEN, "parent-id", "Page", blocks);

      const [, patchInit] = fetchSpy.mock.calls[1] as [string, RequestInit & { body: string }];
      const body = JSON.parse(patchInit.body) as { children: Array<Record<string, unknown>> };
      expect(body.children[0]!.type).toBe("heading_2");
      expect(body.children[1]!.type).toBe("heading_3");
    });

    it("maps bulleted_list_item and numbered_list_item types correctly", async () => {
      fetchSpy
        .mockResolvedValueOnce(okJson(notionPageResult("l-id", "Page", "https://notion.so/l")))
        .mockResolvedValueOnce(okJson({}));

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const blocks: NotionExportBlock[] = [
        { type: "bulleted_list_item", text: "Bullet", children: [] },
        { type: "numbered_list_item", text: "Number", children: [] },
      ];
      await provider.createChildPage(ACCESS_TOKEN, "parent-id", "Page", blocks);

      const [, patchInit] = fetchSpy.mock.calls[1] as [string, RequestInit & { body: string }];
      const body = JSON.parse(patchInit.body) as { children: Array<Record<string, unknown>> };
      expect(body.children[0]!.type).toBe("bulleted_list_item");
      expect(body.children[1]!.type).toBe("numbered_list_item");
    });

    it("falls back to paragraph for unsupported block types", async () => {
      fetchSpy
        .mockResolvedValueOnce(okJson(notionPageResult("u-id", "Page", "https://notion.so/u")))
        .mockResolvedValueOnce(okJson({}));

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const blocks: NotionExportBlock[] = [{ type: "checkListItem", text: "Check", children: [] }];
      await provider.createChildPage(ACCESS_TOKEN, "parent-id", "Page", blocks);

      const [, patchInit] = fetchSpy.mock.calls[1] as [string, RequestInit & { body: string }];
      const body = JSON.parse(patchInit.body) as { children: Array<Record<string, unknown>> };
      expect(body.children[0]!.type).toBe("paragraph");
    });

    it("includes children of blocks inline in the Notion block payload", async () => {
      fetchSpy
        .mockResolvedValueOnce(okJson(notionPageResult("nested-id", "Nested", "https://notion.so/nested")))
        .mockResolvedValueOnce(okJson({}));

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const blocks: NotionExportBlock[] = [
        {
          type: "bulleted_list_item",
          text: "Parent",
          children: [{ type: "paragraph", text: "Child", children: [] }],
        },
      ];
      await provider.createChildPage(ACCESS_TOKEN, "parent-id", "Nested", blocks);

      const [, patchInit] = fetchSpy.mock.calls[1] as [string, RequestInit & { body: string }];
      const body = JSON.parse(patchInit.body) as {
        children: Array<Record<string, { rich_text: unknown[]; children: unknown[] }>>;
      };
      const parentBlock = body.children[0]!;
      expect(parentBlock.type).toBe("bulleted_list_item");
      expect(parentBlock["bulleted_list_item"].children).toHaveLength(1);
    });

    it("batches blocks at 100 per PATCH request for large notes", async () => {
      fetchSpy.mockResolvedValueOnce(okJson(notionPageResult("big-id", "Big", "https://notion.so/big")));
      // 250 blocks → 3 batches: 100, 100, 50
      fetchSpy.mockResolvedValue(okJson({}));

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const blocks: NotionExportBlock[] = Array.from({ length: 250 }, (_, i) => ({
        type: "paragraph",
        text: `Block ${i}`,
        children: [],
      }));
      await provider.createChildPage(ACCESS_TOKEN, "parent-id", "Big", blocks);

      // 1 createPage + 3 append calls
      expect(fetchSpy).toHaveBeenCalledTimes(4);

      const [, patch1Init] = fetchSpy.mock.calls[1] as [string, RequestInit & { body: string }];
      const [, patch2Init] = fetchSpy.mock.calls[2] as [string, RequestInit & { body: string }];
      const [, patch3Init] = fetchSpy.mock.calls[3] as [string, RequestInit & { body: string }];

      expect((JSON.parse(patch1Init.body) as { children: unknown[] }).children).toHaveLength(100);
      expect((JSON.parse(patch2Init.body) as { children: unknown[] }).children).toHaveLength(100);
      expect((JSON.parse(patch3Init.body) as { children: unknown[] }).children).toHaveLength(50);
    });

    it("throws NotionHttpError on 429 during block append", async () => {
      fetchSpy
        .mockResolvedValueOnce(okJson(notionPageResult("p-id", "Page", "https://notion.so/p")))
        .mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const blocks: NotionExportBlock[] = [{ type: "paragraph", text: "text", children: [] }];
      await expect(provider.createChildPage(ACCESS_TOKEN, "parent-id", "Page", blocks)).rejects.toMatchObject({
        name: "NotionHttpError",
        statusCode: 429,
      });
    });

    it("throws NotionHttpError on 5xx during block append", async () => {
      fetchSpy
        .mockResolvedValueOnce(okJson(notionPageResult("p-id", "Page", "https://notion.so/p")))
        .mockResolvedValueOnce(new Response("Server Error", { status: 500 }));

      const provider = new RealNotionProvider(CLIENT_ID, CLIENT_SECRET);
      const blocks: NotionExportBlock[] = [{ type: "paragraph", text: "text", children: [] }];
      await expect(provider.createChildPage(ACCESS_TOKEN, "parent-id", "Page", blocks)).rejects.toMatchObject({
        name: "NotionHttpError",
        statusCode: 500,
      });
    });
  });
});

describe("createProviders with Notion", () => {
  it("uses RealNotionProvider when clientId and clientSecret are set", async () => {
    const { createProviders } = await import("../../src/providers/index.js");
    const { RealNotionProvider: RealClass } = await import("../../src/providers/notion.js");
    const config = {
      groq: { apiKey: "" },
      transcriptionModel: "whisper-large-v3",
      notion: { clientId: "real-client", clientSecret: "real-secret" },
    } as Parameters<typeof createProviders>[0];

    const providers = createProviders(config);
    expect(providers.notion).toBeInstanceOf(RealClass);
  });

  it("uses FakeNotion when clientId is empty", async () => {
    const { createProviders } = await import("../../src/providers/index.js");
    const { FakeNotion } = await import("../../src/providers/fakes.js");
    const config = {
      groq: { apiKey: "" },
      transcriptionModel: "whisper-large-v3",
      notion: { clientId: "", clientSecret: "secret" },
    } as Parameters<typeof createProviders>[0];

    const providers = createProviders(config);
    expect(providers.notion).toBeInstanceOf(FakeNotion);
  });

  it("uses FakeNotion when clientSecret is empty", async () => {
    const { createProviders } = await import("../../src/providers/index.js");
    const { FakeNotion } = await import("../../src/providers/fakes.js");
    const config = {
      groq: { apiKey: "" },
      transcriptionModel: "whisper-large-v3",
      notion: { clientId: "client-id", clientSecret: "" },
    } as Parameters<typeof createProviders>[0];

    const providers = createProviders(config);
    expect(providers.notion).toBeInstanceOf(FakeNotion);
  });
});
