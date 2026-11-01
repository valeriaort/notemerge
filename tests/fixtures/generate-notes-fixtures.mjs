// Regenerates notes.md, notes.docx, notes.pdf and notes-scanned.pdf in this directory.
// Run: node tests/fixtures/generate-notes-fixtures.mjs
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import JSZip from "jszip";

const dir = path.dirname(fileURLToPath(import.meta.url));

// Shared outline: [kind, text, depth/level]
const OUTLINE = [
  ["h", "Sistema cardiovascular", 1],
  ["p", "Apuntes de la clase sobre el corazon."],
  ["h", "Anatomia", 2],
  ["b", "Cuatro cavidades", 0],
  ["b", "Auriculas", 1],
  ["b", "Ventriculos", 1],
  ["b", "Valvulas", 0],
  ["h", "Fisiologia", 2],
  ["n", "Sistole", 0],
  ["n", "Diastole", 0],
  ["p", "Recordar que el gasto cardiaco es frecuencia por volumen sistolico."],
];

// ── Markdown ────────────────────────────────────────────────────────────────
writeFileSync(
  path.join(dir, "notes.md"),
  `# Sistema cardiovascular

Apuntes de la **clase** sobre el *corazón*.

## Anatomía

- Cuatro cavidades
  - Aurículas
  - Ventrículos
- Válvulas

## Fisiología

1. Sístole
2. Diástole

Recordar que el gasto cardiaco es frecuencia por volumen sistólico.
`,
);

// ── DOCX ────────────────────────────────────────────────────────────────────
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const para = (text, { style, num } = {}) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${
    num ? `<w:numPr><w:ilvl w:val="${num.ilvl}"/><w:numId w:val="${num.id}"/></w:numPr>` : ""
  }</w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;

const docBody = [
  para("Sistema cardiovascular", { style: "Heading1" }),
  para("Apuntes de la clase sobre el corazón."),
  para("Anatomía", { style: "Heading2" }),
  para("Cuatro cavidades", { num: { id: 1, ilvl: 0 } }),
  para("Aurículas", { num: { id: 1, ilvl: 1 } }),
  para("Ventrículos", { num: { id: 1, ilvl: 1 } }),
  para("Válvulas", { num: { id: 1, ilvl: 0 } }),
  para("Fisiología", { style: "Heading2" }),
  para("Sístole", { num: { id: 2, ilvl: 0 } }),
  para("Diástole", { num: { id: 2, ilvl: 0 } }),
  para("Recordar que el gasto cardiaco es frecuencia por volumen sistólico."),
].join("");

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const level = (ilvl, fmt) =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${fmt === "bullet" ? "•" : "%" + (ilvl + 1) + "."}"/></w:lvl>`;
const zip = new JSZip();
zip.file(
  "[Content_Types].xml",
  `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
);
zip.file(
  "_rels/.rels",
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
);
zip.file(
  "word/_rels/document.xml.rels",
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
);
zip.file(
  "word/styles.xml",
  `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style></w:styles>`,
);
zip.file(
  "word/numbering.xml",
  `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0">${level(0, "bullet")}${level(1, "bullet")}</w:abstractNum><w:abstractNum w:abstractNumId="1">${level(0, "decimal")}${level(1, "decimal")}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
);
zip.file(
  "word/document.xml",
  `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${docBody}</w:body></w:document>`,
);
writeFileSync(
  path.join(dir, "notes.docx"),
  await zip.generateAsync({ type: "nodebuffer", compression: "STORE", platform: "UNIX" }),
);

// ── PDF ─────────────────────────────────────────────────────────────────────
function buildPdf(pages) {
  const n = pages.length;
  const numObjs = 3 + n * 2;
  const bodies = [""];
  bodies.push(`<</Type /Catalog /Pages 2 0 R>>`);
  bodies.push(`<</Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${n}>>`);
  bodies.push(`<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>`);
  pages.forEach((items, i) => {
    let stream = "";
    for (const { text, x, y, size } of items) {
      const e = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
      stream += `BT /F1 ${size} Tf ${x} ${y} Td (${e}) Tj ET\n`;
    }
    bodies.push(
      `<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources <</Font <</F1 3 0 R>>>>>>`,
    );
    bodies.push(`<</Length ${stream.length}>>\nstream\n${stream}endstream`);
  });
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i <= numObjs; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${bodies[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${numObjs + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= numObjs; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${numObjs + 1} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

const page1 = [];
let y = 740;
const put = (text, x, size) => { page1.push({ text, x, y, size }); y -= size + 10; };
put("Sistema cardiovascular", 50, 24);
put("Apuntes de la clase sobre el corazon.", 50, 12);
put("Anatomia", 50, 18);
put("- Cuatro cavidades", 50, 12);
put("- Auriculas", 80, 12);
put("- Ventriculos", 80, 12);
put("- Valvulas", 50, 12);
const page2 = [];
y = 740;
page2.push(...[]);
const put2 = (text, x, size) => { page2.push({ text, x, y, size }); y -= size + 10; };
put2("Fisiologia", 50, 18);
put2("1. Sistole", 50, 12);
put2("2. Diastole", 50, 12);
put2("Recordar que el gasto cardiaco", 50, 12);
put2("es frecuencia por volumen sistolico.", 50, 12);
writeFileSync(path.join(dir, "notes.pdf"), buildPdf([page1, page2]));

// Pages with no text layer, as a scan would produce
writeFileSync(path.join(dir, "notes-scanned.pdf"), buildPdf([[], [], []]));
