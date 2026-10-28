import type { AbbreviationPair, UnknownToken } from "./types.js";

// Common Spanish words that should never be treated as unknown abbreviations.
// Covers articles, prepositions, conjunctions, pronouns, short adverbs,
// common verb forms, and frequent short content words (all ≤5 chars).
export const COMMON_SPANISH_WORDS: ReadonlySet<string> = new Set([
  // Articles
  "el", "la", "los", "las", "un", "una", "lo",
  // Prepositions (≤5)
  "a", "al", "ante", "bajo", "cabe", "con", "de", "del", "en",
  "para", "por", "sin", "so", "sobre", "tras",
  // Conjunctions
  "y", "e", "o", "u", "ni", "que", "si", "ya", "pero", "mas", "aun", "pues",
  // Pronouns / determiners
  "yo", "nos", "os", "se", "me", "te", "le", "les", "mi", "su", "sus",
  "mis", "tus", "vos",
  // Demonstratives
  "este", "esta", "esto", "ese", "esa", "eso",
  // Quantifiers / indefinites
  "todo", "toda", "cada", "otro", "otra", "algo", "nada", "poco",
  "más", "mas", "menos", "tal", "cual", "solo",
  // Adverbs
  "no", "sí", "si", "muy", "ya", "bien", "mal", "así", "aquí",
  "allí", "ahí", "hoy", "aún", "aun", "hay", "luego", "ahora",
  "antes", "cerca", "como",
  // Common conjugated verb forms
  "es", "era", "fue", "son", "han", "has", "ser", "ir", "ver",
  "dar", "ten", "haz", "sea", "soy", "iba", "fui", "voy", "van",
  "das", "doy", "va", "da", "eres", "está", "estás", "está",
  "hay", "haya", "tuve", "tuvo",
  // Common short nouns / adjectives
  "vez", "caso", "tipo", "modo", "lado", "área", "base", "dato",
  "cara", "luz", "sol", "aire", "agua", "país", "pie", "mar",
  "fin", "mano", "voz", "ojo", "boca", "alma", "cosa", "casa",
  "sala", "uso", "paso", "plan", "hora", "día", "año", "mes",
  "vez", "vida", "otro", "gran", "buen", "mal", "alto", "bajo",
  "leve", "grave", "tos", "dolor",
  // Numbers (written out, ≤5)
  "uno", "dos", "tres", "seis", "cien", "mil",
]);

// Tokenises text on whitespace and punctuation, returning only "word" tokens
// (no separators). A token of purely punctuation or whitespace is dropped.
const SEPARATOR_RE = /[\s.,;:!?()\[\]{}<>"'`/\\@#$%^&*+=|~\-]+/;

export function tokenize(text: string): string[] {
  return text
    .split(SEPARATOR_RE)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && /[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]/.test(t));
}

function isNumeric(token: string): boolean {
  return /^\d+$/.test(token);
}

function isAllCaps(token: string): boolean {
  return (
    token.length > 0 &&
    token === token.toUpperCase() &&
    token !== token.toLowerCase()
  );
}

function isCandidate(token: string): boolean {
  // Only flag tokens ≤5 chars or all-caps
  return token.length <= 5 || isAllCaps(token);
}

export function findUnknownTokens(
  notesText: string,
  pairs: AbbreviationPair[],
  ignoredTokens: ReadonlySet<string>,
  subjectGlossary: ReadonlySet<string> = new Set(),
): UnknownToken[] {
  const dictionaryKeys = new Set(
    pairs.map((p) => p.abbreviation.toLowerCase()),
  );

  const tokens = tokenize(notesText);
  const freq = new Map<string, number>();

  for (const raw of tokens) {
    if (isNumeric(raw)) continue;
    if (!isCandidate(raw)) continue;

    const lower = raw.toLowerCase();

    if (dictionaryKeys.has(lower)) continue;
    if (subjectGlossary.has(lower)) continue;
    if (COMMON_SPANISH_WORDS.has(lower)) continue;
    if (ignoredTokens.has(lower)) continue;

    freq.set(lower, (freq.get(lower) ?? 0) + 1);
  }

  // Sort by frequency descending, then alphabetically for stable order
  return [...freq.entries()]
    .map(([text, frequency]) => ({ text, frequency }))
    .sort((a, b) => b.frequency - a.frequency || a.text.localeCompare(b.text));
}
