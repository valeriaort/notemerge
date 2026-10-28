import { useState, useEffect, useRef, useCallback } from "react";
import type { Lecture, Subject } from "../../shared/types.js";
import { strings } from "../../shared/strings.js";

interface SourcesProps {
  lectureId: string;
  onSealed: () => void;
  onBack: () => void;
}

type SubjectPickerMode = "existing" | "new";

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: "fixed",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    background: "#fafafa",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    padding: "0.75rem 1.5rem",
    borderBottom: "1px solid #e5e5e5",
    background: "#fff",
  },
  backBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: "#666",
    fontSize: "0.9rem",
  },
  title: { fontWeight: 600, fontSize: "1rem", margin: 0 },
  body: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "2rem",
    gap: "1.5rem",
  },
  card: {
    background: "#fff",
    border: "1px solid #e5e5e5",
    borderRadius: 12,
    padding: "2rem",
    width: "100%",
    maxWidth: 480,
    display: "flex",
    flexDirection: "column",
    gap: "1.25rem",
  },
  fieldLabel: { fontSize: "0.85rem", fontWeight: 600, color: "#444", marginBottom: "0.25rem" },
  select: {
    width: "100%",
    padding: "0.5rem 0.75rem",
    borderRadius: 6,
    border: "1px solid #ccc",
    fontSize: "0.95rem",
    background: "#fff",
  },
  input: {
    width: "100%",
    padding: "0.5rem 0.75rem",
    borderRadius: 6,
    border: "1px solid #ccc",
    fontSize: "0.95rem",
    boxSizing: "border-box",
  },
  fileReady: {
    fontSize: "0.85rem",
    color: "#16a34a",
    textAlign: "center",
    fontWeight: 500,
  },
  submitBtn: {
    padding: "0.65rem 1.5rem",
    background: "#111",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: "0.95rem",
    fontWeight: 600,
    alignSelf: "flex-end",
  },
  submitBtnDisabled: {
    padding: "0.65rem 1.5rem",
    background: "#ccc",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    cursor: "not-allowed",
    fontSize: "0.95rem",
    fontWeight: 600,
    alignSelf: "flex-end",
  },
  error: { color: "#c0392b", fontSize: "0.85rem", textAlign: "center" },
};

function dropZoneStyle(active: boolean): React.CSSProperties {
  return {
    border: `2px dashed ${active ? "#3b82f6" : "#ccc"}`,
    borderRadius: 8,
    padding: "2rem 1rem",
    textAlign: "center",
    color: active ? "#3b82f6" : "#888",
    background: active ? "#eff6ff" : "#f9f9f9",
    cursor: "pointer",
    transition: "all 0.15s",
    fontSize: "0.9rem",
  };
}

export function Sources({ lectureId, onSealed, onBack }: SourcesProps) {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [lastUsedSubjectId, setLastUsedSubjectId] = useState<string | null>(null);
  const [pickerMode, setPickerMode] = useState<SubjectPickerMode>("existing");
  const [selectedSubjectId, setSelectedSubjectId] = useState<string>("");
  const [newSubjectName, setNewSubjectName] = useState("");
  const [presentationFile, setPresentationFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/subjects").then((r) => r.json() as Promise<Subject[]>),
      fetch("/api/subjects/last-used").then((r) => r.json() as Promise<{ subject: Subject | null }>),
    ]).then(([allSubjects, { subject: last }]) => {
      setSubjects(allSubjects);
      if (last) {
        setLastUsedSubjectId(last.id);
        setSelectedSubjectId(last.id);
      } else if (allSubjects.length > 0) {
        setSelectedSubjectId(allSubjects[0]!.id);
      }
    });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file) setPresentationFile(file);
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setPresentationFile(file);
  }, []);

  const handleSubmit = useCallback(async () => {
    setError(null);
    if (!presentationFile) {
      setError(strings.sources.notesAloneError);
      return;
    }

    const formData = new FormData();
    formData.append("presentation", presentationFile);

    if (pickerMode === "new") {
      if (!newSubjectName.trim()) {
        setError(strings.sources.subjectRequiredError);
        return;
      }
      formData.append("subjectName", newSubjectName.trim());
    } else {
      if (!selectedSubjectId && subjects.length === 0) {
        setError(strings.sources.subjectRequiredError);
        return;
      }
      if (selectedSubjectId) formData.append("subjectId", selectedSubjectId);
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/lectures/${lectureId}/sources`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setError(body.error ?? "Upload failed");
        return;
      }
      onSealed();
    } catch {
      setError("Upload failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }, [presentationFile, pickerMode, newSubjectName, selectedSubjectId, subjects.length, lectureId, onSealed]);

  const canSubmit = !submitting && (pickerMode === "new" ? newSubjectName.trim() !== "" : selectedSubjectId !== "");

  return (
    <div
      style={styles.container}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-testid="sources-screen"
    >
      <div style={styles.toolbar}>
        <button style={styles.backBtn} onClick={onBack}>
          ← {strings.write.backToLibrary}
        </button>
        <h1 style={styles.title}>{strings.sources.title}</h1>
      </div>

      <div style={styles.body}>
        <div style={styles.card}>
          {/* Subject picker */}
          <div>
            <div style={styles.fieldLabel}>{strings.sources.subjectLabel}</div>
            {pickerMode === "existing" ? (
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <select
                  style={styles.select}
                  value={selectedSubjectId}
                  onChange={(e) => setSelectedSubjectId(e.target.value)}
                  data-testid="subject-select"
                >
                  {subjects.length === 0 && (
                    <option value="" disabled>{strings.sources.subjectPlaceholder}</option>
                  )}
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.id === lastUsedSubjectId ? " ✓" : ""}
                    </option>
                  ))}
                </select>
                <button
                  style={{ ...styles.backBtn, whiteSpace: "nowrap" as const }}
                  onClick={() => { setPickerMode("new"); setNewSubjectName(""); }}
                >
                  {strings.sources.newSubjectOption}
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input
                  type="text"
                  style={styles.input}
                  placeholder={strings.sources.newSubjectPlaceholder}
                  value={newSubjectName}
                  onChange={(e) => setNewSubjectName(e.target.value)}
                  autoFocus
                  data-testid="new-subject-input"
                />
                <button
                  style={styles.backBtn}
                  onClick={() => setPickerMode("existing")}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {/* Presentation drop zone */}
          <div>
            <div style={styles.fieldLabel}>{strings.sources.presentationLabel}</div>
            <div
              style={dropZoneStyle(dragActive || presentationFile !== null)}
              onClick={() => fileInputRef.current?.click()}
              data-testid="drop-zone"
            >
              {presentationFile
                ? `${strings.sources.fileAccepted}: ${presentationFile.name}`
                : strings.sources.dropZoneHint}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              style={{ display: "none" }}
              onChange={handleFileChange}
              data-testid="file-input"
            />
          </div>

          {error && <p style={styles.error}>{error}</p>}

          <button
            style={canSubmit ? styles.submitBtn : styles.submitBtnDisabled}
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="submit-sources"
          >
            {submitting ? "Uploading…" : strings.sources.submitButton}
          </button>
        </div>
      </div>
    </div>
  );
}
