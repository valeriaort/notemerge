import { describe, it, expect } from "vitest";
import { expandAbbreviations, expandNotesData, extractTextFromNotesData } from "../../src/shared/abbreviationExpansion.js";
import type { AbbreviationPair } from "../../src/shared/types.js";

function pair(
  abbreviation: string,
  expansion: string,
  matchCaseExactly = false,
): AbbreviationPair {
  return {
    id: "id",
    userId: "u",
    abbreviation,
    expansion,
    matchCaseExactly,
    createdAt: 0,
  };
}

describe("expandAbbreviations — whole-token matching", () => {
  it("expands an abbreviation that appears as a whole token", () => {
    const result = expandAbbreviations("El pc late rápido", [pair("pc", "paciente")]);
    expect(result).toBe("El paciente late rápido");
  });

  it("does NOT expand an abbreviation that appears inside a longer word", () => {
    const result = expandAbbreviations("pcr positivo", [pair("pc", "paciente")]);
    expect(result).toBe("pcr positivo");
  });

  it("does NOT expand when the abbreviation is a suffix of another word", () => {
    const result = expandAbbreviations("apc test", [pair("pc", "paciente")]);
    expect(result).toBe("apc test");
  });

  it("expands multiple occurrences", () => {
    const result = expandAbbreviations("pc y pc", [pair("pc", "paciente")]);
    expect(result).toBe("paciente y paciente");
  });
});

describe("expandAbbreviations — case insensitivity", () => {
  it("matches uppercase abbreviation case-insensitively by default", () => {
    const result = expandAbbreviations("PC late bien", [pair("pc", "paciente")]);
    // PC is all-caps → expansion is uppercased
    expect(result).toBe("PACIENTE late bien");
  });

  it("capitalised token → capitalised expansion", () => {
    const result = expandAbbreviations("Pc late bien", [pair("pc", "paciente")]);
    expect(result).toBe("Paciente late bien");
  });

  it("all-caps token → all-caps expansion", () => {
    const result = expandAbbreviations("PC late bien", [pair("pc", "paciente")]);
    expect(result).toBe("PACIENTE late bien");
  });

  it("lowercase token stays lowercase expansion", () => {
    const result = expandAbbreviations("pc late", [pair("pc", "paciente")]);
    expect(result).toBe("paciente late");
  });
});

describe("expandAbbreviations — match case exactly", () => {
  it("does NOT match different-case token when matchCaseExactly=true", () => {
    const result = expandAbbreviations("PC late", [pair("pc", "paciente", true)]);
    expect(result).toBe("PC late");
  });

  it("matches exact case when matchCaseExactly=true", () => {
    const result = expandAbbreviations("pc late", [pair("pc", "paciente", true)]);
    expect(result).toBe("paciente late");
  });
});

describe("expandAbbreviations — capitalisation rule", () => {
  it("Pc → Paciente (first-letter capitalisation transferred)", () => {
    const result = expandAbbreviations("Pc positivo", [pair("pc", "paciente")]);
    expect(result).toBe("Paciente positivo");
  });

  it("pc → paciente (no change)", () => {
    const result = expandAbbreviations("pc positivo", [pair("pc", "paciente")]);
    expect(result).toBe("paciente positivo");
  });

  it("HTA (all-caps in text, lowercase in pair) → HIPERTENSIÓN ARTERIAL", () => {
    const result = expandAbbreviations("diag. de HTA grave", [pair("hta", "hipertensión arterial")]);
    expect(result).toBe("diag. de HIPERTENSIÓN ARTERIAL grave");
  });

  it("HTA (all-caps) → HIPERTENSIÓN ARTERIAL with all-caps pair", () => {
    const result = expandAbbreviations("HTA GRAVE", [pair("HTA", "hipertensión arterial")]);
    expect(result).toContain("HIPERTENSIÓN ARTERIAL");
  });
});

describe("expandAbbreviations — multi-token abbreviations longest first", () => {
  it("matches the longer multi-token abbreviation when shorter would also match", () => {
    const pairs = [
      pair("fc", "frecuencia cardiaca"),
      pair("fc basal", "frecuencia cardiaca basal"),
    ];
    const result = expandAbbreviations("fc basal elevada", pairs);
    expect(result).toBe("frecuencia cardiaca basal elevada");
  });

  it("falls back to shorter abbreviation when longer does not match", () => {
    const pairs = [
      pair("fc", "frecuencia cardiaca"),
      pair("fc basal", "frecuencia cardiaca basal"),
    ];
    const result = expandAbbreviations("fc elevada", pairs);
    expect(result).toBe("frecuencia cardiaca elevada");
  });
});

describe("expandNotesData — document expansion", () => {
  function makeDoc(text: string): string {
    return JSON.stringify({
      blocks: [
        {
          id: "b1",
          type: "paragraph",
          props: {},
          content: [{ type: "text", text, styles: {} }],
          children: [],
        },
      ],
      meta: { b1: { firstEditTime: 1000, lastEditTime: 1000 } },
    });
  }

  it("expands text inside BlockNote document blocks", () => {
    const doc = makeDoc("el pc llegó");
    const expanded = expandNotesData(doc, [pair("pc", "paciente")]);
    const parsed = JSON.parse(expanded);
    expect(parsed.blocks[0].content[0].text).toBe("el paciente llegó");
  });

  it("does NOT mutate the original document JSON string", () => {
    const doc = makeDoc("el pc llegó");
    const expanded = expandNotesData(doc, [pair("pc", "paciente")]);
    expect(doc).not.toBe(expanded);
    // original is unchanged
    const original = JSON.parse(doc);
    expect(original.blocks[0].content[0].text).toBe("el pc llegó");
  });

  it("preserves block IDs and meta", () => {
    const doc = makeDoc("pc");
    const expanded = expandNotesData(doc, [pair("pc", "paciente")]);
    const parsed = JSON.parse(expanded);
    expect(parsed.blocks[0].id).toBe("b1");
    expect(parsed.meta.b1.firstEditTime).toBe(1000);
  });

  it("returns the document unchanged when pairs is empty", () => {
    const doc = makeDoc("el pc llegó");
    const result = expandNotesData(doc, []);
    expect(result).toBe(doc);
  });

  it("expands text in nested children", () => {
    const docObj = {
      blocks: [
        {
          id: "parent",
          type: "bulletListItem",
          props: {},
          content: [{ type: "text", text: "parent pc", styles: {} }],
          children: [
            {
              id: "child",
              type: "bulletListItem",
              props: {},
              content: [{ type: "text", text: "child pc", styles: {} }],
              children: [],
            },
          ],
        },
      ],
      meta: {},
    };
    const expanded = expandNotesData(JSON.stringify(docObj), [pair("pc", "paciente")]);
    const parsed = JSON.parse(expanded);
    expect(parsed.blocks[0].content[0].text).toBe("parent paciente");
    expect(parsed.blocks[0].children[0].content[0].text).toBe("child paciente");
  });
});

describe("extractTextFromNotesData", () => {
  it("extracts all text from document blocks", () => {
    const doc = JSON.stringify({
      blocks: [
        {
          id: "b1",
          type: "paragraph",
          content: [{ type: "text", text: "hello world", styles: {} }],
          children: [],
        },
      ],
      meta: {},
    });
    expect(extractTextFromNotesData(doc)).toBe("hello world");
  });

  it("handles empty document", () => {
    const doc = JSON.stringify({ blocks: [], meta: {} });
    expect(extractTextFromNotesData(doc)).toBe("");
  });
});
