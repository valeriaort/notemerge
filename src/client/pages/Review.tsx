import { useState, useEffect, useRef } from "react";
import type { MergedBlock, Lecture, AudioFile } from "../../shared/types.js";
import { strings } from "../../shared/strings.js";

interface ReviewProps {
  lectureId: string;
  onBack: () => void;
  onExported?: () => void;
}

type FinalNoteBlock = { id: string; text: string };

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 800, margin: "0 auto", padding: "1rem" },
  toolbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "1rem",
    gap: "0.5rem",
    flexWrap: "wrap" as const,
  },
  backBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: "#666",
    fontSize: "0.9rem",
  },
  title: { fontWeight: 700, fontSize: "1.1rem" },
  exportBtn: {
    padding: "0.4rem 0.9rem",
    borderRadius: 4,
    border: "none",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "0.85rem",
  },
  exportBtnEnabled: { background: "#1a7336", color: "#fff" },
  exportBtnDisabled: { background: "#ccc", color: "#777", cursor: "not-allowed" },
  toggleBtn: {
    padding: "0.3rem 0.7rem",
    borderRadius: 4,
    border: "1px solid #aaa",
    cursor: "pointer",
    fontSize: "0.82rem",
    background: "#f5f5f5",
    color: "#333",
  },
  toggleBtnActive: {
    background: "#333",
    color: "#fff",
    border: "1px solid #333",
  },
  actions: { display: "flex", gap: "0.5rem", alignItems: "center" },
  conflict: { color: "#c00", fontSize: "0.8rem", marginLeft: "0.5rem" },
  block: {
    padding: "0.5rem 0.75rem",
    marginBottom: "0.25rem",
    borderRadius: 4,
    fontSize: "0.95rem",
    lineHeight: 1.5,
  },
  studentBlock: { background: "transparent" },
  additionBlock: {
    background: "#d4edda",
    border: "1px solid #b8dac5",
    color: "#155724",
  },
  fallbackBlock: {
    background: "#d4edda",
    border: "1px dashed #b8dac5",
    color: "#155724",
  },
  conflictBlock: {
    background: "#fff3cd",
    border: "1px solid #ffc107",
    color: "#856404",
  },
  citation: {
    fontSize: "0.78rem",
    color: "#555",
    marginTop: "0.2rem",
    fontStyle: "italic",
  },
  label: {
    fontSize: "0.7rem",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    marginBottom: "0.1rem",
  },
  cleanBlock: {
    padding: "0.5rem 0.75rem",
    marginBottom: "0.25rem",
    borderRadius: 4,
    fontSize: "0.95rem",
    lineHeight: 1.5,
    background: "transparent",
  },
  // Print: only show clean content
  printTitle: { fontWeight: 700, fontSize: "1.1rem", marginBottom: "1rem" },
};

function blockStyle(block: MergedBlock): React.CSSProperties {
  if (block.origin === "conflict") return { ...styles.block, ...styles.conflictBlock };
  if (block.origin === "addition" || block.origin === "partial_fix") return { ...styles.block, ...styles.additionBlock };
  if (block.origin === "fallback") return { ...styles.block, ...styles.fallbackBlock };
  return { ...styles.block, ...styles.studentBlock };
}

function PlayButton({
  lectureId,
  blockId,
  sentenceId,
  onPlayed,
}: {
  lectureId: string;
  blockId: string;
  sentenceId: string;
  onPlayed?: (updated: MergedBlock) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  async function handlePlay() {
    const url = `/api/lectures/${lectureId}/sentences/${sentenceId}/audio-clip`;
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const startMs = Number(res.headers.get("x-sentence-start-ms") ?? "0");
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      if (audioRef.current) {
        audioRef.current.pause();
        URL.revokeObjectURL(audioRef.current.src);
      }
      const audio = new Audio(objectUrl);
      audioRef.current = audio;
      const startSec = Math.max(0, startMs / 1000 - 3);
      audio.addEventListener("loadedmetadata", () => {
        audio.currentTime = startSec;
        void audio.play();
      });
      audio.addEventListener("ended", () => URL.revokeObjectURL(objectUrl));
      audio.load();

      const patchRes = await fetch(`/api/lectures/${lectureId}/merged-note/${blockId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ played: true }),
      });
      if (patchRes.ok) {
        const patchBody = await patchRes.json() as { block: MergedBlock };
        onPlayed?.(patchBody.block);
      }
    } catch {
      // ignore playback errors
    }
  }

  return (
    <button
      data-testid="review-play-button"
      style={{ marginLeft: "0.5rem", fontSize: "0.78rem", padding: "0.1rem 0.4rem" }}
      onClick={() => void handlePlay()}
      title={strings.review.playLabel}
    >
      ▶ {strings.review.playLabel}
    </button>
  );
}

function BlockView({
  block,
  lectureId,
  hasAudio,
  onBlockUpdated,
}: {
  block: MergedBlock;
  lectureId: string;
  hasAudio: boolean;
  onBlockUpdated?: (updated: MergedBlock) => void;
}) {
  const isAddition = block.origin === "addition" || block.origin === "partial_fix" || block.origin === "fallback";
  const isConflict = block.origin === "conflict";
  const transcriptCitations = block.citations.filter((c) => c.kind === "transcript");
  const showPlay = hasAudio && transcriptCitations.length > 0;

  async function patchReviewState(reviewState: string) {
    const res = await fetch(`/api/lectures/${lectureId}/merged-note/${block.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewState }),
    });
    if (res.ok) {
      const body = await res.json() as { block: MergedBlock };
      onBlockUpdated?.(body.block);
    }
  }

  return (
    <div style={blockStyle(block)} data-testid={`merged-block-${block.origin}`}>
      {isAddition && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ ...styles.label, color: "#1a7336" }}>
            {block.origin === "partial_fix" ? strings.review.partialFixLabel : strings.review.additionLabel}
          </div>
          {block.reviewState !== "reverted" && (
            <button
              data-testid="revert-button"
              style={{ fontSize: "0.75rem", padding: "0.1rem 0.5rem", cursor: "pointer" }}
              onClick={() => void patchReviewState("reverted")}
            >
              Revert
            </button>
          )}
          {block.reviewState === "reverted" && (
            <button
              data-testid="restore-button"
              style={{ fontSize: "0.75rem", padding: "0.1rem 0.5rem", cursor: "pointer" }}
              onClick={() => void patchReviewState("kept")}
            >
              Restore
            </button>
          )}
        </div>
      )}
      {isConflict && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ ...styles.label, color: "#856404" }}>
            {block.reviewState === "unresolved" ? "Conflict — unresolved" : `Conflict — ${block.reviewState}`}
          </div>
          {block.reviewState === "unresolved" && (
            <div style={{ display: "flex", gap: "0.25rem" }}>
              <button
                data-testid="keep-button"
                style={{ fontSize: "0.75rem", padding: "0.1rem 0.5rem", cursor: "pointer" }}
                onClick={() => void patchReviewState("kept")}
              >
                K Keep
              </button>
              <button
                data-testid="edit-button"
                style={{ fontSize: "0.75rem", padding: "0.1rem 0.5rem", cursor: "pointer" }}
                onClick={() => void patchReviewState("edited")}
              >
                E Rewrite
              </button>
            </div>
          )}
          {block.reviewState !== "unresolved" && (
            <button
              data-testid="reopen-button"
              style={{ fontSize: "0.75rem", padding: "0.1rem 0.5rem", cursor: "pointer" }}
              onClick={() => void patchReviewState("unresolved")}
            >
              Reopen
            </button>
          )}
        </div>
      )}
      {block.lowConfidence && (
        <div
          data-testid="low-confidence-badge"
          style={{
            display: "inline-block",
            fontSize: "0.72rem",
            fontWeight: 600,
            background: "#fff3cd",
            border: "1px solid #ffc107",
            color: "#856404",
            borderRadius: 3,
            padding: "0.1rem 0.4rem",
            marginBottom: "0.2rem",
          }}
        >
          {strings.review.checkByEarBadge}
        </div>
      )}
      <div>{block.text}</div>
      {(isAddition || isConflict) && block.citations.length > 0 && (
        <div style={styles.citation}>
          {block.citations.map((c) => (
            <span key={c.sourceId}>
              [{c.sourceId}] {c.text}
            </span>
          ))}
          {showPlay && transcriptCitations.map((c) => (
            <PlayButton
              key={c.sourceId}
              lectureId={lectureId}
              blockId={block.id}
              sentenceId={c.sourceId}
              onPlayed={onBlockUpdated}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function lectureDateLabel(createdAt: number): string {
  return new Date(createdAt).toLocaleDateString("es-ES", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function Review({ lectureId, onBack, onExported }: ReviewProps) {
  const [blocks, setBlocks] = useState<MergedBlock[] | null>(null);
  const [finalBlocks, setFinalBlocks] = useState<FinalNoteBlock[] | null>(null);
  const [cleanPreview, setCleanPreview] = useState(false);
  const [lecture, setLecture] = useState<Lecture | null>(null);
  const [subjectName, setSubjectName] = useState<string>("");
  const [hasAudio, setHasAudio] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const blocksRef = useRef<MergedBlock[] | null>(null);
  blocksRef.current = blocks;

  const hasUnresolved = blocks?.some(
    (b) => b.origin === "conflict" && b.reviewState === "unresolved",
  ) ?? false;

  useEffect(() => {
    fetch(`/api/lectures/${lectureId}/merged-note`)
      .then((r) => {
        if (!r.ok) throw new Error("not found");
        return r.json() as Promise<{ blocks: MergedBlock[] }>;
      })
      .then((data) => setBlocks(data.blocks))
      .catch(() => setError(strings.review.noMergedNote));
  }, [lectureId]);

  useEffect(() => {
    fetch(`/api/lectures/${lectureId}`)
      .then((r) => r.json() as Promise<Lecture>)
      .then((lec) => {
        setLecture(lec);
        if (lec.subjectId) {
          return fetch(`/api/subjects`)
            .then((r) => r.json() as Promise<Array<{ id: string; name: string }>>)
            .then((subjects) => {
              const s = subjects.find((x) => x.id === lec.subjectId);
              if (s) setSubjectName(s.name);
            });
        }
      })
      .catch(() => undefined);
  }, [lectureId]);

  useEffect(() => {
    fetch(`/api/lectures/${lectureId}/audio-files`)
      .then((r) => r.json() as Promise<{ audioFiles: AudioFile[] }>)
      .then((data) => setHasAudio(data.audioFiles.length > 0))
      .catch(() => undefined);
  }, [lectureId]);

  useEffect(() => {
    async function resolveFirstConflict(reviewState: string) {
      const current = blocksRef.current;
      if (!current) return;
      const first = current.find((b) => b.origin === "conflict" && b.reviewState === "unresolved");
      if (!first) return;
      const res = await fetch(`/api/lectures/${lectureId}/merged-note/${first.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewState }),
      });
      if (res.ok) {
        const body = await res.json() as { block: MergedBlock };
        setBlocks((prev) => prev ? prev.map((x) => x.id === body.block.id ? body.block : x) : prev);
      }
    }

    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "k" || e.key === "K") void resolveFirstConflict("kept");
      if (e.key === "e" || e.key === "E") void resolveFirstConflict("edited");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lectureId]);

  useEffect(() => {
    if (!cleanPreview || hasUnresolved) {
      setFinalBlocks(null);
      return;
    }
    fetch(`/api/lectures/${lectureId}/final-note`)
      .then((r) => {
        if (!r.ok) throw new Error("blocked");
        return r.json() as Promise<{ blocks: FinalNoteBlock[] }>;
      })
      .then((data) => setFinalBlocks(data.blocks))
      .catch(() => setFinalBlocks(null));
  }, [cleanPreview, hasUnresolved, lectureId, blocks]);

  async function handleExportPdf() {
    setExportError(null);
    const res = await fetch(`/api/lectures/${lectureId}/export/pdf`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      setExportError(body.error ?? "Export failed.");
      return;
    }
    window.print();
    onExported?.();
  }

  const pdfTitle =
    lecture && subjectName
      ? `${subjectName}: ${lectureDateLabel(lecture.createdAt)}`
      : strings.review.title;

  return (
    <>
      {/* Print stylesheet */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #review-print-area, #review-print-area * { visibility: visible !important; }
          #review-print-area { position: fixed; left: 0; top: 0; width: 100%; }
          #review-print-title { display: block !important; }
        }
        #review-print-title { display: none; }
      `}</style>
      <div style={styles.container} data-testid="review-screen">
        <div style={styles.toolbar}>
          <button style={styles.backBtn} onClick={onBack}>
            ← Back
          </button>
          <span style={styles.title}>{strings.review.title}</span>
          <div style={styles.actions}>
            {hasUnresolved && (
              <span style={styles.conflict}>Unresolved conflicts</span>
            )}
            <button
              style={{
                ...styles.toggleBtn,
                ...(cleanPreview ? styles.toggleBtnActive : {}),
              }}
              onClick={() => setCleanPreview((v) => !v)}
            >
              {strings.export.cleanPreviewToggle}
            </button>
            <button
              style={{
                ...styles.exportBtn,
                ...(hasUnresolved ? styles.exportBtnDisabled : styles.exportBtnEnabled),
              }}
              disabled={hasUnresolved}
              onClick={handleExportPdf}
              data-testid="export-pdf-button"
            >
              {strings.export.pdfButton}
            </button>
          </div>
        </div>
        {exportError && <p style={{ color: "#c00" }}>{exportError}</p>}
        {error && <p>{error}</p>}
        {blocks === null && !error && <p>Loading…</p>}

        {/* Clean preview */}
        {cleanPreview && !hasUnresolved && (
          <div id="review-print-area">
            <div id="review-print-title" style={styles.printTitle}>{pdfTitle}</div>
            {finalBlocks === null && <p>Loading preview…</p>}
            {finalBlocks !== null && finalBlocks.map((b) => (
              <div key={b.id} style={styles.cleanBlock}>{b.text}</div>
            ))}
          </div>
        )}

        {/* Normal review view */}
        {!cleanPreview && blocks !== null && blocks.length === 0 && (
          <p>{strings.review.noMergedNote}</p>
        )}
        {!cleanPreview && blocks !== null && blocks.map((b) => (
          <BlockView
            key={b.id}
            block={b}
            lectureId={lectureId}
            hasAudio={hasAudio}
            onBlockUpdated={(updated) =>
              setBlocks((prev) => prev ? prev.map((x) => x.id === updated.id ? updated : x) : prev)
            }
          />
        ))}
      </div>
    </>
  );
}
