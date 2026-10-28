export type BlockMeta = {
  firstEditTime?: number;
  lastEditTime?: number;
};

export type Clock = () => number;

export type BlockLike = {
  id: string;
  content?: unknown;
  children?: BlockLike[];
};

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as unknown[])
    .map((item) => {
      if (typeof item !== "object" || item === null) return "";
      const obj = item as Record<string, unknown>;
      if (obj["type"] === "text") return typeof obj["text"] === "string" ? obj["text"] : "";
      if (obj["type"] === "link" && Array.isArray(obj["content"])) return extractText(obj["content"]);
      return "";
    })
    .join("");
}

export function blockHasContent(block: BlockLike): boolean {
  return extractText(block.content).length > 0;
}

function flattenBlocks(blocks: BlockLike[]): BlockLike[] {
  const result: BlockLike[] = [];
  for (const block of blocks) {
    result.push(block);
    if (block.children && block.children.length > 0) {
      result.push(...flattenBlocks(block.children));
    }
  }
  return result;
}

// Given the previous and new block trees plus previous meta, return updated meta.
// Rules:
//   New block with content → firstEditTime = now, lastEditTime = now
//   New block without content → no firstEditTime
//   Existing block, content changed, now has content → update lastEditTime; set firstEditTime if absent
//   Existing block, content unchanged → carry forward meta unchanged
//   Disappeared block (merged/deleted) → dropped from result
export function updateMeta(
  oldBlocks: BlockLike[],
  newBlocks: BlockLike[],
  oldMeta: Record<string, BlockMeta>,
  clock: Clock,
): Record<string, BlockMeta> {
  const now = clock();
  const oldFlat = flattenBlocks(oldBlocks);
  const newFlat = flattenBlocks(newBlocks);

  const oldMap = new Map(oldFlat.map((b) => [b.id, b]));
  const newMeta: Record<string, BlockMeta> = {};

  for (const block of newFlat) {
    const hasContent = blockHasContent(block);
    const oldBlock = oldMap.get(block.id);

    if (oldBlock !== undefined) {
      const existing = oldMeta[block.id] ?? {};
      const contentChanged =
        JSON.stringify(block.content) !== JSON.stringify(oldBlock.content);

      if (contentChanged && hasContent) {
        newMeta[block.id] = {
          firstEditTime: existing.firstEditTime ?? now,
          lastEditTime: now,
        };
      } else {
        newMeta[block.id] = { ...existing };
      }
    } else {
      newMeta[block.id] = hasContent ? { firstEditTime: now, lastEditTime: now } : {};
    }
  }

  return newMeta;
}
