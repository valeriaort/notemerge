import { useState, useEffect, useRef, useCallback } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/ariakit";
import "@blocknote/ariakit/style.css";
import type { PartialBlock } from "@blocknote/core";
import { v4 as uuidv4 } from "uuid";
import type { Lecture, NotesDocument } from "../../shared/types.js";
import { EMPTY_NOTES_DOCUMENT } from "../../shared/types.js";
import { updateMeta } from "../../shared/blockIdentity.js";
import type { BlockLike } from "../../shared/blockIdentity.js";
import { strings } from "../../shared/strings.js";
import { notemergeSchema } from "../slideMarkerBlock.js";

interface WriteProps {
  lectureId: string;
  onBack: () => void;
  onContinueToSources?: () => void;
}

type SaveState = "saved" | "saving" | "idle";

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 800, margin: "0 auto", padding: "1rem" },
  toolbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "1rem",
  },
  backBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: "#666",
    fontSize: "0.9rem",
  },
  saveIndicator: { fontSize: "0.85rem", color: "#888" },
  editorWrapper: {
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    minHeight: "calc(100vh - 100px)",
    background: "#fff",
  },
  error: { color: "#c0392b", fontSize: "0.85rem" },
};

function parseNotesDoc(raw: string): NotesDocument {
  try {
    const doc = JSON.parse(raw) as unknown;
    if (
      doc !== null &&
      typeof doc === "object" &&
      "blocks" in doc &&
      "meta" in doc &&
      Array.isArray((doc as NotesDocument).blocks)
    ) {
      return doc as NotesDocument;
    }
  } catch {
    // fall through to empty
  }
  return EMPTY_NOTES_DOCUMENT;
}

function blockPlainText(block: unknown): string {
  const b = block as { content?: unknown };
  if (!Array.isArray(b.content)) return "";
  return (b.content as unknown[])
    .map((item) => {
      const it = item as { type?: string; text?: string };
      if (it.type === "text" && typeof it.text === "string") return it.text;
      return "";
    })
    .join("");
}

type AnyBlock = { id: string; type?: string; props?: Record<string, unknown>; children?: AnyBlock[] };

function flatBlocks(blocks: AnyBlock[]): AnyBlock[] {
  const out: AnyBlock[] = [];
  for (const b of blocks) {
    out.push(b);
    if (b.children && b.children.length > 0) out.push(...flatBlocks(b.children));
  }
  return out;
}

async function apiPostMarker(
  lectureId: string,
  markerId: string,
  timestamp: number,
  blockId: string,
): Promise<void> {
  await fetch(`/api/lectures/${lectureId}/markers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestamp, blockId }),
  });
}

async function apiDeleteMarker(lectureId: string, markerId: string): Promise<void> {
  await fetch(`/api/lectures/${lectureId}/markers/${markerId}`, { method: "DELETE" });
}

interface EditorViewProps {
  initialDoc: NotesDocument;
  lectureId: string;
  onBack: () => void;
  onContinueToSources?: () => void;
}

function EditorView({ initialDoc, lectureId, onBack, onContinueToSources }: EditorViewProps) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const metaRef = useRef(initialDoc.meta);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // BlockNote rejects empty array; pass undefined to get its default empty paragraph
  const editor = useCreateBlockNote({
    schema: notemergeSchema,
    initialContent:
      initialDoc.blocks.length > 0
        ? (initialDoc.blocks as PartialBlock[])
        : undefined,
  });

  type NotemergeEditor = typeof editor;

  const prevDocRef = useRef<AnyBlock[]>(editor.document as unknown as AnyBlock[]);
  const prevBlocksRef = useRef<BlockLike[]>(editor.document as unknown as BlockLike[]);

  const save = useCallback(
    async (doc: NotesDocument) => {
      setSaveState("saving");
      try {
        const res = await fetch(`/api/lectures/${lectureId}/notes`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notesData: JSON.stringify(doc) }),
        });
        if (!res.ok) throw new Error("save failed");
        setSaveState("saved");
      } catch {
        setSaveState("idle");
        setError(strings.errors.saveFailed);
      }
    },
    [lectureId],
  );

  const handleChange = useCallback(
    (changedEditor: NotemergeEditor) => {
      const newDoc = changedEditor.document as unknown as AnyBlock[];

      // Detect // typed in any paragraph block → replace with a slideMarker block
      const allNew = flatBlocks(newDoc);
      const triggerBlock = allNew.find(
        (b) => b.type === "paragraph" && blockPlainText(b) === "//",
      );

      if (triggerBlock) {
        const markerId = uuidv4();
        const timestamp = Date.now();
        // Defer so we don't mutate the editor inside its own onChange
        setTimeout(() => {
          try {
            changedEditor.updateBlock(triggerBlock as Parameters<typeof changedEditor.updateBlock>[0], {
              type: "slideMarker",
              props: { markerId },
            } as Parameters<typeof changedEditor.updateBlock>[1]);
          } catch {
            // block may have been deleted by the user before the timeout fired
          }
        }, 0);
        void apiPostMarker(lectureId, markerId, timestamp, triggerBlock.id);
        return; // skip meta+save for this transient state; next onChange will save
      }

      // Detect slideMarker blocks deleted since last onChange → remove from API
      const prevMarkers = flatBlocks(prevDocRef.current).filter((b) => b.type === "slideMarker");
      const newMarkerIds = new Set(allNew.filter((b) => b.type === "slideMarker").map((b) => b.id));
      for (const pm of prevMarkers) {
        if (!newMarkerIds.has(pm.id)) {
          const mid = pm.props?.["markerId"];
          if (typeof mid === "string" && mid) void apiDeleteMarker(lectureId, mid);
        }
      }

      // Normal path: update meta and schedule save
      const newBlocks = newDoc as unknown as BlockLike[];
      const newMeta = updateMeta(
        prevBlocksRef.current,
        newBlocks,
        metaRef.current,
        () => Date.now(),
      );
      metaRef.current = newMeta;
      prevBlocksRef.current = newBlocks;
      prevDocRef.current = newDoc;

      const doc: NotesDocument = {
        blocks: changedEditor.document as unknown[],
        meta: newMeta,
      };

      setSaveState("idle");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => save(doc), 500);
    },
    [save, lectureId],
  );

  if (error) {
    return (
      <div style={styles.container}>
        <p style={styles.error}>{error}</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <button style={styles.backBtn} onClick={onBack}>
          ← {strings.write.backToLibrary}
        </button>
        <span style={styles.saveIndicator}>
          {saveState === "saving"
            ? strings.write.savingIndicator
            : saveState === "saved"
              ? strings.write.savedIndicator
              : ""}
        </span>
        {onContinueToSources && (
          <button
            style={{ ...styles.backBtn, color: "#111", fontWeight: 600 }}
            onClick={onContinueToSources}
            data-testid="continue-to-sources"
          >
            {strings.write.continueToSources} →
          </button>
        )}
      </div>
      <div style={styles.editorWrapper} data-testid="notes-editor">
        <BlockNoteView editor={editor} onChange={handleChange} />
      </div>
    </div>
  );
}

export function Write({ lectureId, onBack, onContinueToSources }: WriteProps) {
  const [initialDoc, setInitialDoc] = useState<NotesDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/lectures/${lectureId}`)
      .then((r) => {
        if (!r.ok) throw new Error("not found");
        return r.json() as Promise<Lecture>;
      })
      .then((data) => {
        setInitialDoc(parseNotesDoc(data.notesData));
      })
      .catch(() => setLoadError(strings.errors.loadFailed));
  }, [lectureId]);

  if (loadError) {
    return (
      <div style={styles.container}>
        <p style={styles.error}>{loadError}</p>
      </div>
    );
  }

  if (!initialDoc) {
    return <div style={styles.container}>Loading...</div>;
  }

  return (
    <EditorView
      initialDoc={initialDoc}
      lectureId={lectureId}
      onBack={onBack}
      onContinueToSources={onContinueToSources}
    />
  );
}
