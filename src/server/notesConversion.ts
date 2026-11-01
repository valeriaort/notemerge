import path from "path";
import { v4 as uuidv4 } from "uuid";
import { marked } from "marked";
import type { Token, Tokens } from "marked";
import mammoth from "mammoth";
import type { NotesDocument } from "../shared/types.js";
import {
  SCANNED_PDF_ERROR,
  SCAN_THRESHOLD,
  getPdfjs,
  groupIntoLines,
  isTextItem,
} from "./pdfExtraction.js";
import type { PageLine } from "./pdfExtraction.js";

// Untimed notes: PDF (text layer), Markdown or DOCX converted deterministically
// into BlockNote-shaped note blocks with fresh IDs and empty meta.

export type NotesConversionResult =
  | { ok: true; notes: NotesDocument }
  | { ok: false; error: string };

// Format-neutral intermediate form: one entry per note block, in document order.
// `depth` is the list nesting level (0 = top level) and only applies to list items.
type NoteItem =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet" | "numbered"; depth: number; text: string };

type NoteBlockShape = {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content: Array<{ type: "text"; text: string; styles: Record<string, never> }>;
  children: NoteBlockShape[];
};

export const SUPPORTED_NOTES_EXTENSIONS = [".pdf", ".md", ".markdown", ".docx"];

export const NOTES_CONVERSION_ERRORS = {
  unsupportedType: "Notes must be a PDF, Markdown (.md) or Word (.docx) file.",
  parseFailed: (kind: string) => `Failed to read the ${kind} file.`,
  empty: "No text was found in the notes file.",
  scannedPdf: SCANNED_PDF_ERROR,
};

function makeBlock(type: string, text: string, props?: Record<string, unknown>): NoteBlockShape {
  return {
    id: uuidv4(),
    type,
    ...(props ? { props } : {}),
    content: [{ type: "text", text, styles: {} }],
    children: [],
  };
}

function itemsToDocument(items: NoteItem[]): NotesDocument {
  const blocks: NoteBlockShape[] = [];
  // Open list items by depth; a deeper item nests under the nearest open shallower one.
  let listStack: NoteBlockShape[] = [];

  for (const item of items) {
    if (item.kind === "heading") {
      listStack = [];
      blocks.push(makeBlock("heading", item.text, { level: Math.min(Math.max(item.level, 1), 3) }));
    } else if (item.kind === "paragraph") {
      listStack = [];
      blocks.push(makeBlock("paragraph", item.text));
    } else {
      const block = makeBlock(item.kind === "bullet" ? "bulletListItem" : "numberedListItem", item.text);
      const depth = Math.min(item.depth, listStack.length);
      listStack = listStack.slice(0, depth);
      const parent = listStack[depth - 1];
      if (parent) parent.children.push(block);
      else blocks.push(block);
      listStack.push(block);
    }
  }

  return { blocks, meta: {} };
}

function finish(items: NoteItem[]): NotesConversionResult {
  const cleaned = items
    .map((i) => ({ ...i, text: i.text.replace(/\s+/g, " ").trim() }))
    .filter((i) => i.text.length > 0);
  if (cleaned.length === 0) return { ok: false, error: NOTES_CONVERSION_ERRORS.empty };
  return { ok: true, notes: itemsToDocument(cleaned) };
}

// ── Markdown ────────────────────────────────────────────────────────────────

function inlineText(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens) return fallback;
  return tokens
    .map((t) => {
      if (t.type === "html") return "";
      if (t.type === "br") return " ";
      const nested = (t as { tokens?: Token[] }).tokens;
      if (nested) return inlineText(nested, "");
      return (t as { text?: string }).text ?? "";
    })
    .join("");
}

function markdownList(list: Tokens.List, depth: number, out: NoteItem[]): void {
  const kind = list.ordered ? "numbered" : "bullet";
  for (const item of list.items) {
    const textParts: string[] = [];
    const nested: Tokens.List[] = [];
    for (const child of item.tokens) {
      if (child.type === "list") nested.push(child as Tokens.List);
      else if (child.type === "text" || child.type === "paragraph") {
        const c = child as Tokens.Text | Tokens.Paragraph;
        textParts.push(inlineText(c.tokens, c.text));
      }
    }
    out.push({ kind, depth, text: textParts.join(" ") });
    for (const n of nested) markdownList(n, depth + 1, out);
  }
}

function markdownBlocks(tokens: Token[], out: NoteItem[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const h = token as Tokens.Heading;
        out.push({ kind: "heading", level: h.depth, text: inlineText(h.tokens, h.text) });
        break;
      }
      case "paragraph": {
        const p = token as Tokens.Paragraph;
        out.push({ kind: "paragraph", text: inlineText(p.tokens, p.text) });
        break;
      }
      case "list":
        markdownList(token as Tokens.List, 0, out);
        break;
      case "blockquote":
        markdownBlocks((token as Tokens.Blockquote).tokens, out);
        break;
      case "code":
        out.push({ kind: "paragraph", text: (token as Tokens.Code).text });
        break;
      default:
        break;
    }
  }
}

export function convertMarkdownNotes(source: string): NotesConversionResult {
  const items: NoteItem[] = [];
  markdownBlocks(marked.lexer(source), items);
  return finish(items);
}

// ── DOCX (via mammoth's HTML output) ────────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return HTML_ENTITIES[e] ?? m;
  });
}

// mammoth emits a small, regular subset: h1-h6, p, ul/ol/li (nested inside li), inline tags.
export function htmlToNoteItems(html: string): NoteItem[] {
  const items: NoteItem[] = [];
  const lists: Array<"bullet" | "numbered"> = [];
  let current: { kind: "heading" | "paragraph" | "li"; level: number; kindOfList: "bullet" | "numbered" | null; depth: number } | null = null;
  let buffer = "";

  const flush = () => {
    if (current) {
      const text = decodeEntities(buffer);
      if (current.kind === "heading") items.push({ kind: "heading", level: current.level, text });
      else if (current.kind === "paragraph") items.push({ kind: "paragraph", text });
      else items.push({ kind: current.kindOfList!, depth: current.depth, text });
    }
    current = null;
    buffer = "";
  };

  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*?(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    if (m[4] !== undefined) {
      if (current) buffer += m[4];
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      flush();
      if (!closing) current = { kind: "heading", level: Number(tag[1]), kindOfList: null, depth: 0 };
    } else if (tag === "p") {
      flush();
      if (!closing) current = { kind: "paragraph", level: 0, kindOfList: null, depth: 0 };
    } else if (tag === "ul" || tag === "ol") {
      flush();
      if (closing) lists.pop();
      else lists.push(tag === "ul" ? "bullet" : "numbered");
    } else if (tag === "li") {
      flush();
      if (!closing && lists.length > 0) {
        current = { kind: "li", level: 0, kindOfList: lists[lists.length - 1]!, depth: lists.length - 1 };
      }
    } else if (tag === "br" && current) {
      buffer += " ";
    }
  }
  flush();
  return items;
}

export async function convertDocxNotes(buffer: Buffer): Promise<NotesConversionResult> {
  try {
    const { value } = await mammoth.convertToHtml({ buffer });
    return finish(htmlToNoteItems(value));
  } catch {
    return { ok: false, error: NOTES_CONVERSION_ERRORS.parseFailed("Word") };
  }
}

// ── PDF with a text layer ───────────────────────────────────────────────────

const PDF_BULLET_RE = /^[•●◦▪▸·→\-*]\s+/;
const PDF_NUMBER_RE = /^\d+[.)]\s+/;
const PAGE_NUMBER_RE = /^\s*\d+\s*$/;
const TERMINAL_PUNCT_RE = /[.!?:;]$/;
// A line this much taller than body text is a heading
const HEADING_SIZE_RATIO = 1.15;
// A list line indented this many points beyond the previous list line is nested
const INDENT_STEP = 6;

export async function convertPdfNotes(buffer: Buffer): Promise<NotesConversionResult> {
  const { pdfjs, standardFontsDir } = await getPdfjs();

  let pdfDoc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    pdfDoc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      useSystemFonts: true,
      disableFontFace: true,
      standardFontDataUrl: `file://${standardFontsDir}`,
    }).promise;
  } catch {
    return { ok: false, error: NOTES_CONVERSION_ERRORS.parseFailed("PDF") };
  }

  const pages: PageLine[][] = [];
  let pagesWithText = 0;
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const content = await page.getTextContent();
    const lines = groupIntoLines(content.items.filter(isTextItem));
    pages.push(lines);
    if (lines.length > 0) pagesWithText++;
  }

  if (pagesWithText === 0 || pagesWithText / pdfDoc.numPages < SCAN_THRESHOLD) {
    return { ok: false, error: NOTES_CONVERSION_ERRORS.scannedPdf };
  }

  // Drop running headers/footers and bare page numbers
  const freq = new Map<string, number>();
  for (const lines of pages) {
    for (const key of new Set(lines.map((l) => l.text.trim().toLowerCase()))) {
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
  }
  const repeated = new Set(
    [...freq].filter(([, n]) => n >= 2 && n / pdfDoc.numPages > 0.5).map(([k]) => k),
  );
  const kept: PageLine[] = pages.flat().filter((l) => {
    const key = l.text.trim().toLowerCase();
    return key && !repeated.has(key) && !PAGE_NUMBER_RE.test(l.text);
  });

  // Body size = the line height carrying the most characters
  const charsByHeight = new Map<number, number>();
  for (const l of kept) {
    const h = Math.round(l.maxHeight * 2) / 2;
    charsByHeight.set(h, (charsByHeight.get(h) ?? 0) + l.text.length);
  }
  let bodyHeight = 0;
  let bodyChars = -1;
  for (const [h, chars] of [...charsByHeight].sort((a, b) => a[0] - b[0])) {
    if (chars > bodyChars) { bodyHeight = h; bodyChars = chars; }
  }
  const headingHeights = [...charsByHeight.keys()]
    .filter((h) => h > bodyHeight * HEADING_SIZE_RATIO)
    .sort((a, b) => b - a);

  const items: NoteItem[] = [];
  const listXs: number[] = []; // x of each open list depth
  let lastWasHeading = false;

  for (const line of kept) {
    const text = line.text.trim();
    const height = Math.round(line.maxHeight * 2) / 2;
    const headingRank = headingHeights.indexOf(height);

    if (headingRank >= 0) {
      const prev = items[items.length - 1];
      if (prev && prev.kind === "heading" && prev.level === headingRank + 1 && lastWasHeading) {
        prev.text += " " + text; // wrapped heading
      } else {
        items.push({ kind: "heading", level: headingRank + 1, text });
      }
      listXs.length = 0;
      lastWasHeading = true;
      continue;
    }

    const isBullet = PDF_BULLET_RE.test(text);
    const isNumber = !isBullet && PDF_NUMBER_RE.test(text);
    if (isBullet || isNumber) {
      const stripped = text.replace(isBullet ? PDF_BULLET_RE : PDF_NUMBER_RE, "");
      let depth = listXs.findIndex((x) => Math.abs(x - line.x) < INDENT_STEP);
      if (depth < 0) {
        depth = listXs.length > 0 && line.x > listXs[listXs.length - 1]! ? listXs.length : 0;
        if (depth === 0) listXs.length = 0;
      }
      listXs.length = depth;
      listXs.push(line.x);
      items.push({ kind: isBullet ? "bullet" : "numbered", depth, text: stripped });
      lastWasHeading = false;
      continue;
    }

    const prev = items[items.length - 1];
    const prevIsList = prev !== undefined && (prev.kind === "bullet" || prev.kind === "numbered");
    // A wrapped list line sits indented past its marker; an unindented line starts a paragraph
    const wrapsPrev =
      prev !== undefined &&
      prev.kind !== "heading" &&
      !TERMINAL_PUNCT_RE.test(prev.text) &&
      (!prevIsList || line.x > listXs[listXs.length - 1]! + INDENT_STEP);
    if (wrapsPrev) {
      prev.text += " " + text; // wrapped line
    } else {
      items.push({ kind: "paragraph", text });
      listXs.length = 0;
    }
    lastWasHeading = false;
  }

  return finish(items);
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export async function convertNotesFile(
  originalName: string,
  buffer: Buffer,
): Promise<NotesConversionResult> {
  switch (path.extname(originalName).toLowerCase()) {
    case ".pdf":
      return convertPdfNotes(buffer);
    case ".md":
    case ".markdown":
      return convertMarkdownNotes(buffer.toString("utf8"));
    case ".docx":
      return convertDocxNotes(buffer);
    default:
      return { ok: false, error: NOTES_CONVERSION_ERRORS.unsupportedType };
  }
}
