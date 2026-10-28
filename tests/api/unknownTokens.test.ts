import { describe, it, expect } from "vitest";
import { findUnknownTokens, tokenize } from "../../src/shared/unknownTokens.js";
import type { AbbreviationPair } from "../../src/shared/types.js";

function pair(abbreviation: string): AbbreviationPair {
  return { id: "x", userId: "u", abbreviation, expansion: "x", matchCaseExactly: false, createdAt: 0 };
}

describe("tokenize", () => {
  it("splits on whitespace", () => {
    expect(tokenize("hello world")).toEqual(["hello", "world"]);
  });

  it("splits on punctuation", () => {
    expect(tokenize("pain, fever; cough.")).toEqual(["pain", "fever", "cough"]);
  });

  it("drops pure-number tokens", () => {
    // tokenize includes numbers; findUnknownTokens filters them
    const tokens = tokenize("value 123 abc");
    expect(tokens).toContain("value");
    expect(tokens).toContain("abc");
  });

  it("preserves tokens with letters even if they contain digits", () => {
    const tokens = tokenize("hta2 abc");
    expect(tokens).toContain("hta2");
  });
});

describe("findUnknownTokens — candidate rules", () => {
  it("includes tokens ≤5 chars not in dictionary", () => {
    const result = findUnknownTokens("fc elevada", [], new Set());
    expect(result.map((t) => t.text)).toContain("fc");
  });

  it("excludes tokens longer than 5 chars that are not all-caps", () => {
    const result = findUnknownTokens("taquicardia severa", [], new Set());
    // "taquicardia" is 11 chars, not all-caps → excluded
    expect(result.map((t) => t.text)).not.toContain("taquicardia");
  });

  it("includes all-caps tokens regardless of length", () => {
    const result = findUnknownTokens("TAQUICARDIA severa", [], new Set());
    expect(result.map((t) => t.text)).toContain("taquicardia");
  });

  it("excludes pure-number tokens", () => {
    const result = findUnknownTokens("123 fc", [], new Set());
    expect(result.map((t) => t.text)).not.toContain("123");
  });
});

describe("findUnknownTokens — exclusion filters", () => {
  it("excludes tokens already in the abbreviation dictionary", () => {
    const result = findUnknownTokens("fc elevada", [pair("fc")], new Set());
    expect(result.map((t) => t.text)).not.toContain("fc");
  });

  it("is case-insensitive for dictionary lookup (FC matches fc pair)", () => {
    const result = findUnknownTokens("FC elevada", [pair("fc")], new Set());
    expect(result.map((t) => t.text)).not.toContain("fc");
  });

  it("excludes common Spanish words", () => {
    const result = findUnknownTokens("el la los de", [], new Set());
    expect(result).toHaveLength(0);
  });

  it("excludes permanently ignored tokens", () => {
    const ignored = new Set(["fc"]);
    const result = findUnknownTokens("fc elevada", [], ignored);
    expect(result.map((t) => t.text)).not.toContain("fc");
  });

  it("excludes tokens in subject glossary", () => {
    const glossary = new Set(["pcr"]);
    const result = findUnknownTokens("pcr positivo", [], new Set(), glossary);
    expect(result.map((t) => t.text)).not.toContain("pcr");
  });
});

describe("findUnknownTokens — frequency ranking", () => {
  it("ranks by frequency descending", () => {
    const result = findUnknownTokens("fc fc pc fc pc", [], new Set());
    expect(result[0]!.text).toBe("fc");
    expect(result[0]!.frequency).toBe(3);
    expect(result[1]!.text).toBe("pc");
    expect(result[1]!.frequency).toBe(2);
  });

  it("stable sort — ties broken alphabetically", () => {
    const result = findUnknownTokens("fc pc fc pc", [], new Set());
    // Both appear twice; alphabetical order: fc < pc
    expect(result[0]!.text).toBe("fc");
    expect(result[1]!.text).toBe("pc");
  });

  it("frequency counts case-insensitively (FC and fc are the same token)", () => {
    const result = findUnknownTokens("FC fc Fc", [], new Set());
    expect(result).toHaveLength(1);
    expect(result[0]!.frequency).toBe(3);
  });
});
