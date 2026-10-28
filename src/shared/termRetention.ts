import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "../../data/terms");

// ─ Data loading (lazy, cached) ─────────────────────────────────────────────

let _frequencyMap: Map<string, number> | null = null;
let _headNeckSet: Set<string> | null = null;
let _suffixes: string[] | null = null;

function frequencyMap(): Map<string, number> {
  if (!_frequencyMap) {
    const lines = readFileSync(path.join(DATA_DIR, "frequency.txt"), "utf8").split("\n");
    _frequencyMap = new Map();
    for (let i = 0; i < lines.length; i++) {
      const w = lines[i]!.trim().toLowerCase();
      if (w) _frequencyMap.set(w, i + 1); // rank is 1-indexed
    }
  }
  return _frequencyMap;
}

function headNeckSet(): Set<string> {
  if (!_headNeckSet) {
    const lines = readFileSync(path.join(DATA_DIR, "head-neck-lexicon.txt"), "utf8").split("\n");
    _headNeckSet = new Set(
      lines.map((l) => foldAccents(l.trim().toLowerCase())).filter(Boolean),
    );
  }
  return _headNeckSet;
}

function suffixList(): string[] {
  if (!_suffixes) {
    const lines = readFileSync(path.join(DATA_DIR, "suffixes.txt"), "utf8").split("\n");
    _suffixes = lines
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l.startsWith("-"))
      .map((l) => l.slice(1)); // strip leading hyphen
  }
  return _suffixes;
}

// ─ Text utilities ──────────────────────────────────────────────────────────

function foldAccents(s: string): string {
  return s.normalize("NFC")
    .replace(/[áàäâ]/g, "a")
    .replace(/[éèëê]/g, "e")
    .replace(/[íìïî]/g, "i")
    .replace(/[óòöô]/g, "o")
    .replace(/[úùüû]/g, "u")
    .replace(/[ÁÀÄ]/g, "A")
    .replace(/[ÉÈËÊ]/g, "E")
    .replace(/[ÍÌÏÎ]/g, "I")
    .replace(/[ÓÒÖÔ]/g, "O")
    .replace(/[ÚÙÜÛ]/g, "U")
    .replace(/ñ/g, "n")
    .replace(/Ñ/g, "N");
}

/** Strip leading/trailing punctuation (but keep internal hyphens). */
function stripSurroundingPunct(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
}

function isNumeric(s: string): boolean {
  return /^\d+([.,]\d+)?$/.test(s);
}

function isAllCapsAbbrev(s: string): boolean {
  return /^[A-ZÁÉÍÓÚÑ]{2,6}$/.test(s);
}

// ─ Schwartz-Hearst abbreviation extraction ─────────────────────────────────

/**
 * Extracts (abbreviation, long-form) pairs using the Schwartz-Hearst algorithm.
 * Scans for patterns like "long form (ABBR)" and matches characters.
 */
export function extractAbbreviations(text: string): Array<{ abbr: string; longForm: string }> {
  const results: Array<{ abbr: string; longForm: string }> = [];
  // Match "(ABBR)" where ABBR starts with a letter, 2-10 chars, ≥1 uppercase, no spaces
  const abbrevRe = /\(([A-Za-zÁÉÍÓÚáéíóúÑñ][A-Za-zÁÉÍÓÚáéíóúÑñ0-9\-.]{1,9})\)/g;
  let match: RegExpExecArray | null;

  while ((match = abbrevRe.exec(text)) !== null) {
    const abbr = match[1]!;
    // Must have at least one uppercase letter
    if (!/[A-ZÁÉÍÓÚ]/.test(abbr)) continue;
    // Must have at least one letter (not purely numeric)
    if (/^\d+$/.test(abbr)) continue;

    const before = text.slice(0, match.index).trimEnd();
    const longForm = findLongForm(abbr, before);
    if (longForm) {
      results.push({ abbr, longForm });
    }
  }

  return results;
}

/**
 * Schwartz-Hearst long-form finder (character-level right-to-left scan,
 * matching the reference Python implementation).
 */
function findLongForm(abbr: string, precedingText: string): string | null {
  if (!precedingText.trim()) return null;

  // Clip to a word window: min(|abbr|+5, |abbr|*2) words before the paren
  const tokens = precedingText.split(/\s+/).filter(Boolean);
  const windowSize = Math.min(abbr.length + 5, abbr.length * 2);
  const windowTokens = tokens.slice(-windowSize);
  const candidate = windowTokens.join(" ");

  // Match abbreviation characters right-to-left against candidate characters
  let sIdx = abbr.length - 1;
  let lIdx = candidate.length - 1;

  while (sIdx >= 0) {
    const ac = abbr[sIdx]!;
    if (!/[A-Za-z0-9ÁÉÍÓÚáéíóúÑñÜü]/u.test(ac)) {
      sIdx--;
      continue;
    }
    const acLower = foldAccents(ac.toLowerCase());

    // Scan candidate right-to-left for this character
    while (lIdx >= 0) {
      const lc = foldAccents(candidate[lIdx]!.toLowerCase());
      if (lc === acLower) break;
      lIdx--;
    }

    if (lIdx < 0) return null; // not matched
    lIdx--;
    sIdx--;
  }

  // Clip long form: find the start of the word containing the match position
  const clipStart = candidate.lastIndexOf(" ", lIdx + 2);
  const longForm = candidate.slice(clipStart + 1).trim();
  return longForm || null;
}

// ─ Core retention rule ─────────────────────────────────────────────────────

export type RetentionResult = {
  term: string;
  kept: boolean;
  signals: string[];
  reason: string;
};

type RetainOpts = {
  commonCutoff?: number;
  rareCutoff?: number;
  /** Which signals are active for isMedicalLooking. Default: all four. */
  flagSignals?: Array<"abbreviation" | "anatomic" | "suffix" | "rarity">;
  /** Extra abbreviations (e.g. from Schwartz-Hearst pairs or student dictionary). */
  extraAbbreviations?: Set<string>;
};

/**
 * Apply the retention rule to a list of candidate terms.
 * Returns one result per deduplicated (case- and accent-insensitive) term,
 * keeping first-seen casing.
 */
export function retainTerms(candidates: string[], opts: RetainOpts = {}): RetentionResult[] {
  const {
    commonCutoff = 5000,
    rareCutoff = 20000,
    flagSignals = ["abbreviation", "anatomic", "suffix", "rarity"],
    extraAbbreviations = new Set<string>(),
  } = opts;

  const freq = frequencyMap();
  const lexicon = headNeckSet();
  const suffixes = suffixList();

  // Deduplication map: folded-lowercase → first-seen result index
  const deduped = new Map<string, number>();
  const results: RetentionResult[] = [];

  for (const raw of candidates) {
    // Step 1: normalise
    const normalised = stripSurroundingPunct(raw.normalize("NFC").trim());
    if (!normalised) continue;

    const folded = foldAccents(normalised.toLowerCase());

    // Dedup — keep first-seen
    if (deduped.has(folded)) continue;

    // Check if abbreviation (before applying length/numeric checks)
    const isAbbrev =
      isAllCapsAbbrev(normalised) ||
      extraAbbreviations.has(normalised) ||
      extraAbbreviations.has(normalised.toLowerCase());

    // Drop numerics
    if (isNumeric(normalised)) {
      deduped.set(folded, results.length);
      results.push({ term: normalised, kept: false, signals: [], reason: "numeric" });
      continue;
    }

    // Drop tokens under 3 characters (abbreviations are exempt)
    if (!isAbbrev && normalised.length < 3) {
      deduped.set(folded, results.length);
      results.push({ term: normalised, kept: false, signals: [], reason: "too_short" });
      continue;
    }

    // Step 2: Abbreviation signal
    const signals: string[] = [];
    if (isAbbrev && flagSignals.includes("abbreviation")) {
      signals.push("abbreviation");
    }

    // Step 3: Common-word gate (overrides anatomic and suffix for non-abbreviations)
    if (!isAbbrev) {
      const rank = freq.get(folded) ?? freq.get(foldAccents(folded.replace(/s$/, "").replace(/es$/, "")));
      if (rank !== undefined && rank <= commonCutoff) {
        deduped.set(folded, results.length);
        results.push({ term: normalised, kept: false, signals: [], reason: "common_word" });
        continue;
      }
    }

    // Step 4: Anatomic signal
    if (flagSignals.includes("anatomic") && lexicon.has(folded)) {
      signals.push("anatomic");
    }

    // Step 5: Suffix signal
    if (flagSignals.includes("suffix")) {
      const foldedLower = folded;
      for (const suf of suffixes) {
        if (foldedLower.endsWith(suf) && foldedLower.length > suf.length) {
          signals.push("suffix");
          break;
        }
      }
    }

    // Step 6: Rarity signal
    if (flagSignals.includes("rarity")) {
      const rank = freq.get(folded);
      if (rank === undefined || rank >= rareCutoff) {
        signals.push("rarity");
      }
    }

    // Step 7: Determine kept/dropped
    const kept = signals.length > 0;
    const reason = kept ? "kept" : "no_signal";

    deduped.set(folded, results.length);
    results.push({ term: normalised, kept, signals, reason });
  }

  return results;
}

// ─ buildSubjectGlossary ────────────────────────────────────────────────────

/**
 * Extract the subject glossary from a guía docente text.
 * Returns a deduplicated, sorted list of terms.
 * Sorted by descending in-document frequency, then alphabetically.
 */
export function buildSubjectGlossary(guiaText: string): string[] {
  if (!guiaText || !guiaText.trim()) return [];

  // Extract abbreviation pairs using Schwartz-Hearst
  const abbrPairs = extractAbbreviations(guiaText);
  const abbrSet = new Set<string>(abbrPairs.flatMap((p) => [p.abbr, p.longForm]));
  const extraAbbreviations = new Set<string>(abbrPairs.map((p) => p.abbr));

  // Tokenise: split on whitespace and punctuation, keep words ≥2 chars
  const tokenRe = /\p{L}[\p{L}\p{N}\-']{1,}/gu;
  const tokenMatches = [...guiaText.matchAll(tokenRe)];

  // Count in-document frequency (case-insensitive, accent-folded)
  const docFreq = new Map<string, number>();
  const firstSeen = new Map<string, string>(); // folded → original casing

  for (const m of tokenMatches) {
    const token = m[0]!;
    const folded = foldAccents(token.toLowerCase());
    docFreq.set(folded, (docFreq.get(folded) ?? 0) + 1);
    if (!firstSeen.has(folded)) firstSeen.set(folded, token);
  }

  // Also add abbreviation long forms and abbreviations as candidates
  for (const { abbr, longForm } of abbrPairs) {
    const fabbr = foldAccents(abbr.toLowerCase());
    const flf = foldAccents(longForm.toLowerCase());
    if (!firstSeen.has(fabbr)) { firstSeen.set(fabbr, abbr); docFreq.set(fabbr, 1); }
    if (!firstSeen.has(flf)) { firstSeen.set(flf, longForm); docFreq.set(flf, 1); }
  }

  const candidates = [...firstSeen.values()];

  const retained = retainTerms(candidates, { extraAbbreviations });

  const keptTerms = retained
    .filter((r) => r.kept)
    .map((r) => ({
      term: r.term,
      freq: docFreq.get(foldAccents(r.term.toLowerCase())) ?? 0,
    }));

  // Sort: descending doc-freq, then alphabetical
  keptTerms.sort((a, b) =>
    b.freq !== a.freq
      ? b.freq - a.freq
      : a.term.localeCompare(b.term, "es"),
  );

  // Also include Schwartz-Hearst abbreviations that weren't yet included
  const glossarySet = new Set(keptTerms.map((t) => foldAccents(t.term.toLowerCase())));
  const abbrTerms: string[] = [];
  for (const { abbr, longForm } of abbrPairs) {
    const fa = foldAccents(abbr.toLowerCase());
    const fl = foldAccents(longForm.toLowerCase());
    if (!glossarySet.has(fa)) { abbrTerms.push(abbr); glossarySet.add(fa); }
    if (!glossarySet.has(fl)) { abbrTerms.push(longForm); glossarySet.add(fl); }
  }

  return [...keptTerms.map((t) => t.term), ...abbrTerms];
}

// ─ isMedicalLooking ────────────────────────────────────────────────────────

/**
 * Returns true if the token would be retained by retainTerms (any signal).
 * flagSignals config narrows which signals are counted.
 */
export function isMedicalLooking(
  token: string,
  opts: Pick<RetainOpts, "flagSignals"> = {},
): boolean {
  const results = retainTerms([token], opts);
  return results.length > 0 && results[0]!.kept;
}
