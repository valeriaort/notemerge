import { describe, it, expect } from "vitest";
import { updateMeta, blockHasContent } from "../../src/shared/blockIdentity.js";
import type { BlockLike } from "../../src/shared/blockIdentity.js";

function makeBlock(id: string, text: string, children?: BlockLike[]): BlockLike {
  return {
    id,
    content: text ? [{ type: "text", text, styles: {} }] : [],
    children: children ?? [],
  };
}

function makeClock(times: number[]): () => number {
  let i = 0;
  return () => times[i++] ?? times[times.length - 1]!;
}

describe("blockHasContent", () => {
  it("returns true for a block with text", () => {
    expect(blockHasContent(makeBlock("b1", "hello"))).toBe(true);
  });

  it("returns false for a block with empty text", () => {
    expect(blockHasContent(makeBlock("b1", ""))).toBe(false);
  });

  it("returns false for a block with no content", () => {
    expect(blockHasContent({ id: "b1", content: undefined })).toBe(false);
  });

  it("returns true for a block with link content", () => {
    const block: BlockLike = {
      id: "b1",
      content: [{ type: "link", href: "http://x", content: [{ type: "text", text: "click", styles: {} }] }],
    };
    expect(blockHasContent(block)).toBe(true);
  });
});

describe("updateMeta — new blocks", () => {
  it("assigns no firstEditTime to a new empty block", () => {
    const clock = makeClock([1000]);
    const result = updateMeta([], [makeBlock("b1", "")], {}, clock);
    expect(result["b1"]).toEqual({});
  });

  it("assigns firstEditTime and lastEditTime to a new block with content", () => {
    const clock = makeClock([1000]);
    const result = updateMeta([], [makeBlock("b1", "hello")], {}, clock);
    expect(result["b1"]).toEqual({ firstEditTime: 1000, lastEditTime: 1000 });
  });
});

describe("updateMeta — existing blocks", () => {
  it("preserves times when content is unchanged", () => {
    const clock = makeClock([2000]);
    const oldBlocks = [makeBlock("b1", "hello")];
    const newBlocks = [makeBlock("b1", "hello")];
    const oldMeta = { b1: { firstEditTime: 500, lastEditTime: 500 } };
    const result = updateMeta(oldBlocks, newBlocks, oldMeta, clock);
    expect(result["b1"]).toEqual({ firstEditTime: 500, lastEditTime: 500 });
  });

  it("updates lastEditTime when content changes", () => {
    const clock = makeClock([2000]);
    const oldBlocks = [makeBlock("b1", "hello")];
    const newBlocks = [makeBlock("b1", "hello world")];
    const oldMeta = { b1: { firstEditTime: 500, lastEditTime: 500 } };
    const result = updateMeta(oldBlocks, newBlocks, oldMeta, clock);
    expect(result["b1"]).toEqual({ firstEditTime: 500, lastEditTime: 2000 });
  });

  it("sets firstEditTime when an empty block gets content for the first time", () => {
    const clock = makeClock([3000]);
    const oldBlocks = [makeBlock("b1", "")];
    const newBlocks = [makeBlock("b1", "typed")];
    const result = updateMeta(oldBlocks, newBlocks, {}, clock);
    expect(result["b1"]).toEqual({ firstEditTime: 3000, lastEditTime: 3000 });
  });

  it("preserves firstEditTime when content changes on a block that already has one", () => {
    const clock = makeClock([4000]);
    const oldBlocks = [makeBlock("b1", "hello")];
    const newBlocks = [makeBlock("b1", "hello!")];
    const oldMeta = { b1: { firstEditTime: 100, lastEditTime: 200 } };
    const result = updateMeta(oldBlocks, newBlocks, oldMeta, clock);
    expect(result["b1"]!.firstEditTime).toBe(100);
    expect(result["b1"]!.lastEditTime).toBe(4000);
  });
});

describe("updateMeta — split (second half becomes new block with content)", () => {
  it("gives the new block firstEditTime = split time", () => {
    const clock = makeClock([5000]);
    const oldBlocks = [makeBlock("b1", "hello world")];
    const newBlocks = [makeBlock("b1", "hello"), makeBlock("b2", "world")];
    const oldMeta = { b1: { firstEditTime: 100, lastEditTime: 200 } };
    const result = updateMeta(oldBlocks, newBlocks, oldMeta, clock);
    // b1 keeps its times (content changed from "hello world" to "hello")
    expect(result["b1"]!.firstEditTime).toBe(100);
    expect(result["b1"]!.lastEditTime).toBe(5000);
    // b2 is new and has content so gets firstEditTime = split time
    expect(result["b2"]).toEqual({ firstEditTime: 5000, lastEditTime: 5000 });
  });
});

describe("updateMeta — merge (lower block deleted)", () => {
  it("drops the lower block's ID from meta", () => {
    const clock = makeClock([6000]);
    const oldBlocks = [makeBlock("b1", "hello"), makeBlock("b2", "world")];
    const newBlocks = [makeBlock("b1", "hello world")];
    const oldMeta = {
      b1: { firstEditTime: 100, lastEditTime: 200 },
      b2: { firstEditTime: 300, lastEditTime: 400 },
    };
    const result = updateMeta(oldBlocks, newBlocks, oldMeta, clock);
    expect(result["b1"]!.firstEditTime).toBe(100);
    expect(result["b2"]).toBeUndefined();
  });
});

describe("updateMeta — paste (new blocks with content)", () => {
  it("all new blocks get firstEditTime = paste time", () => {
    const clock = makeClock([7000]);
    const oldBlocks = [makeBlock("b1", "existing")];
    const newBlocks = [makeBlock("b1", "existing"), makeBlock("p1", "pasted A"), makeBlock("p2", "pasted B")];
    const oldMeta = { b1: { firstEditTime: 100, lastEditTime: 100 } };
    const result = updateMeta(oldBlocks, newBlocks, oldMeta, clock);
    expect(result["p1"]).toEqual({ firstEditTime: 7000, lastEditTime: 7000 });
    expect(result["p2"]).toEqual({ firstEditTime: 7000, lastEditTime: 7000 });
  });
});

describe("updateMeta — move (same ID, same content, different position)", () => {
  it("times are unchanged after move", () => {
    const clock = makeClock([8000]);
    const oldBlocks = [makeBlock("b1", "first"), makeBlock("b2", "second")];
    const newBlocks = [makeBlock("b2", "second"), makeBlock("b1", "first")];
    const oldMeta = {
      b1: { firstEditTime: 100, lastEditTime: 200 },
      b2: { firstEditTime: 300, lastEditTime: 400 },
    };
    const result = updateMeta(oldBlocks, newBlocks, oldMeta, clock);
    expect(result["b1"]).toEqual({ firstEditTime: 100, lastEditTime: 200 });
    expect(result["b2"]).toEqual({ firstEditTime: 300, lastEditTime: 400 });
  });
});

describe("updateMeta — nested children", () => {
  it("tracks children as separate blocks", () => {
    const clock = makeClock([9000]);
    const child = makeBlock("child1", "nested");
    const parent = { ...makeBlock("parent1", "top"), children: [child] };
    const result = updateMeta([], [parent], {}, clock);
    expect(result["parent1"]).toEqual({ firstEditTime: 9000, lastEditTime: 9000 });
    expect(result["child1"]).toEqual({ firstEditTime: 9000, lastEditTime: 9000 });
  });
});
