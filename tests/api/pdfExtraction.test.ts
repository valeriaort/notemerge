import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { extractSlidesFromPdf } from "../../src/server/pdfExtraction.js";

const FIXTURES = path.resolve("tests/fixtures");

// Builds a minimal valid PDF from page descriptors. Each page has an array of
// text items placed with separate BT...ET operators (one per item).
function buildTestPdf(
  pages: Array<{ texts: Array<{ text: string; y: number; size: number }> }>,
): Buffer {
  const n = pages.length;
  const numObjs = 3 + n * 2;

  // Object layout: 1=Catalog, 2=Pages, 3=Font, then (4,5),(6,7),... = (page,content) pairs
  const objBodies: string[] = [""];

  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objBodies.push(`<</Type /Catalog /Pages 2 0 R>>`);
  objBodies.push(`<</Type /Pages /Kids [${kids}] /Count ${n}>>`);
  objBodies.push(`<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>`);

  for (let i = 0; i < n; i++) {
    const contentObjNum = 5 + i * 2;
    let stream = "";
    for (const { text, y, size } of pages[i]!.texts) {
      const esc = text
        .replace(/\\/g, "\\\\")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)");
      stream += `BT /F1 ${size} Tf 50 ${y} Td (${esc}) Tj ET\n`;
    }
    objBodies.push(
      `<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjNum} 0 R /Resources <</Font <</F1 3 0 R>>>>>>`,
    );
    objBodies.push(
      `<</Length ${stream.length}>>\nstream\n${stream}endstream`,
    );
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
  for (let i = 1; i <= numObjs; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<</Size ${numObjs + 1} /Root 1 0 R>>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, "binary");
}

// ── text_slides.pdf fixture ────────────────────────────────────────────────

describe("extractSlidesFromPdf — text_slides.pdf fixture", () => {
  it("returns ok and exactly 3 slides", async () => {
    const buf = readFileSync(path.join(FIXTURES, "text_slides.pdf"));
    const result = await extractSlidesFromPdf(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slides).toHaveLength(3);
  });

  it("assigns padded slide IDs S001, S002, S003", async () => {
    const buf = readFileSync(path.join(FIXTURES, "text_slides.pdf"));
    const result = await extractSlidesFromPdf(buf);
    if (!result.ok) return;
    expect(result.slides.map((s) => s.id)).toEqual(["S001", "S002", "S003"]);
  });

  it("extracts the largest-font line as title for S001", async () => {
    const buf = readFileSync(path.join(FIXTURES, "text_slides.pdf"));
    const result = await extractSlidesFromPdf(buf);
    if (!result.ok) return;
    expect(result.slides[0]!.title).toBe("Slide Title One");
  });

  it("S001 has 3 bullets with IDs S001-B01, S001-B02, S001-B03", async () => {
    const buf = readFileSync(path.join(FIXTURES, "text_slides.pdf"));
    const result = await extractSlidesFromPdf(buf);
    if (!result.ok) return;
    const bullets = result.slides[0]!.bullets;
    expect(bullets).toHaveLength(3);
    expect(bullets.map((b) => b.id)).toEqual([
      "S001-B01",
      "S001-B02",
      "S001-B03",
    ]);
  });

  it("S003 has no bullets (slide with no bullet lines is valid)", async () => {
    const buf = readFileSync(path.join(FIXTURES, "text_slides.pdf"));
    const result = await extractSlidesFromPdf(buf);
    if (!result.ok) return;
    expect(result.slides[2]!.bullets).toHaveLength(0);
  });

  it("removes the repeated footer that appears on every page", async () => {
    const buf = readFileSync(path.join(FIXTURES, "text_slides.pdf"));
    const result = await extractSlidesFromPdf(buf);
    if (!result.ok) return;
    for (const slide of result.slides) {
      expect(slide.title).not.toBe("Repeated Footer");
      expect(slide.bullets.map((b) => b.text)).not.toContain("Repeated Footer");
    }
  });
});

// ── mostly_empty.pdf fixture ───────────────────────────────────────────────

describe("extractSlidesFromPdf — mostly_empty.pdf fixture", () => {
  it("returns 3 slides even though most pages have no text", async () => {
    const buf = readFileSync(path.join(FIXTURES, "mostly_empty.pdf"));
    const result = await extractSlidesFromPdf(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slides).toHaveLength(3);
  });

  it("slides with no text have no bullets", async () => {
    const buf = readFileSync(path.join(FIXTURES, "mostly_empty.pdf"));
    const result = await extractSlidesFromPdf(buf);
    if (!result.ok) return;
    expect(result.slides[1]!.bullets).toHaveLength(0);
    expect(result.slides[2]!.bullets).toHaveLength(0);
  });
});

// ── single_page.pdf fixture ────────────────────────────────────────────────

describe("extractSlidesFromPdf — single_page.pdf fixture", () => {
  it("returns 1 slide", async () => {
    const buf = readFileSync(path.join(FIXTURES, "single_page.pdf"));
    const result = await extractSlidesFromPdf(buf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slides).toHaveLength(1);
  });

  it("extracts the largest-font line as the title", async () => {
    const buf = readFileSync(path.join(FIXTURES, "single_page.pdf"));
    const result = await extractSlidesFromPdf(buf);
    if (!result.ok) return;
    expect(result.slides[0]!.title).toBe("BIG TITLE HERE");
  });

  it("bare page number at the bottom is not included as a bullet", async () => {
    const buf = readFileSync(path.join(FIXTURES, "single_page.pdf"));
    const result = await extractSlidesFromPdf(buf);
    if (!result.ok) return;
    const allText = result.slides
      .flatMap((s) => [s.title, ...s.bullets.map((b) => b.text)])
      .filter(Boolean)
      .join(" ");
    expect(allText).not.toMatch(/^\s*1\s*$/);
  });
});

// ── scanned PDF rejection ──────────────────────────────────────────────────

describe("extractSlidesFromPdf — scanned PDF rejection", () => {
  it("rejects a PDF with no extractable text on most pages", async () => {
    const buf = buildTestPdf([
      { texts: [] },
      { texts: [] },
      { texts: [] },
      { texts: [] },
    ]);
    const result = await extractSlidesFromPdf(buf);
    expect(result.ok).toBe(false);
  });

  it("error message mentions scanned images or OCR", async () => {
    const buf = buildTestPdf([
      { texts: [] },
      { texts: [] },
      { texts: [] },
      { texts: [] },
    ]);
    const result = await extractSlidesFromPdf(buf);
    if (result.ok) return;
    expect(result.error.toLowerCase()).toMatch(/scanned|ocr|no extractable text/);
  });
});

// ── 60+ page fixture ───────────────────────────────────────────────────────

describe("extractSlidesFromPdf — 65-page PDF", () => {
  function build65Pages() {
    const pages = [];
    for (let i = 1; i <= 65; i++) {
      pages.push({
        texts: [
          { text: "Course Header", y: 750, size: 10 },
          { text: `Slide ${i} Title`, y: 700, size: 24 },
          { text: `Bullet for slide ${i}`, y: 640, size: 12 },
          { text: String(i), y: 20, size: 10 },
        ],
      });
    }
    return buildTestPdf(pages);
  }

  it("extracts all 65 slides without error", async () => {
    const result = await extractSlidesFromPdf(build65Pages());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slides).toHaveLength(65);
  });

  it("slide IDs use three-digit zero-padding: S001 through S065", async () => {
    const result = await extractSlidesFromPdf(build65Pages());
    if (!result.ok) return;
    expect(result.slides[0]!.id).toBe("S001");
    expect(result.slides[64]!.id).toBe("S065");
  });

  it("repeated header appearing on all pages is dropped", async () => {
    const result = await extractSlidesFromPdf(build65Pages());
    if (!result.ok) return;
    for (const slide of result.slides) {
      expect(slide.title).not.toBe("Course Header");
      expect(slide.bullets.map((b) => b.text)).not.toContain("Course Header");
    }
  });

  it("bare page numbers are dropped from each slide", async () => {
    const result = await extractSlidesFromPdf(build65Pages());
    if (!result.ok) return;
    for (let i = 0; i < result.slides.length; i++) {
      const slide = result.slides[i]!;
      const num = String(i + 1);
      expect(slide.title).not.toBe(num);
      expect(slide.bullets.map((b) => b.text)).not.toContain(num);
    }
  });

  it("each slide retains its unique title and one bullet", async () => {
    const result = await extractSlidesFromPdf(build65Pages());
    if (!result.ok) return;
    expect(result.slides[0]!.title).toBe("Slide 1 Title");
    expect(result.slides[0]!.bullets[0]!.text).toBe("Bullet for slide 1");
    expect(result.slides[64]!.title).toBe("Slide 65 Title");
    expect(result.slides[64]!.bullets[0]!.text).toBe("Bullet for slide 65");
  });
});

// ── bullet parsing rules ───────────────────────────────────────────────────

describe("extractSlidesFromPdf — bullet glyph and continuation rules", () => {
  it("bullet glyph (-) starts a new bullet and the glyph is stripped", async () => {
    const buf = buildTestPdf([
      {
        texts: [
          { text: "Title", y: 720, size: 24 },
          { text: "- Alpha", y: 670, size: 12 },
          { text: "- Beta", y: 640, size: 12 },
        ],
      },
    ]);
    const result = await extractSlidesFromPdf(buf);
    if (!result.ok) return;
    const bullets = result.slides[0]!.bullets;
    expect(bullets).toHaveLength(2);
    expect(bullets[0]!.text).toBe("Alpha");
    expect(bullets[1]!.text).toBe("Beta");
  });

  it("continuation line (no terminal punctuation on previous) joins the previous bullet", async () => {
    const buf = buildTestPdf([
      {
        texts: [
          { text: "Title", y: 720, size: 24 },
          { text: "- First line", y: 670, size: 12 },
          { text: "continuation", y: 650, size: 12 },
        ],
      },
    ]);
    const result = await extractSlidesFromPdf(buf);
    if (!result.ok) return;
    const bullets = result.slides[0]!.bullets;
    expect(bullets).toHaveLength(1);
    expect(bullets[0]!.text).toBe("First line continuation");
  });

  it("line after terminal punctuation starts a new bullet", async () => {
    const buf = buildTestPdf([
      {
        texts: [
          { text: "Title", y: 720, size: 24 },
          { text: "- First ends.", y: 670, size: 12 },
          { text: "new bullet here", y: 650, size: 12 },
        ],
      },
    ]);
    const result = await extractSlidesFromPdf(buf);
    if (!result.ok) return;
    const bullets = result.slides[0]!.bullets;
    expect(bullets).toHaveLength(2);
    expect(bullets[1]!.text).toBe("new bullet here");
  });

  it("numbered bullet (1. ) starts a new bullet and number is stripped", async () => {
    const buf = buildTestPdf([
      {
        texts: [
          { text: "Title", y: 720, size: 24 },
          { text: "1. First item", y: 670, size: 12 },
          { text: "2. Second item", y: 640, size: 12 },
        ],
      },
    ]);
    const result = await extractSlidesFromPdf(buf);
    if (!result.ok) return;
    const bullets = result.slides[0]!.bullets;
    expect(bullets).toHaveLength(2);
    expect(bullets[0]!.text).toBe("First item");
    expect(bullets[1]!.text).toBe("Second item");
  });

  it("bullet IDs include the slide number: S001-B01, S001-B02", async () => {
    const buf = buildTestPdf([
      {
        texts: [
          { text: "Title", y: 720, size: 24 },
          { text: "- One", y: 670, size: 12 },
          { text: "- Two.", y: 640, size: 12 },
        ],
      },
    ]);
    const result = await extractSlidesFromPdf(buf);
    if (!result.ok) return;
    const bullets = result.slides[0]!.bullets;
    expect(bullets[0]!.id).toBe("S001-B01");
    expect(bullets[1]!.id).toBe("S001-B02");
  });
});
