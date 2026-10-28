import { useState, useEffect, useRef, useCallback } from "react";
import type { Subject } from "../../shared/types.js";
import { strings } from "../../shared/strings.js";

interface SubjectSettingsProps {
  subjectId: string;
  onBack: () => void;
}

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
  subjectName: { fontSize: "1.1rem", fontWeight: 600 },
  glossaryCount: { fontSize: "0.85rem", color: "#555" },
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
  error: { color: "#c0392b", fontSize: "0.85rem" },
  success: { color: "#16a34a", fontSize: "0.85rem" },
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

export function SubjectSettings({ subjectId, onBack }: SubjectSettingsProps) {
  const [subject, setSubject] = useState<Subject | null>(null);
  const [guiaFile, setGuiaFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/subjects")
      .then((r) => r.json() as Promise<Subject[]>)
      .then((subjects) => {
        const found = subjects.find((s) => s.id === subjectId);
        if (found) setSubject(found);
      });
  }, [subjectId]);

  const handleUpload = useCallback(async () => {
    if (!guiaFile || !subject) return;
    setError(null);
    setSuccessMsg(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("guia", guiaFile);
      const res = await fetch(`/api/subjects/${subject.id}/guia`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setError(body.error ?? strings.glossary.guiaUploadError);
        return;
      }
      const updated = await res.json() as Subject;
      setSubject(updated);
      setGuiaFile(null);
      setSuccessMsg(strings.glossary.guiaUploadSuccess(updated.glossaryTerms.length));
    } catch {
      setError(strings.glossary.guiaUploadError);
    } finally {
      setUploading(false);
    }
  }, [guiaFile, subject]);

  if (!subject) return null;

  return (
    <div style={styles.container} data-testid="subject-settings-screen">
      <div style={styles.toolbar}>
        <button style={styles.backBtn} onClick={onBack}>←</button>
        <h1 style={styles.title}>{strings.glossary.subjectSettingsTitle}</h1>
      </div>

      <div style={styles.body}>
        <div style={styles.card}>
          <div>
            <div style={styles.fieldLabel}>Subject</div>
            <div style={styles.subjectName}>{subject.name}</div>
          </div>

          <div>
            <div style={styles.fieldLabel}>{strings.glossary.guiaLabel}</div>
            <div style={styles.glossaryCount}>
              {subject.glossaryTerms.length > 0
                ? strings.glossary.glossaryTermCount(subject.glossaryTerms.length)
                : strings.glossary.noGlossaryYet}
            </div>
          </div>

          <div>
            <div
              style={dropZoneStyle(guiaFile !== null)}
              onClick={() => fileInputRef.current?.click()}
              data-testid="guia-settings-drop-zone"
            >
              {guiaFile
                ? `${strings.glossary.guiaAccepted}: ${guiaFile.name}`
                : strings.glossary.guiaDropHint}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) { setGuiaFile(f); setError(null); setSuccessMsg(null); }
              }}
              data-testid="guia-settings-file-input"
            />
          </div>

          {error && <p style={styles.error}>{error}</p>}
          {successMsg && <p style={styles.success}>{successMsg}</p>}

          <button
            style={guiaFile && !uploading ? styles.submitBtn : styles.submitBtnDisabled}
            onClick={handleUpload}
            disabled={!guiaFile || uploading}
            data-testid="guia-settings-upload-btn"
          >
            {uploading ? strings.glossary.uploadingGuia : strings.glossary.uploadGuiaButton}
          </button>
        </div>
      </div>
    </div>
  );
}
