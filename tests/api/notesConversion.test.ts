import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { convertNotesFile } from "../../src/server/notesConversion.js";

const FIXTURES = path.resolve("tests/fixtures");

type Shape = { type: string; level?: number; text: string; children: Shape[] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shape(blocks: any[]): Shape[] {
  return blocks.map((b) => ({
    type: b.type,
    ...(b.type === "heading" ? { level: b.props.level } : {}),
    text: b.content.map((c: { text: string }) => c.text).join(""),
    children: shape(b.children),
  }));
}

async function convert(name: string) {
  const result = await convertNotesFile(name, readFileSync(path.join(FIXTURES, name)));
  if (!result.ok) throw new Error(result.error);
  return result.notes;
}

const leaf = (type: string, text: string, children: Shape[] = []): Shape => ({ type, text, children });
const heading = (level: number, text: string): Shape => ({ type: "heading", level, text, children: [] });

function expected(accents: boolean): Shape[] {
  const a = (withAccent: string, plain: string) => (accents ? withAccent : plain);
  return [
    heading(1, "Sistema cardiovascular"),
    leaf("paragraph", a("Apuntes de la clase sobre el corazón.", "Apuntes de la clase sobre el corazon.")),
    heading(2, a("Anatomía", "Anatomia")),
    leaf("bulletListItem", "Cuatro cavidades", [
      leaf("bulletListItem", a("Aurículas", "Auriculas")),
      leaf("bulletListItem", a("Ventrículos", "Ventriculos")),
    ]),
    leaf("bulletListItem", a("Válvulas", "Valvulas")),
    heading(2, a("Fisiología", "Fisiologia")),
    leaf("numberedListItem", a("Sístole", "Sistole")),
    leaf("numberedListItem", a("Diástole", "Diastole")),
    leaf(
      "paragraph",
      a(
        "Recordar que el gasto cardiaco es frecuencia por volumen sistólico.",
        "Recordar que el gasto cardiaco es frecuencia por volumen sistolico.",
      ),
    ),
  ];
}

describe.each([
  ["notes.md", true],
  ["notes.docx", true],
  ["notes.pdf", false],
])("%s conversion", (file, accents) => {
  it("keeps headings, nested lists and paragraphs in document order", async () => {
    const notes = await convert(file);
    expect(shape(notes.blocks as unknown[])).toEqual(expected(accents));
  });

  it("is deterministic in text and structure, with fresh IDs and empty meta", async () => {
    const a = await convert(file);
    const b = await convert(file);
    expect(shape(a.blocks as unknown[])).toEqual(shape(b.blocks as unknown[]));
    expect(a.meta).toEqual({});
    const ids = (a.blocks as Array<{ id: string; children: Array<{ id: string }> }>).flatMap((x) => [
      x.id,
      ...x.children.map((c) => c.id),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });
});

describe("notes conversion errors", () => {
  it("rejects a scanned PDF with a clear message", async () => {
    const result = await convertNotesFile("notes-scanned.pdf", readFileSync(path.join(FIXTURES, "notes-scanned.pdf")));
    expect(result).toEqual({ ok: false, error: expect.stringContaining("scanned") });
  });

  it("rejects an unsupported extension", async () => {
    const result = await convertNotesFile("notes.txt", Buffer.from("hola"));
    expect(result.ok).toBe(false);
  });

  it("rejects an empty Markdown file", async () => {
    const result = await convertNotesFile("notes.md", Buffer.from("  \n"));
    expect(result.ok).toBe(false);
  });
});
