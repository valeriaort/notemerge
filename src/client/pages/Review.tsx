import { useState, useEffect } from "react";
import type { MergedBlock } from "../../shared/types.js";
import { strings } from "../../shared/strings.js";

interface ReviewProps {
  lectureId: string;
  onBack: () => void;
}

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
  title: { fontWeight: 700, fontSize: "1.1rem" },
  block: {
    padding: "0.5rem 0.75rem",
    marginBottom: "0.25rem",
    borderRadius: 4,
    fontSize: "0.95rem",
    lineHeight: 1.5,
  },
  studentBlock: {
    background: "transparent",
  },
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
    color: "#1a7336",
  },
};

function blockStyle(block: MergedBlock): React.CSSProperties {
  if (block.origin === "addition") return { ...styles.block, ...styles.additionBlock };
  if (block.origin === "fallback") return { ...styles.block, ...styles.fallbackBlock };
  return { ...styles.block, ...styles.studentBlock };
}

function BlockView({ block }: { block: MergedBlock }) {
  const isAddition = block.origin === "addition" || block.origin === "fallback";
  return (
    <div style={blockStyle(block)} data-testid={`merged-block-${block.origin}`}>
      {isAddition && (
        <div style={styles.label}>{strings.review.additionLabel}</div>
      )}
      <div>{block.text}</div>
      {isAddition && block.citations.length > 0 && (
        <div style={styles.citation}>
          {block.citations.map((c) => (
            <span key={c.sourceId}>
              [{c.sourceId}] {c.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function Review({ lectureId, onBack }: ReviewProps) {
  const [blocks, setBlocks] = useState<MergedBlock[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/lectures/${lectureId}/merged-note`)
      .then((r) => {
        if (!r.ok) throw new Error("not found");
        return r.json() as Promise<{ blocks: MergedBlock[] }>;
      })
      .then((data) => setBlocks(data.blocks))
      .catch(() => setError(strings.review.noMergedNote));
  }, [lectureId]);

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <button style={styles.backBtn} onClick={onBack}>
          ← Back
        </button>
        <span style={styles.title}>{strings.review.title}</span>
      </div>
      {error && <p>{error}</p>}
      {blocks === null && !error && <p>Loading...</p>}
      {blocks !== null && blocks.length === 0 && <p>{strings.review.noMergedNote}</p>}
      {blocks !== null &&
        blocks.map((b) => <BlockView key={b.id} block={b} />)}
    </div>
  );
}
