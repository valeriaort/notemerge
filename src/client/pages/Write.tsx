import { useState, useEffect, useRef, useCallback } from "react";
import type { Lecture } from "../../shared/types.js";
import { strings } from "../../shared/strings.js";

interface WriteProps {
  lectureId: string;
  onBack: () => void;
}

type SaveState = "saved" | "saving" | "idle";

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 800, margin: "0 auto", padding: "1rem" },
  toolbar: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" },
  backBtn: { background: "transparent", border: "none", cursor: "pointer", color: "#666", fontSize: "0.9rem" },
  saveIndicator: { fontSize: "0.85rem", color: "#888" },
  textarea: {
    width: "100%",
    minHeight: "calc(100vh - 100px)",
    padding: "1rem",
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    fontSize: "1rem",
    fontFamily: "inherit",
    lineHeight: 1.6,
    resize: "none",
    outline: "none",
    background: "#fff",
  },
  error: { color: "#c0392b", fontSize: "0.85rem" },
};

export function Write({ lectureId, onBack }: WriteProps) {
  const [lecture, setLecture] = useState<Lecture | null>(null);
  const [notesData, setNotesData] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch(`/api/lectures/${lectureId}`)
      .then((r) => {
        if (!r.ok) throw new Error("not found");
        return r.json() as Promise<Lecture>;
      })
      .then((data) => {
        setLecture(data);
        setNotesData(data.notesData);
      })
      .catch(() => setError(strings.errors.loadFailed));
  }, [lectureId]);

  const save = useCallback(
    async (value: string) => {
      setSaveState("saving");
      try {
        const res = await fetch(`/api/lectures/${lectureId}/notes`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notesData: value }),
        });
        if (!res.ok) throw new Error("save failed");
        const updated: Lecture = await res.json();
        setLecture(updated);
        setSaveState("saved");
      } catch {
        setSaveState("idle");
        setError(strings.errors.saveFailed);
      }
    },
    [lectureId],
  );

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setNotesData(value);
    setSaveState("idle");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => save(value), 500);
  }

  if (error) return <div style={styles.container}><p style={styles.error}>{error}</p></div>;
  if (!lecture) return <div style={styles.container}>Loading...</div>;

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
      <textarea
        data-testid="notes-textarea"
        style={styles.textarea}
        value={notesData}
        onChange={handleChange}
        placeholder={strings.write.placeholder}
        autoFocus
      />
    </div>
  );
}
