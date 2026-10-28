import type { AbbreviationPair } from "./types.js";

function applyCapitalization(token: string, expansion: string): string {
  if (!token || !expansion) return expansion;
  const first = token[0]!;
  const hasCase = first.toLowerCase() !== first.toUpperCase();
  if (!hasCase) return expansion;

  const allUpper = token === token.toUpperCase();
  const firstUpper = first === first.toUpperCase();

  if (allUpper) return expansion.toUpperCase();
  if (firstUpper) return expansion[0]!.toUpperCase() + expansion.slice(1);
  return expansion;
}

function buildRegex(abbreviation: string, matchCaseExactly: boolean): RegExp {
  const tokens = abbreviation.trim().split(/\s+/);
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // \b works for ASCII abbreviations; multi-token uses \s+ between tokens
  const pattern = "\\b" + escaped.join("\\s+") + "\\b";
  const flags = matchCaseExactly ? "g" : "gi";
  return new RegExp(pattern, flags);
}

export function expandAbbreviations(
  text: string,
  pairs: AbbreviationPair[],
): string {
  // Sort longest multi-token first, then longest single token
  const sorted = [...pairs].sort((a, b) => {
    const aT = a.abbreviation.split(/\s+/).length;
    const bT = b.abbreviation.split(/\s+/).length;
    if (bT !== aT) return bT - aT;
    return b.abbreviation.length - a.abbreviation.length;
  });

  let result = text;
  for (const pair of sorted) {
    const regex = buildRegex(pair.abbreviation, pair.matchCaseExactly);
    result = result.replace(regex, (match) =>
      applyCapitalization(match, pair.expansion),
    );
  }
  return result;
}

// Walk a BlockNote document and expand abbreviations in all text nodes.
// Returns the document as a JSON string (the original is never mutated).
export function expandNotesData(
  notesData: string,
  pairs: AbbreviationPair[],
): string {
  if (pairs.length === 0) return notesData;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = JSON.parse(notesData) as any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function expandBlock(block: any): any {
    const content = block.content
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        block.content.map((item: any) => {
          if (item.type === "text" && typeof item.text === "string") {
            return { ...item, text: expandAbbreviations(item.text, pairs) };
          }
          return item;
        })
      : block.content;

    const children = block.children
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        block.children.map((child: any) => expandBlock(child))
      : block.children;

    return { ...block, content, children };
  }

  const expanded = {
    ...doc,
    blocks: Array.isArray(doc.blocks) ? doc.blocks.map(expandBlock) : doc.blocks,
  };

  return JSON.stringify(expanded);
}

// Extract plain text from a BlockNote document for analysis purposes.
export function extractTextFromNotesData(notesData: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = JSON.parse(notesData) as any;
  const parts: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function visitBlock(block: any) {
    if (Array.isArray(block.content)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const item of block.content) {
        if (item.type === "text" && typeof item.text === "string") {
          parts.push(item.text);
        }
      }
    }
    if (Array.isArray(block.children)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const child of block.children) {
        visitBlock(child);
      }
    }
  }

  if (Array.isArray(doc.blocks)) {
    for (const block of doc.blocks) {
      visitBlock(block);
    }
  }

  return parts.join(" ");
}
