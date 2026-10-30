import type { WritingModelProvider } from "./interfaces.js";
import { WritingModelHttpError } from "./interfaces.js";
import type { WritingOperation } from "../shared/types.js";

const SYSTEM_PROMPT = `You are a writing assistant for a medical student's note-taking app. \
Your task is to produce a list of writing operations that enrich the student's sealed notes \
based on an edit list produced by a coverage and conflict classifier.

Rules:
- Every edit list entry must be answered by exactly one operation.
- All added or rewritten note text must be in Spanish, in the student's terse register, \
  using any abbreviations shown in the existing note blocks.
- For "missing" entries: add the missing fact as a new block. Use add_after a nearby related \
  note block when one exists in the same window; otherwise use add_at_window.
- For "partial" entries: add the missing specific fact (name, number, cause, or relationship) \
  as a new block immediately after the partially-covering block using add_after.
- For "conflict" entries: rewrite the conflicting note block to propose a correction using \
  the source evidence. When slide and transcript disagree, follow the transcript and state so.
- Keep text concise. Do not invent facts not present in the source items.
- The sourceIds in each operation must exactly match the sourceIds from the corresponding \
  edit list entry.`;

const OPERATIONS_TOOL = {
  name: "write_operations",
  description: "Output the ordered list of writing operations, one per edit list entry.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["add_after", "add_at_window", "rewrite"],
            },
            blockId: { type: "string" },
            windowId: { type: "string" },
            text: { type: "string" },
            sourceIds: { type: "array", items: { type: "string" } },
          },
          required: ["type", "text", "sourceIds"],
          additionalProperties: false,
        },
      },
    },
    required: ["operations"],
    additionalProperties: false,
  },
};

type EditEntry = {
  id: string;
  type: string;
  windowId: string;
  sourceIds: string[];
  sourceText: string;
  noteId?: string;
  retrievedNoteIds?: string[];
  poolItems?: Array<{ id: string; text: string; label: "slide" | "transcript" }>;
};

function buildUserMessage(input: {
  sealedNotes: Array<{ id: string; text: string }>;
  windowRanges: Array<{ windowId: string; startMs: number; endMs: number }>;
  editList: EditEntry[];
}): string {
  const notesSection = input.sealedNotes.map((n) => `[${n.id}] ${n.text}`).join("\n");

  const windowsSection = input.windowRanges
    .map((w) => `[${w.windowId}] ${w.startMs}ms–${w.endMs}ms`)
    .join("\n");

  const noteById = new Map(input.sealedNotes.map((n) => [n.id, n.text]));

  const editSection = input.editList
    .map((entry) => {
      const lines: string[] = [
        `Entry ${entry.id} (${entry.type}) window=${entry.windowId}`,
        `  source: ${entry.sourceIds.join(", ")} — "${entry.sourceText}"`,
      ];
      if (entry.noteId) {
        const noteText = noteById.get(entry.noteId) ?? "(not found)";
        lines.push(`  note block: ${entry.noteId} — "${noteText}"`);
      }
      if (entry.retrievedNoteIds?.length) {
        lines.push(`  partial coverage in blocks: ${entry.retrievedNoteIds.join(", ")}`);
      }
      if (entry.poolItems?.length) {
        const items = entry.poolItems
          .map((p) => `    [${p.id}] (${p.label}) "${p.text}"`)
          .join("\n");
        lines.push(`  pool items:\n${items}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");

  return (
    `## Sealed notes\n${notesSection}\n\n` +
    `## Windows\n${windowsSection}\n\n` +
    `## Edit list\n${editSection}\n\n` +
    `Call write_operations with exactly one operation per edit list entry (${input.editList.length} total).`
  );
}

function parseOperations(raw: unknown[]): WritingOperation[] {
  const valid: WritingOperation[] = [];
  for (const op of raw) {
    if (!op || typeof op !== "object") continue;
    const o = op as Record<string, unknown>;
    const type = o["type"];
    const text = o["text"];
    const sourceIds = o["sourceIds"];
    if (typeof text !== "string" || !Array.isArray(sourceIds)) continue;
    if (!sourceIds.every((id) => typeof id === "string")) continue;
    const ids = sourceIds as string[];
    if (type === "add_after" && typeof o["blockId"] === "string") {
      valid.push({ type: "add_after", blockId: o["blockId"], text, sourceIds: ids });
    } else if (type === "add_at_window" && typeof o["windowId"] === "string") {
      valid.push({ type: "add_at_window", windowId: o["windowId"], text, sourceIds: ids });
    } else if (type === "rewrite" && typeof o["blockId"] === "string") {
      valid.push({ type: "rewrite", blockId: o["blockId"], text, sourceIds: ids });
    }
  }
  return valid;
}

interface AnthropicResponse {
  content: Array<{ type: string; name?: string; input?: unknown }>;
}

export class AnthropicWritingModel implements WritingModelProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = "claude-haiku-5-5") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generateOperations(input: {
    sealedNotes: Array<{ id: string; text: string }>;
    windowRanges: Array<{ windowId: string; startMs: number; endMs: number }>;
    editList: EditEntry[];
  }): Promise<WritingOperation[]> {
    const body = {
      model: this.model,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: [OPERATIONS_TOOL],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: buildUserMessage(input) }],
    };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let message = response.statusText;
      try {
        const text = await response.text();
        if (text) message = text;
      } catch {
        // keep statusText
      }
      throw new WritingModelHttpError(response.status, message);
    }

    const data = (await response.json()) as AnthropicResponse;
    const toolBlock = data.content.find(
      (b) => b.type === "tool_use" && b.name === "write_operations",
    );
    if (!toolBlock) return [];

    const toolInput = toolBlock.input as { operations?: unknown } | undefined;
    if (!toolInput || !Array.isArray(toolInput.operations)) return [];

    return parseOperations(toolInput.operations as unknown[]);
  }
}
