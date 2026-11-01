import type { AlignmentExport } from "../shared/types.js";

export const NOT_TAUGHT = "not taught";

export interface ThresholdReport {
  threshold: number;
  // Blocks (labelled or not) that are weak at this threshold, over all blocks
  weakMatchRate: number;
  placedBlocks: number;
  // Labelled placed blocks assigned to their labelled window, over labelled placed blocks
  precision: number | null;
}

export interface EvaluationReport {
  rows: ThresholdReport[];
  labelledBlocks: number;
  totalBlocks: number;
  targetPrecision: number;
  // Lowest candidate threshold reaching targetPrecision, if any
  recommendedThreshold: number | null;
}

export const DEFAULT_CANDIDATE_THRESHOLDS = Array.from({ length: 19 }, (_, i) => Math.round((i + 1) * 5) / 100);

// Placed-block precision and weak-match rate at each candidate threshold, over hand-labelled
// exports (a block placed in a window when "not taught" counts as a misplacement). A block the
// order-preserving alignment skipped is weak at every threshold.
export function evaluateAlignment(
  exports: AlignmentExport[],
  opts: { thresholds?: number[]; targetPrecision?: number } = {},
): EvaluationReport {
  const thresholds = opts.thresholds ?? DEFAULT_CANDIDATE_THRESHOLDS;
  const targetPrecision = opts.targetPrecision ?? 0.95;
  const blocks = exports.flatMap((e) => e.blocks);
  const rows = thresholds.map((threshold): ThresholdReport => {
    const placed = blocks.filter((b) => b.placed && b.score >= threshold);
    const labelled = placed.filter((b) => b.correctWindowId);
    const correct = labelled.filter((b) => b.correctWindowId === b.windowId).length;
    return {
      threshold,
      weakMatchRate: blocks.length ? 1 - placed.length / blocks.length : 0,
      placedBlocks: placed.length,
      precision: labelled.length ? correct / labelled.length : null,
    };
  });
  const recommended = rows.find((r) => r.precision !== null && r.precision >= targetPrecision);
  return {
    rows,
    labelledBlocks: blocks.filter((b) => b.correctWindowId).length,
    totalBlocks: blocks.length,
    targetPrecision,
    recommendedThreshold: recommended?.threshold ?? null,
  };
}

export function formatReport(r: EvaluationReport): string {
  const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const lines = [
    `Labelled blocks: ${r.labelledBlocks} of ${r.totalBlocks}`,
    "threshold  placed  precision  weak-match rate",
    ...r.rows.map(
      (x) =>
        `${x.threshold.toFixed(2).padStart(9)}  ${String(x.placedBlocks).padStart(6)}  ${pct(x.precision).padStart(9)}  ${pct(x.weakMatchRate).padStart(15)}`,
    ),
    r.recommendedThreshold === null
      ? `No candidate threshold reaches ${pct(r.targetPrecision)} precision.`
      : `Lowest threshold reaching ${pct(r.targetPrecision)} precision: ${r.recommendedThreshold.toFixed(2)}`,
  ];
  return lines.join("\n");
}
