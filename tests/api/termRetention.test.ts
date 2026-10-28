import { describe, it, expect } from "vitest";
import {
  extractAbbreviations,
  retainTerms,
  buildSubjectGlossary,
  isMedicalLooking,
} from "../../src/shared/termRetention.js";

// ─ Schwartz-Hearst ────────────────────────────────────────────────────────

describe("extractAbbreviations", () => {
  it('extracts "articulación temporomandibular" from "articulación temporomandibular (ATM)"', () => {
    const pairs = extractAbbreviations("La articulación temporomandibular (ATM) es compleja.");
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const atm = pairs.find((p) => p.abbr === "ATM");
    expect(atm).toBeTruthy();
    expect(atm!.longForm.toLowerCase()).toContain("articulaci");
    expect(atm!.longForm.toLowerCase()).toContain("temporomandibular");
  });

  it("extracts abbreviation from parenthetical at end of long form", () => {
    const pairs = extractAbbreviations("El sistema nervioso central (SNC) controla el cuerpo.");
    const snc = pairs.find((p) => p.abbr === "SNC");
    expect(snc).toBeTruthy();
  });

  it("ignores all-lowercase content in parentheses", () => {
    const pairs = extractAbbreviations("El resultado (positivo) fue claro.");
    expect(pairs.length).toBe(0);
  });

  it("handles multiple abbreviations in text", () => {
    const pairs = extractAbbreviations(
      "La articulación temporomandibular (ATM) y el sistema nervioso central (SNC) son importantes.",
    );
    expect(pairs.map((p) => p.abbr)).toContain("ATM");
    expect(pairs.map((p) => p.abbr)).toContain("SNC");
  });
});

// ─ retainTerms — golden fixture ──────────────────────────────────────────

describe("retainTerms golden fixture", () => {
  it("diente is dropped as a common word (rank ≤5000)", () => {
    const [r] = retainTerms(["diente"]);
    expect(r!.kept).toBe(false);
    expect(r!.reason).toBe("common_word");
  });

  it("pronatismo is kept (rarity + suffix signals)", () => {
    const [r] = retainTerms(["pronatismo"]);
    expect(r!.kept).toBe(true);
    // rarity: absent from frequency list → rarity signal
    expect(r!.signals).toContain("rarity");
    // suffix: -ismo → suffix signal
    expect(r!.signals).toContain("suffix");
  });

  it("ATM is kept (abbreviation signal)", () => {
    const [r] = retainTerms(["ATM"]);
    expect(r!.kept).toBe(true);
    expect(r!.signals).toContain("abbreviation");
  });

  it("carcinoma is kept (suffix -oma and rarity signals)", () => {
    const [r] = retainTerms(["carcinoma"]);
    expect(r!.kept).toBe(true);
    expect(r!.signals).toContain("suffix");
  });

  it("cóndilo is kept (anatomic signal)", () => {
    const [r] = retainTerms(["cóndilo"]);
    expect(r!.kept).toBe(true);
    expect(r!.signals).toContain("anatomic");
  });

  it("tibia is dropped with no_signal (rank 5001-7000, no other signals)", () => {
    const [r] = retainTerms(["tibia"]);
    expect(r!.kept).toBe(false);
    expect(r!.reason).toBe("no_signal");
    // Not anatomic (below neck), not suffix (-ia is not a medical suffix), not abbreviation
    expect(r!.signals).toHaveLength(0);
  });

  it("turismo is dropped as a common word (common-word gate overrides -ismo suffix)", () => {
    const [r] = retainTerms(["turismo"]);
    expect(r!.kept).toBe(false);
    expect(r!.reason).toBe("common_word");
  });

  it("a word absent from the frequency list is kept by rarity signal", () => {
    const [r] = retainTerms(["pronatismo"]);
    expect(r!.kept).toBe(true);
    expect(r!.signals).toContain("rarity");
  });

  it("tokens under 3 characters are dropped (unless abbreviation)", () => {
    const results = retainTerms(["de", "la", "en"]);
    for (const r of results) {
      expect(r.kept).toBe(false);
      expect(r.reason).toBe("too_short");
    }
  });

  it("abbreviations (2-6 uppercase letters) are exempt from length rule", () => {
    const [r] = retainTerms(["ATM"]);
    expect(r!.kept).toBe(true);
    // ATM is 3 chars — would be dropped as too_short if not an abbreviation
  });

  it("numeric tokens are dropped", () => {
    const results = retainTerms(["123", "2024", "3.14"]);
    for (const r of results) {
      expect(r.kept).toBe(false);
      expect(r.reason).toBe("numeric");
    }
  });

  it("deduplication is case- and accent-insensitive, keeping first-seen casing", () => {
    const results = retainTerms(["Cóndilo", "cóndilo", "CONDILO"]);
    // All three are the same term accent-folded
    expect(results).toHaveLength(1);
    expect(results[0]!.term).toBe("Cóndilo"); // first-seen casing
  });

  it("a word with suffix -itis is kept", () => {
    const [r] = retainTerms(["periodontitis"]);
    expect(r!.kept).toBe(true);
    expect(r!.signals).toContain("suffix");
  });
});

// ─ buildSubjectGlossary ───────────────────────────────────────────────────

describe("buildSubjectGlossary", () => {
  it("returns an array of strings", () => {
    const glossary = buildSubjectGlossary(
      "La articulación temporomandibular (ATM) presenta periodontitis y osteoartrosis.",
    );
    expect(Array.isArray(glossary)).toBe(true);
  });

  it("includes ATM from Schwartz-Hearst extraction", () => {
    const glossary = buildSubjectGlossary(
      "La articulación temporomandibular (ATM) es la articulación más compleja.",
    );
    expect(glossary.some((t) => t === "ATM" || t.toLowerCase().includes("temporomandibular"))).toBe(true);
  });

  it("drops common words like diente", () => {
    const glossary = buildSubjectGlossary("El diente tiene esmalte y dentina.");
    expect(glossary).not.toContain("diente");
  });

  it("includes anatomical terms like esmalte", () => {
    const glossary = buildSubjectGlossary("El diente tiene esmalte y dentina.");
    // esmalte and dentina are in the head-neck lexicon
    const lower = glossary.map((t) => t.toLowerCase());
    expect(lower.some((t) => t === "esmalte" || t === "dentina")).toBe(true);
  });

  it("deduplicates terms", () => {
    const text = "La osteoartrosis es una enfermedad. La osteoartrosis afecta articulaciones.";
    const glossary = buildSubjectGlossary(text);
    const lowerGlossary = glossary.map((t) => t.toLowerCase());
    const unique = new Set(lowerGlossary);
    expect(unique.size).toBe(lowerGlossary.length);
  });

  it("returns empty array for empty text", () => {
    expect(buildSubjectGlossary("")).toHaveLength(0);
    expect(buildSubjectGlossary("   ")).toHaveLength(0);
  });
});

// ─ isMedicalLooking ──────────────────────────────────────────────────────

describe("isMedicalLooking", () => {
  it("returns true for cóndilo (anatomic)", () => {
    expect(isMedicalLooking("cóndilo")).toBe(true);
  });

  it("returns true for ATM (abbreviation)", () => {
    expect(isMedicalLooking("ATM")).toBe(true);
  });

  it("returns true for periodontitis (suffix -itis)", () => {
    expect(isMedicalLooking("periodontitis")).toBe(true);
  });

  it("returns false for diente (common word)", () => {
    expect(isMedicalLooking("diente")).toBe(false);
  });

  it("returns false for tibia (no_signal)", () => {
    expect(isMedicalLooking("tibia")).toBe(false);
  });

  it("respects flagSignals config — can narrow to suffix only", () => {
    // cóndilo is anatomic but NOT a suffix term; with only suffix signal it should be false
    expect(isMedicalLooking("cóndilo", { flagSignals: ["suffix"] })).toBe(false);
    // periodontitis has suffix -itis; with only suffix signal it should be true
    expect(isMedicalLooking("periodontitis", { flagSignals: ["suffix"] })).toBe(true);
  });
});
