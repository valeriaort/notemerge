// Developer tool: report placed-block precision and weak-match rate at each candidate threshold.
// Usage: npm run evaluate-alignment -- labelled1.json [labelled2.json ...] [--target 0.95] [--thresholds 0.4,0.5,0.6]
// Each file is GET /api/lectures/:id/alignment/export with correctWindowId filled in on each
// block (a window id such as "W003", or "not taught"); blocks left null are ignored for precision.
import { readFileSync } from "fs";
import { evaluateAlignment, formatReport } from "../src/server/alignmentEvaluation.js";
import type { AlignmentExport } from "../src/shared/types.js";

const files: string[] = [];
let target: number | undefined;
let thresholds: number[] | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--target") target = Number(args[++i]);
  else if (args[i] === "--thresholds") thresholds = args[++i]!.split(",").map(Number);
  else files.push(args[i]!);
}
if (files.length === 0) {
  console.error("Usage: evaluate-alignment <labelled-export.json>... [--target 0.95] [--thresholds 0.4,0.5]");
  process.exit(1);
}
const exports = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as AlignmentExport);
console.log(formatReport(evaluateAlignment(exports, { targetPrecision: target, thresholds })));
