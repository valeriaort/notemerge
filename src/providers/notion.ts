import type { NotionProvider, NotionPage, NotionExportBlock } from "./interfaces.js";
import { NotionHttpError } from "./interfaces.js";

const NOTION_VERSION = "2022-06-28";
const NOTION_API_BASE = "https://api.notion.com/v1";
const MAX_CHILDREN_PER_REQUEST = 100;

interface NotionRichText {
  text: { content: string };
}

interface NotionBlockPayload {
  type: string;
  [key: string]: unknown;
}

interface NotionPageApiResult {
  id: string;
  url: string;
  object?: string;
  properties?: {
    title?: {
      title?: Array<{ plain_text: string }>;
    };
    [key: string]: unknown;
  };
  title?: Array<{ plain_text: string }>;
}

interface NotionSearchResponse {
  results: NotionPageApiResult[];
}

interface NotionTokenResponse {
  access_token: string;
}

function makeRichText(text: string): NotionRichText[] {
  return [{ text: { content: text } }];
}

const SUPPORTED_NOTION_TYPES = new Set([
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
]);

function mapBlock(block: NotionExportBlock): NotionBlockPayload {
  const notionType = SUPPORTED_NOTION_TYPES.has(block.type) ? block.type : "paragraph";
  const richText = makeRichText(block.text);
  const typeContent: Record<string, unknown> = { rich_text: richText };

  if (block.children.length > 0) {
    typeContent["children"] = block.children.map(mapBlock);
  }

  return { type: notionType, [notionType]: typeContent };
}

function parseNotionPage(result: NotionPageApiResult): NotionPage {
  let title = "";
  if (result.properties?.title?.title?.[0]?.plain_text) {
    title = result.properties.title.title[0].plain_text;
  } else if (result.title?.[0]?.plain_text) {
    title = result.title[0].plain_text;
  }
  return { id: result.id, title, url: result.url };
}

async function throwNotionError(response: Response): Promise<never> {
  let message = response.statusText;
  try {
    const body = await response.text();
    if (body) message = body;
  } catch {
    // keep statusText
  }
  throw new NotionHttpError(response.status, message);
}

function notionHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_VERSION,
  };
}

export class RealNotionProvider implements NotionProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  getOAuthUrl(redirectUri: string, state: string): string {
    const url = new URL(`${NOTION_API_BASE}/oauth/authorize`);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("owner", "user");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string }> {
    const creds = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const response = await fetch(`${NOTION_API_BASE}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    });

    if (!response.ok) {
      await throwNotionError(response);
    }

    const data = (await response.json()) as NotionTokenResponse;
    return { accessToken: data.access_token };
  }

  async searchPages(accessToken: string, query: string): Promise<NotionPage[]> {
    const response = await fetch(`${NOTION_API_BASE}/search`, {
      method: "POST",
      headers: notionHeaders(accessToken),
      body: JSON.stringify({ query, filter: { value: "page", property: "object" } }),
    });

    if (!response.ok) {
      await throwNotionError(response);
    }

    const data = (await response.json()) as NotionSearchResponse;
    return data.results.map(parseNotionPage);
  }

  async createPage(accessToken: string, parentPageId: string | null, title: string): Promise<NotionPage> {
    const parent = parentPageId
      ? { type: "page_id", page_id: parentPageId }
      : { type: "workspace", workspace: true };

    const response = await fetch(`${NOTION_API_BASE}/pages`, {
      method: "POST",
      headers: notionHeaders(accessToken),
      body: JSON.stringify({
        parent,
        properties: { title: { title: [{ text: { content: title } }] } },
      }),
    });

    if (!response.ok) {
      await throwNotionError(response);
    }

    const data = (await response.json()) as NotionPageApiResult;
    return parseNotionPage(data);
  }

  async getPage(accessToken: string, pageId: string): Promise<NotionPage | null> {
    const response = await fetch(`${NOTION_API_BASE}/pages/${pageId}`, {
      headers: notionHeaders(accessToken),
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      await throwNotionError(response);
    }

    const data = (await response.json()) as NotionPageApiResult;
    return parseNotionPage(data);
  }

  async createChildPage(
    accessToken: string,
    parentPageId: string,
    title: string,
    blocks: NotionExportBlock[],
  ): Promise<{ pageId: string; pageUrl: string }> {
    const page = await this.createPage(accessToken, parentPageId, title);

    if (blocks.length > 0) {
      const notionBlocks = blocks.map(mapBlock);
      for (let i = 0; i < notionBlocks.length; i += MAX_CHILDREN_PER_REQUEST) {
        const batch = notionBlocks.slice(i, i + MAX_CHILDREN_PER_REQUEST);
        await this.appendChildren(accessToken, page.id, batch);
      }
    }

    return { pageId: page.id, pageUrl: page.url };
  }

  private async appendChildren(accessToken: string, blockId: string, children: NotionBlockPayload[]): Promise<void> {
    const response = await fetch(`${NOTION_API_BASE}/blocks/${blockId}/children`, {
      method: "PATCH",
      headers: notionHeaders(accessToken),
      body: JSON.stringify({ children }),
    });

    if (!response.ok) {
      await throwNotionError(response);
    }
  }
}
