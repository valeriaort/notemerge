import { createRequire } from "module";
import path from "path";

// pdfjs-dist types
type TextItem = {
  str: string;
  dir: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
};

type TextMarkedContent = {
  type: string;
  id: string;
};

type TextContent = {
  items: Array<TextItem | TextMarkedContent>;
};

export type SlideBullet = {
  id: string;   // e.g. "S013-B02"
  text: string;
};

export type ExtractedSlide = {
  id: string;           // e.g. "S013"
  title: string | null;
  bullets: SlideBullet[];
};

export type ExtractionResult =
  | { ok: true; slides: ExtractedSlide[] }
  | { ok: false; error: string };

export type TextExtractionResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

// Lines on more than this fraction of pages are treated as repeated (header/footer)
const REPEAT_THRESHOLD = 0.5;

// A page with fewer than this many non-empty items counts as having no text
const MIN_ITEMS_FOR_TEXT = 1;

// Minimum fraction of pages with text before we reject as scanned
const SCAN_THRESHOLD = 0.3;

// Max y-delta to group items into the same line
const LINE_GROUP_DELTA = 2;

const BULLET_GLYPH_RE = /^[•●◦▪▸·→\-*]\s*/;
const BULLET_NUMBER_RE = /^(?:\d+[.)]\s*|[a-zA-Z][.)]\s*)/;
const TERMINAL_PUNCT_RE = /[.!?:;]$/;
// Bare page-number line: optional whitespace, one or more digits, optional whitespace
const PAGE_NUMBER_RE = /^\s*\d+\s*$/;

function isTextItem(item: TextItem | TextMarkedContent): item is TextItem {
  return "str" in item;
}

type PageLine = {
  text: string;
  maxHeight: number;
  y: number;
  x: number;
};

async function getPdfjs() {
  const require = createRequire(import.meta.url);
  const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const pdfjsDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const standardFontsDir = path.join(pdfjsDir, "standard_fonts") + "/";

  // Dynamic import to avoid worker URL issues at module load time
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs") as typeof import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(`file://${workerPath}`).href;
  return { pdfjs, standardFontsDir };
}

function groupIntoLines(items: TextItem[]): PageLine[] {
  // Filter empty strings
  const valid = items.filter((it) => it.str.trim().length > 0);

  const lines: PageLine[] = [];

  for (const item of valid) {
    const x = item.transform[4]!;
    const y = item.transform[5]!;
    const height = item.height;

    // Find a line with a close y value
    const existing = lines.find((l) => Math.abs(l.y - y) <= LINE_GROUP_DELTA);
    if (existing) {
      existing.text += item.str;
      existing.maxHeight = Math.max(existing.maxHeight, height);
      existing.x = Math.min(existing.x, x);
    } else {
      lines.push({ text: item.str, maxHeight: height, y, x });
    }
  }

  // Sort top-to-bottom (high y = top in PDF coordinates), then left-to-right
  lines.sort((a, b) => b.y - a.y || a.x - b.x);

  return lines;
}

function parseBullets(lines: PageLine[], slideIndex: number): SlideBullet[] {
  const bullets: SlideBullet[] = [];
  let bulletIndex = 0;

  for (const line of lines) {
    let text = line.text.trim();
    if (!text) continue;

    const startsWithGlyph = BULLET_GLYPH_RE.test(text);
    const startsWithNumber = BULLET_NUMBER_RE.test(text);

    if (startsWithGlyph || startsWithNumber) {
      // Strip leading glyph or number
      text = text.replace(BULLET_GLYPH_RE, "").replace(BULLET_NUMBER_RE, "").trim();
      bulletIndex++;
      const id = `S${String(slideIndex).padStart(3, "0")}-B${String(bulletIndex).padStart(2, "0")}`;
      bullets.push({ id, text });
    } else if (bullets.length > 0) {
      const last = bullets[bullets.length - 1]!;
      if (!TERMINAL_PUNCT_RE.test(last.text)) {
        // Join this line to the previous bullet (it's a continuation)
        last.text = last.text + " " + text;
      } else {
        // Previous bullet ended; start a new bullet
        bulletIndex++;
        const id = `S${String(slideIndex).padStart(3, "0")}-B${String(bulletIndex).padStart(2, "0")}`;
        bullets.push({ id, text });
      }
    } else {
      // No bullets yet — treat as the first bullet
      bulletIndex++;
      const id = `S${String(slideIndex).padStart(3, "0")}-B${String(bulletIndex).padStart(2, "0")}`;
      bullets.push({ id, text });
    }
  }

  return bullets;
}

// Extract the plain text of a PDF (all pages, reading order).
// Uses the same pdfjs engine as slide extraction so the app depends on a
// single PDF library — mixing a second one (e.g. pdf-parse, which pins an
// older pdfjs) corrupts the shared pdfjs worker and breaks both features.
export async function extractTextFromPdf(buffer: Buffer): Promise<TextExtractionResult> {
  const { pdfjs, standardFontsDir } = await getPdfjs();

  let pdfDoc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      useSystemFonts: true,
      disableFontFace: true,
      standardFontDataUrl: `file://${standardFontsDir}`,
    });
    pdfDoc = await loadingTask.promise;
  } catch {
    return { ok: false, error: "Failed to parse PDF." };
  }

  const parts: string[] = [];
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const textContent: TextContent = await page.getTextContent() as TextContent;
    const pageText = textContent.items
      .filter(isTextItem)
      .map((it) => it.str)
      .join(" ");
    parts.push(pageText);
  }

  return { ok: true, text: parts.join("\n") };
}

export async function extractSlidesFromPdf(buffer: Buffer): Promise<ExtractionResult> {
  const { pdfjs, standardFontsDir } = await getPdfjs();

  let pdfDoc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useWorkerFetch: false,
      useSystemFonts: true,
      disableFontFace: true,
      standardFontDataUrl: `file://${standardFontsDir}`,
    });
    pdfDoc = await loadingTask.promise;
  } catch (err) {
    return { ok: false, error: "Failed to parse PDF." };
  }

  const numPages = pdfDoc.numPages;

  // Extract lines per page
  const allPageLines: PageLine[][] = [];
  let pagesWithText = 0;

  for (let p = 1; p <= numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const textContent: TextContent = await page.getTextContent() as TextContent;
    const textItems = textContent.items.filter(isTextItem);
    const lines = groupIntoLines(textItems);
    allPageLines.push(lines);
    if (textItems.filter((it) => it.str.trim().length > 0).length >= MIN_ITEMS_FOR_TEXT) {
      pagesWithText++;
    }
  }

  // Reject scanned PDFs: fewer than SCAN_THRESHOLD of pages have extractable text
  if (numPages > 1 && pagesWithText / numPages < SCAN_THRESHOLD) {
    return {
      ok: false,
      error: "This PDF appears to contain scanned images with no extractable text. OCR is not supported.",
    };
  }

  // Find lines that repeat on more than REPEAT_THRESHOLD of pages
  const lineFreq = new Map<string, number>();
  for (const pageLines of allPageLines) {
    const seenOnPage = new Set<string>();
    for (const line of pageLines) {
      const key = line.text.trim().toLowerCase();
      if (key && !seenOnPage.has(key)) {
        seenOnPage.add(key);
        lineFreq.set(key, (lineFreq.get(key) ?? 0) + 1);
      }
    }
  }

  const repeatedLines = new Set<string>();
  for (const [text, count] of lineFreq) {
    if (count >= 2 && count / numPages > REPEAT_THRESHOLD) {
      repeatedLines.add(text);
    }
  }

  // Build slides
  const slides: ExtractedSlide[] = [];

  for (let p = 0; p < numPages; p++) {
    const slideIndex = p + 1;
    const id = `S${String(slideIndex).padStart(3, "0")}`;

    const lines = allPageLines[p]!;

    // Filter out repeated lines and bare page numbers
    const filteredLines = lines.filter((line) => {
      const key = line.text.trim().toLowerCase();
      if (!key) return false;
      if (repeatedLines.has(key)) return false;
      if (PAGE_NUMBER_RE.test(line.text)) return false;
      return true;
    });

    if (filteredLines.length === 0) {
      // Slide with no text — valid, no bullets
      slides.push({ id, title: null, bullets: [] });
      continue;
    }

    // Find title: the line with the maximum font height
    // On ties, take the topmost (highest y, which is first after sorting)
    const maxHeight = Math.max(...filteredLines.map((l) => l.maxHeight));
    const titleLineIdx = filteredLines.findIndex((l) => l.maxHeight === maxHeight);
    const titleLine = filteredLines[titleLineIdx]!;
    const title = titleLine.text.trim() || null;

    // Remaining lines become bullets
    const bulletLines = filteredLines.filter((_, i) => i !== titleLineIdx);
    const bullets = parseBullets(bulletLines, slideIndex);

    slides.push({ id, title, bullets });
  }

  return { ok: true, slides };
}
