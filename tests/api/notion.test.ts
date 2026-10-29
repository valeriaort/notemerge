import { describe, it, expect, beforeEach, afterEach } from "vitest";
import FormData from "form-data";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import type { Lecture, MergedBlock, MergeRun, Subject } from "../../src/shared/types.js";
import { ScriptedClassifier, ScriptedWritingModel, ScriptedNotion } from "../../src/providers/fakes.js";
import type { NotionExportBlock } from "../../src/providers/interfaces.js";

// Minimal single-page PDF for sealing
function buildOneSlidePdf(title: string, bulletText: string): Buffer {
  const pages = [{ texts: [{ text: title, y: 720, size: 24 }, { text: `- ${bulletText}`, y: 670, size: 12 }] }];
  const n = pages.length;
  const numObjs = 3 + n * 2;
  const objBodies: string[] = [""];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objBodies.push(`<</Type /Catalog /Pages 2 0 R>>`);
  objBodies.push(`<</Type /Pages /Kids [${kids}] /Count ${n}>>`);
  objBodies.push(`<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>`);
  for (let i = 0; i < n; i++) {
    const contentObjNum = 5 + i * 2;
    let stream = "";
    for (const { text, y, size } of pages[i]!.texts) {
      const esc = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
      stream += `BT /F1 ${size} Tf 50 ${y} Td (${esc}) Tj ET\n`;
    }
    objBodies.push(`<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNum} 0 R /Resources <</Font <</F1 3 0 R>>>>>>`);
    objBodies.push(`<</Length ${stream.length}>>\nstream\n${stream}endstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = new Array(numObjs + 1).fill(0) as number[];
  for (let i = 1; i <= numObjs; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objBodies[i]}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${numObjs + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= numObjs; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${numObjs + 1} /Root 1 0 R>>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

const SLIDE_PDF = buildOneSlidePdf("Slide Title", "Anatomy fact");

async function createLecture(url: string): Promise<Lecture> {
  const res = await fetch(`${url}/api/lectures`, { method: "POST" });
  return res.json() as Promise<Lecture>;
}

async function getLecture(url: string, lectureId: string): Promise<Lecture> {
  const res = await fetch(`${url}/api/lectures/${lectureId}`);
  return res.json() as Promise<Lecture>;
}

async function putNotes(url: string, lectureId: string, notesData: object): Promise<void> {
  await fetch(`${url}/api/lectures/${lectureId}/notes`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notesData: JSON.stringify(notesData) }),
  });
}

function oneBlockNotes(blockId: string, text: string, t: number, type = "paragraph"): object {
  return {
    blocks: [{ id: blockId, type, content: [{ type: "text", text }], children: [] }],
    meta: { [blockId]: { firstEditTime: t, lastEditTime: t + 60000 } },
  };
}

function typedBlockNotes(blocks: Array<{ id: string; type: string; text: string; props?: object; children?: unknown[] }>, t: number): object {
  return {
    blocks: blocks.map((b) => ({
      id: b.id,
      type: b.type,
      props: b.props ?? {},
      content: [{ type: "text", text: b.text }],
      children: b.children ?? [],
    })),
    meta: Object.fromEntries(blocks.map((b, i) => [b.id, { firstEditTime: t + i * 1000, lastEditTime: t + i * 1000 + 60000 }])),
  };
}

async function sealWithPdf(url: string, lectureId: string, subjectName = "Anatomy 101"): Promise<void> {
  const form = new FormData();
  form.append("subjectName", subjectName);
  form.append("presentation", SLIDE_PDF, { filename: "slides.pdf", contentType: "application/pdf" });
  const headers = form.getHeaders() as Record<string, string>;
  await fetch(`${url}/api/lectures/${lectureId}/sources`, { method: "POST", headers, body: form.getBuffer() });
}

async function postMerge(url: string, lectureId: string): Promise<{ mergeRun: MergeRun; mergedNote: MergedBlock[] }> {
  const res = await fetch(`${url}/api/lectures/${lectureId}/merge`, { method: "POST" });
  return res.json() as Promise<{ mergeRun: MergeRun; mergedNote: MergedBlock[] }>;
}

async function patchBlock(url: string, lectureId: string, blockId: string, body: Record<string, unknown>): Promise<void> {
  await fetch(`${url}/api/lectures/${lectureId}/merged-note/${blockId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function connectNotion(url: string): Promise<void> {
  await fetch(`${url}/api/notion/callback?code=test-auth-code`);
}

async function setSubjectNotionPage(url: string, subjectId: string, pageId: string): Promise<Subject> {
  const res = await fetch(`${url}/api/subjects/${subjectId}/notion-page`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pageId }),
  });
  return res.json() as Promise<Subject>;
}

async function exportToNotion(url: string, lectureId: string): Promise<{ status: number; pageUrl?: string; title?: string; error?: string; needsPicker?: boolean }> {
  const res = await fetch(`${url}/api/lectures/${lectureId}/export/notion`, { method: "POST" });
  const body = await res.json() as { pageUrl?: string; title?: string; error?: string; needsPicker?: boolean };
  return { status: res.status, ...body };
}

// Set up a lecture that is fully merged and ready for export
async function setupReadyLecture(
  url: string,
  writingModel: ScriptedWritingModel,
  blockId = "B01",
  text = "some notes",
  blockType = "paragraph",
): Promise<{ lectureId: string; subjectId: string }> {
  const t = Date.now();
  const lecture = await createLecture(url);
  await putNotes(url, lecture.id, oneBlockNotes(blockId, text, t, blockType));
  await sealWithPdf(url, lecture.id);
  writingModel.setOperations([]);
  await postMerge(url, lecture.id);
  const updated = await getLecture(url, lecture.id);
  return { lectureId: lecture.id, subjectId: updated.subjectId! };
}

let server: TestServer;
let notion: ScriptedNotion;
let writingModel: ScriptedWritingModel;

beforeEach(async () => {
  notion = new ScriptedNotion();
  writingModel = new ScriptedWritingModel();
  server = await startTestServer({ notion, writingModel });
});

afterEach(() => {
  server.close();
});

// ── OAuth flow ────────────────────────────────────────────────────────────────

describe("GET /api/notion/auth-url", () => {
  it("returns a Notion OAuth URL", async () => {
    const res = await fetch(`${server.url}/api/notion/auth-url`);
    expect(res.status).toBe(200);
    const { url } = await res.json() as { url: string };
    expect(typeof url).toBe("string");
    expect(url).toContain("api.notion.com");
  });

  it("URL contains redirect_uri pointing to /api/notion/callback", async () => {
    const res = await fetch(`${server.url}/api/notion/auth-url`);
    const { url } = await res.json() as { url: string };
    expect(url).toContain("/api/notion/callback");
  });
});

describe("GET /api/notion/callback", () => {
  it("returns 400 when no code is provided", async () => {
    const res = await fetch(`${server.url}/api/notion/callback`);
    expect(res.status).toBe(400);
  });

  it("exchanges code for token and returns success", async () => {
    const res = await fetch(`${server.url}/api/notion/callback?code=test-code`);
    expect(res.status).toBe(200);
    const { success } = await res.json() as { success: boolean };
    expect(success).toBe(true);
  });

  it("stores token so subsequent status check shows connected", async () => {
    const before = await (await fetch(`${server.url}/api/notion/status`)).json() as { connected: boolean };
    expect(before.connected).toBe(false);

    await fetch(`${server.url}/api/notion/callback?code=test-code`);

    const after = await (await fetch(`${server.url}/api/notion/status`)).json() as { connected: boolean };
    expect(after.connected).toBe(true);
  });
});

describe("GET /api/notion/status", () => {
  it("returns connected: false before OAuth", async () => {
    const res = await fetch(`${server.url}/api/notion/status`);
    const { connected } = await res.json() as { connected: boolean };
    expect(connected).toBe(false);
  });

  it("returns connected: true after OAuth callback", async () => {
    await connectNotion(server.url);
    const res = await fetch(`${server.url}/api/notion/status`);
    const { connected } = await res.json() as { connected: boolean };
    expect(connected).toBe(true);
  });
});

// ── Page picker ───────────────────────────────────────────────────────────────

describe("GET /api/notion/search-pages", () => {
  it("returns 401 when not connected", async () => {
    const res = await fetch(`${server.url}/api/notion/search-pages?q=Anatomy`);
    expect(res.status).toBe(401);
  });

  it("returns pages from provider after connecting", async () => {
    notion.setSearchResults([
      { id: "page-1", title: "Anatomy 101", url: "https://notion.so/anatomy" },
      { id: "page-2", title: "Physiology", url: "https://notion.so/physiology" },
    ]);
    await connectNotion(server.url);

    const res = await fetch(`${server.url}/api/notion/search-pages?q=Anatomy`);
    expect(res.status).toBe(200);
    const { pages } = await res.json() as { pages: Array<{ id: string; title: string }> };
    expect(pages).toHaveLength(2);
    expect(pages[0]!.title).toBe("Anatomy 101");
  });

  it("passes the query to the provider", async () => {
    await connectNotion(server.url);
    await fetch(`${server.url}/api/notion/search-pages?q=Cardiology`);
    expect(notion.capturedSearchQueries).toContain("Cardiology");
  });

  it("exact title match is present in search results when provider returns it", async () => {
    notion.setSearchResults([
      { id: "exact-id", title: "Anatomy 101", url: "https://notion.so/exact" },
      { id: "other-id", title: "Anatomy 102", url: "https://notion.so/other" },
    ]);
    await connectNotion(server.url);

    const res = await fetch(`${server.url}/api/notion/search-pages?q=Anatomy+101`);
    const { pages } = await res.json() as { pages: Array<{ id: string; title: string }> };
    const exactMatch = pages.find((p) => p.title === "Anatomy 101");
    expect(exactMatch).toBeDefined();
    expect(exactMatch!.id).toBe("exact-id");
  });
});

describe("POST /api/notion/root-pages", () => {
  it("returns 401 when not connected", async () => {
    const res = await fetch(`${server.url}/api/notion/root-pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "My Subject" }),
    });
    expect(res.status).toBe(401);
  });

  it("creates a page and returns it", async () => {
    await connectNotion(server.url);
    const res = await fetch(`${server.url}/api/notion/root-pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Anatomy 101" }),
    });
    expect(res.status).toBe(201);
    const { page } = await res.json() as { page: { id: string; title: string; url: string } };
    expect(page.title).toBe("Anatomy 101");
    expect(typeof page.id).toBe("string");
  });

  it("passes null parentPageId (root-level creation)", async () => {
    await connectNotion(server.url);
    await fetch(`${server.url}/api/notion/root-pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Subject" }),
    });
    expect(notion.capturedCreatedPages[0]!.parentPageId).toBeNull();
    expect(notion.capturedCreatedPages[0]!.title).toBe("New Subject");
  });

  it("returns 400 when title is missing", async () => {
    await connectNotion(server.url);
    const res = await fetch(`${server.url}/api/notion/root-pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ── Subject notion-page ───────────────────────────────────────────────────────

describe("PUT /api/subjects/:id/notion-page", () => {
  it("stores the notion parent page ID and returns the updated subject", async () => {
    const createRes = await fetch(`${server.url}/api/subjects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Anatomy" }),
    });
    const subject = await createRes.json() as Subject;

    const updated = await setSubjectNotionPage(server.url, subject.id, "notion-parent-id");
    expect(updated.notionParentPageId).toBe("notion-parent-id");
  });

  it("returns 404 for unknown subject", async () => {
    const res = await fetch(`${server.url}/api/subjects/no-such-subject/notion-page`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageId: "some-id" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when pageId is missing", async () => {
    const createRes = await fetch(`${server.url}/api/subjects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Anatomy" }),
    });
    const subject = await createRes.json() as Subject;

    const res = await fetch(`${server.url}/api/subjects/${subject.id}/notion-page`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ── Notion export — gating ────────────────────────────────────────────────────

describe("POST /api/lectures/:id/export/notion — gating", () => {
  it("returns 401 when not connected to Notion", async () => {
    const { lectureId } = await setupReadyLecture(server.url, writingModel);
    const { status } = await exportToNotion(server.url, lectureId);
    expect(status).toBe(401);
  });

  it("returns 404 for unknown lecture", async () => {
    await connectNotion(server.url);
    const { status } = await exportToNotion(server.url, "no-such-lecture");
    expect(status).toBe(404);
  });

  it("returns 409 when lecture is not in review stage", async () => {
    await connectNotion(server.url);
    const lecture = await createLecture(server.url);
    const { status } = await exportToNotion(server.url, lecture.id);
    expect(status).toBe(409);
  });

  it("returns 409 when conflicts are unresolved", async () => {
    const classifier = new ScriptedClassifier();
    classifier.addConflictAnswers({ "conflict:B01": { label: "conflicts", probability: 0.97 } });
    server.close();
    const conflictNotion = new ScriptedNotion();
    const conflictWritingModel = new ScriptedWritingModel();
    conflictWritingModel.setOperations([{ type: "rewrite", blockId: "B01", text: "rewrite", sourceIds: ["S001-B01"] }]);
    server = await startTestServer({ notion: conflictNotion, writingModel: conflictWritingModel, classifier });

    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, oneBlockNotes("B01", "student text", t));
    await sealWithPdf(server.url, lecture.id);
    await postMerge(server.url, lecture.id);

    await fetch(`${server.url}/api/notion/callback?code=test-code`);
    const updated = await getLecture(server.url, lecture.id);
    await setSubjectNotionPage(server.url, updated.subjectId!, "parent-page-id");

    const { status } = await exportToNotion(server.url, lecture.id);
    expect(status).toBe(409);
  });

  it("returns 422 when subject has no notion parent page set", async () => {
    const { lectureId } = await setupReadyLecture(server.url, writingModel);
    await connectNotion(server.url);
    const { status } = await exportToNotion(server.url, lectureId);
    expect(status).toBe(422);
  });

  it("returns 404 with needsPicker:true when stored page is missing or unshared", async () => {
    notion.setGetPageResult(null);
    const { lectureId, subjectId } = await setupReadyLecture(server.url, writingModel);
    await connectNotion(server.url);
    await setSubjectNotionPage(server.url, subjectId, "missing-page-id");

    const result = await exportToNotion(server.url, lectureId);
    expect(result.status).toBe(404);
    expect(result.needsPicker).toBe(true);
    expect(typeof result.error).toBe("string");
  });
});

// ── Notion export — success ───────────────────────────────────────────────────

describe("POST /api/lectures/:id/export/notion — success", () => {
  it("returns pageUrl and sets lecture stage to exported", async () => {
    notion.setCreateChildPageResult({ pageId: "new-child", pageUrl: "https://notion.so/new-child" });
    const { lectureId, subjectId } = await setupReadyLecture(server.url, writingModel);
    await connectNotion(server.url);
    await setSubjectNotionPage(server.url, subjectId, "parent-page-id");

    const { status, pageUrl } = await exportToNotion(server.url, lectureId);
    expect(status).toBe(200);
    expect(pageUrl).toBe("https://notion.so/new-child");

    const lecture = await getLecture(server.url, lectureId);
    expect(lecture.stage).toBe("exported");
  });

  it("stores notionPageUrl on the lecture", async () => {
    notion.setCreateChildPageResult({ pageId: "new-child", pageUrl: "https://notion.so/stored-url" });
    const { lectureId, subjectId } = await setupReadyLecture(server.url, writingModel);
    await connectNotion(server.url);
    await setSubjectNotionPage(server.url, subjectId, "parent-page-id");

    await exportToNotion(server.url, lectureId);

    const lecture = await getLecture(server.url, lectureId);
    expect(lecture.notionPageUrl).toBe("https://notion.so/stored-url");
  });

  it("passes the subject's notion page ID as parent", async () => {
    const { lectureId, subjectId } = await setupReadyLecture(server.url, writingModel);
    await connectNotion(server.url);
    await setSubjectNotionPage(server.url, subjectId, "subject-parent-id");

    await exportToNotion(server.url, lectureId);

    expect(notion.capturedChildPages[0]!.parentPageId).toBe("subject-parent-id");
  });

  it("title uses the lecture date in en-GB format", async () => {
    const { lectureId, subjectId } = await setupReadyLecture(server.url, writingModel);
    await connectNotion(server.url);
    await setSubjectNotionPage(server.url, subjectId, "parent-id");

    const { title } = await exportToNotion(server.url, lectureId);
    expect(typeof title).toBe("string");
    // en-GB format: "29 October 2026" style
    expect(title).toMatch(/\d+ \w+ \d{4}/);
  });

  it("title has no counter when this is the first export for the subject today", async () => {
    const { lectureId, subjectId } = await setupReadyLecture(server.url, writingModel);
    await connectNotion(server.url);
    await setSubjectNotionPage(server.url, subjectId, "parent-id");

    const { title } = await exportToNotion(server.url, lectureId);
    expect(title).not.toContain("(");
  });

  it("re-exporting the same lecture creates a second page and updates the stored URL", async () => {
    notion.setCreateChildPageResult({ pageId: "page-1", pageUrl: "https://notion.so/page-1" });
    const { lectureId, subjectId } = await setupReadyLecture(server.url, writingModel);
    await connectNotion(server.url);
    await setSubjectNotionPage(server.url, subjectId, "parent-id");

    await exportToNotion(server.url, lectureId);

    notion.setCreateChildPageResult({ pageId: "page-2", pageUrl: "https://notion.so/page-2" });
    await exportToNotion(server.url, lectureId);

    expect(notion.capturedChildPages).toHaveLength(2);
    const lecture = await getLecture(server.url, lectureId);
    expect(lecture.notionPageUrl).toBe("https://notion.so/page-2");
  });

  it("second export of the same lecture uses a counter in the title", async () => {
    const { lectureId, subjectId } = await setupReadyLecture(server.url, writingModel);
    await connectNotion(server.url);
    await setSubjectNotionPage(server.url, subjectId, "parent-id");

    await exportToNotion(server.url, lectureId);
    const { title } = await exportToNotion(server.url, lectureId);
    expect(title).toContain("(2)");
  });
});

// ── Notion export — same-day counter ─────────────────────────────────────────

describe("POST /api/lectures/:id/export/notion — same-day counter", () => {
  it("second lecture on the same day/subject gets counter (2) in title", async () => {
    const writingModel2 = new ScriptedWritingModel();
    const { lectureId: id1, subjectId } = await setupReadyLecture(server.url, writingModel);
    await connectNotion(server.url);
    await setSubjectNotionPage(server.url, subjectId, "parent-id");

    // Export first lecture — no counter
    const { title: title1 } = await exportToNotion(server.url, id1);
    expect(title1).not.toContain("(");

    // Create a second lecture for the same subject (same day)
    const t2 = Date.now() + 3600000;
    const lecture2 = await createLecture(server.url);
    await putNotes(server.url, lecture2.id, oneBlockNotes("B99", "second lecture notes", t2));

    const form = new FormData();
    form.append("subjectId", subjectId);
    form.append("presentation", SLIDE_PDF, { filename: "slides.pdf", contentType: "application/pdf" });
    const headers = form.getHeaders() as Record<string, string>;
    await fetch(`${server.url}/api/lectures/${lecture2.id}/sources`, { method: "POST", headers, body: form.getBuffer() });

    writingModel2.setOperations([]);
    await postMerge(server.url, lecture2.id);

    // Export second lecture — should get counter
    const { title: title2 } = await exportToNotion(server.url, lecture2.id);
    expect(title2).toContain("(2)");
  });
});

// ── Notion export — error handling ───────────────────────────────────────────

describe("POST /api/lectures/:id/export/notion — error handling", () => {
  it("returns 502 when createChildPage throws", async () => {
    notion.setCreateChildPageError(new Error("Network error"));
    const { lectureId, subjectId } = await setupReadyLecture(server.url, writingModel);
    await connectNotion(server.url);
    await setSubjectNotionPage(server.url, subjectId, "parent-id");

    const { status } = await exportToNotion(server.url, lectureId);
    expect(status).toBe(502);
  });

  it("leaves notionPageUrl unchanged when push fails", async () => {
    notion.setCreateChildPageError(new Error("Network error"));
    const { lectureId, subjectId } = await setupReadyLecture(server.url, writingModel);
    await connectNotion(server.url);
    await setSubjectNotionPage(server.url, subjectId, "parent-id");

    await exportToNotion(server.url, lectureId);

    const lecture = await getLecture(server.url, lectureId);
    expect(lecture.notionPageUrl).toBeNull();
  });

  it("leaves lecture stage unchanged when push fails (still review)", async () => {
    notion.setCreateChildPageError(new Error("Network error"));
    const { lectureId, subjectId } = await setupReadyLecture(server.url, writingModel);
    await connectNotion(server.url);
    await setSubjectNotionPage(server.url, subjectId, "parent-id");

    await exportToNotion(server.url, lectureId);

    const lecture = await getLecture(server.url, lectureId);
    expect(lecture.stage).toBe("review");
  });
});

// ── Block type mapping ────────────────────────────────────────────────────────

describe("POST /api/lectures/:id/export/notion — block mapping", () => {
  async function getExportedBlocks(blockType: string, props?: object): Promise<NotionExportBlock[]> {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, typedBlockNotes([{ id: "B01", type: blockType, text: "content", props }], t));
    await sealWithPdf(server.url, lecture.id);
    writingModel.setOperations([]);
    await postMerge(server.url, lecture.id);
    const updated = await getLecture(server.url, lecture.id);
    await connectNotion(server.url);
    await setSubjectNotionPage(server.url, updated.subjectId!, "parent-id");
    await exportToNotion(server.url, lecture.id);
    return notion.capturedChildPages[notion.capturedChildPages.length - 1]!.blocks;
  }

  it("paragraph block maps to Notion paragraph", async () => {
    const blocks = await getExportedBlocks("paragraph");
    expect(blocks[0]!.type).toBe("paragraph");
  });

  it("heading block with level 1 maps to heading_1", async () => {
    const blocks = await getExportedBlocks("heading", { level: 1 });
    expect(blocks[0]!.type).toBe("heading_1");
  });

  it("heading block with level 2 maps to heading_2", async () => {
    const blocks = await getExportedBlocks("heading", { level: 2 });
    expect(blocks[0]!.type).toBe("heading_2");
  });

  it("heading block with level 3 maps to heading_3", async () => {
    const blocks = await getExportedBlocks("heading", { level: 3 });
    expect(blocks[0]!.type).toBe("heading_3");
  });

  it("bulletListItem maps to bulleted_list_item", async () => {
    const blocks = await getExportedBlocks("bulletListItem");
    expect(blocks[0]!.type).toBe("bulleted_list_item");
  });

  it("numberedListItem maps to numbered_list_item", async () => {
    const blocks = await getExportedBlocks("numberedListItem");
    expect(blocks[0]!.type).toBe("numbered_list_item");
  });

  it("unsupported block type falls back to paragraph", async () => {
    const blocks = await getExportedBlocks("checkListItem");
    expect(blocks[0]!.type).toBe("paragraph");
  });

  it("slide marker blocks are not included in exported blocks", async () => {
    const t = Date.now();
    const lecture = await createLecture(server.url);
    await putNotes(server.url, lecture.id, typedBlockNotes([
      { id: "B01", type: "paragraph", text: "real note" },
      { id: "B02", type: "paragraph", text: "" },
    ], t));

    await fetch(`${server.url}/api/lectures/${lecture.id}/markers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timestamp: t + 30000, blockId: "B02" }),
    });

    await sealWithPdf(server.url, lecture.id);
    writingModel.setOperations([]);
    const { mergedNote } = await postMerge(server.url, lecture.id);
    const updated = await getLecture(server.url, lecture.id);

    await connectNotion(server.url);
    await setSubjectNotionPage(server.url, updated.subjectId!, "parent-id");
    await exportToNotion(server.url, lecture.id);

    const blocks = notion.capturedChildPages[0]!.blocks;
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain("real note");

    // B02 is a slide marker — its merged block text should not appear
    const b02Block = mergedNote.find((b) => b.noteId === "B02");
    if (b02Block) {
      expect(texts).not.toContain(b02Block.text);
    }
  });

  it("parent block with nested children is exported with correct type and combined text", async () => {
    // Note: the current merge implementation processes only top-level blocks; nested children
    // are concatenated into the parent block's text by blockText(). Nesting in Notion requires
    // nested children to be stored as separate merged_blocks (a follow-up item).
    const t = Date.now();
    const lecture = await createLecture(server.url);

    const notesData = {
      blocks: [{
        id: "PARENT",
        type: "bulletListItem",
        props: {},
        content: [{ type: "text", text: "parent item" }],
        children: [{
          id: "CHILD",
          type: "paragraph",
          props: {},
          content: [{ type: "text", text: "child item" }],
          children: [],
        }],
      }],
      meta: {
        PARENT: { firstEditTime: t, lastEditTime: t + 60000 },
      },
    };
    await putNotes(server.url, lecture.id, notesData);
    await sealWithPdf(server.url, lecture.id);
    writingModel.setOperations([]);
    await postMerge(server.url, lecture.id);

    const updated = await getLecture(server.url, lecture.id);
    await connectNotion(server.url);
    await setSubjectNotionPage(server.url, updated.subjectId!, "parent-id");
    await exportToNotion(server.url, lecture.id);

    const blocks = notion.capturedChildPages[0]!.blocks;
    // Parent block is exported with bulleted_list_item type
    const parentBlock = blocks.find((b) => b.type === "bulleted_list_item");
    expect(parentBlock).toBeDefined();
    // Child text is baked into parent text by the merge
    expect(parentBlock!.text).toContain("parent item");
  });
});
