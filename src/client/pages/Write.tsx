import { useState, useEffect, useRef, useCallback } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/ariakit";
import "@blocknote/ariakit/style.css";
import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import type { Lecture, NotesDocument } from "../../shared/types.js";
import { EMPTY_NOTES_DOCUMENT } from "../../shared/types.js";
import { updateMeta } from "../../shared/blockIdentity.js";
import type { BlockLike } from "../../shared/blockIdentity.js";
import { strings } from "../../shared/strings.js";

interface WriteProps {
  lectureId: string;
  onBack: () => void;
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

interface EditorViewProps {
  initialDoc: NotesDocument;
  lectureId: string;
  onBack: () => void;
}

function EditorView({ initialDoc, lectureId, onBack }: EditorViewProps) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const metaRef = useRef(initialDoc.meta);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // BlockNote rejects empty array; pass undefined to get its default empty paragraph
  const editor = useCreateBlockNote({
    initialContent:
      initialDoc.blocks.length > 0
        ? (initialDoc.blocks as PartialBlock[])
        : undefined,
  });

  const prevBlocksRef = useRef<BlockLike[]>(
    editor.document as unknown as BlockLike[],
  );

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
    (changedEditor: BlockNoteEditor) => {
      const newBlocks = changedEditor.document as unknown as BlockLike[];
      const newMeta = updateMeta(
        prevBlocksRef.current,
        newBlocks,
        metaRef.current,
        () => Date.now(),
      );
      metaRef.current = newMeta;
      prevBlocksRef.current = newBlocks;

      const doc: NotesDocument = {
        blocks: changedEditor.document as unknown[],
        meta: newMeta,
      };

      setSaveState("idle");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => save(doc), 500);
    },
    [save],
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
      </div>
      <div style={styles.editorWrapper} data-testid="notes-editor">
        <BlockNoteView editor={editor} onChange={handleChange} />
      </div>
    </div>
  );
}

export function Write({ lectureId, onBack }: WriteProps) {
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
    <EditorView initialDoc={initialDoc} lectureId={lectureId} onBack={onBack} />
  );
}
