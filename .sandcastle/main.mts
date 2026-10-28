// Wave-aware orchestrator for NoteMerge.
//
// Dependencies live in each issue body as a "Blocked by: #n, #m" line, so the
// schedule is computed deterministically on the host (no planner agent):
//   1. Fetch open issues labelled ready-for-agent.
//   2. An issue is ready when every blocker is CLOSED (open blockers, including
//      ready-for-human ones like #2, keep it waiting).
//   3. Run up to CONCURRENCY ready issues in parallel, each on sandcastle/issue-N.
//   4. A merge agent merges the branches that produced commits and closes issues.
//   5. Repeat until nothing is ready.
//
// Usage (from the repo root):
//   npm --prefix .sandcastle run waves                  # print the schedule, run nothing
//   npm --prefix .sandcastle start                      # run everything
//   npm --prefix .sandcastle start -- --only 3          # restrict to these issues
//   npm --prefix .sandcastle start -- --concurrency 3 --max-waves 1

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const READY_LABEL = "ready-for-agent";
// Issues never picked up even if labelled (e.g. the parent spec #1).
const EXCLUDED = new Set([1]);

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const DRY_RUN = args.includes("--dry-run");
const CONCURRENCY = Number(flag("concurrency") ?? 4);
const MAX_WAVES = Number(flag("max-waves") ?? 20);
const ONLY = flag("only")?.split(",").map(Number);

const IMPLEMENT_MODEL = "claude-sonnet-4-6";
const MERGE_MODEL = "claude-opus-4-8"; // merges of parallel branches need care

// Caches are bind-mounted so parallel sandboxes don't re-download everything.
mkdirSync(".sandcastle/cache/npm", { recursive: true });
mkdirSync(".sandcastle/cache/playwright", { recursive: true });
const sandbox = () =>
  docker({
    imageName: "notemerge-sandcastle",
    mounts: [
      { hostPath: ".sandcastle/cache/npm", sandboxPath: "/home/agent/.npm" },
      {
        hostPath: ".sandcastle/cache/playwright",
        sandboxPath: "/home/agent/.cache/ms-playwright",
      },
    ],
  });

// Runs in every sandbox before the agent starts. No-ops until ticket #3 has
// created package.json; installs the Playwright browser once it is a dependency.
const hooks = {
  sandbox: {
    onSandboxReady: [
      {
        command:
          "[ -f package.json ] && npm install && (grep -q playwright package.json && npx playwright install chromium || true) || true",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Issue graph
// ---------------------------------------------------------------------------

type Issue = {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  blockedBy: number[];
};

function loadIssues(): Issue[] {
  const raw = execFileSync(
    "gh",
    [
      "issue", "list", "--state", "all", "--limit", "200",
      "--json", "number,title,state,body,labels",
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(raw).map((i: any): Issue => {
    const line = /^Blocked by:\s*(.*)$/im.exec(i.body ?? "")?.[1] ?? "";
    return {
      number: i.number,
      title: i.title,
      state: i.state,
      labels: i.labels.map((l: any) => l.name),
      blockedBy: [...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1])),
    };
  });
}

function classify(issues: Issue[], skipped: Set<number>) {
  const byNum = new Map(issues.map((i) => [i.number, i]));
  const candidates = issues.filter(
    (i) =>
      i.state === "OPEN" &&
      i.labels.includes(READY_LABEL) &&
      !EXCLUDED.has(i.number) &&
      !skipped.has(i.number) &&
      (!ONLY || ONLY.includes(i.number)),
  );
  const ready: Issue[] = [];
  const waiting: { issue: Issue; on: number[] }[] = [];
  for (const issue of candidates) {
    const on = issue.blockedBy.filter((n) => byNum.get(n)?.state !== "CLOSED");
    if (on.length === 0) ready.push(issue);
    else waiting.push({ issue, on });
  }
  return { ready: ready.sort((a, b) => a.number - b.number), waiting };
}

// Simulate closing each wave to show the full schedule.
function printSchedule(issues: Issue[]) {
  const sim = issues.map((i) => ({ ...i }));
  const done = new Set<number>();
  for (let wave = 0; wave < MAX_WAVES; wave++) {
    const { ready, waiting } = classify(sim, new Set());
    if (ready.length === 0) {
      for (const w of waiting) {
        const humans = w.on.filter((n) =>
          sim.find((i) => i.number === n)?.labels.includes("ready-for-human"),
        );
        console.log(
          `  stalled #${w.issue.number} (waiting on ${w.on.map((n) => "#" + n).join(", ")}${humans.length ? `; human: ${humans.map((n) => "#" + n).join(", ")}` : ""})`,
        );
      }
      return;
    }
    const batch = ready.slice(0, CONCURRENCY);
    console.log(
      `Wave ${wave}: ${batch.map((i) => `#${i.number}`).join(", ")}` +
        (ready.length > batch.length ? `  (+${ready.length - batch.length} deferred by concurrency)` : ""),
    );
    for (const b of batch) {
      sim.find((i) => i.number === b.number)!.state = "CLOSED";
      done.add(b.number);
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

if (DRY_RUN) {
  console.log(`Schedule (concurrency ${CONCURRENCY}; open human tickets are assumed NOT done):\n`);
  printSchedule(loadIssues());
  process.exit(0);
}

const skipped = new Set<number>(); // failed or produced no commits this session

for (let wave = 1; wave <= MAX_WAVES; wave++) {
  const { ready, waiting } = classify(loadIssues(), skipped);
  if (ready.length === 0) {
    console.log("\nNothing ready.");
    for (const w of waiting)
      console.log(`  #${w.issue.number} waiting on ${w.on.map((n) => "#" + n).join(", ")}`);
    if (skipped.size) console.log(`  skipped this session: ${[...skipped].map((n) => "#" + n).join(", ")}`);
    break;
  }

  const batch = ready.slice(0, CONCURRENCY);
  console.log(`\n=== Wave ${wave}: ${batch.map((i) => `#${i.number}`).join(", ")} ===\n`);

  const settled = await Promise.allSettled(
    batch.map((issue) =>
      sandcastle.run({
        hooks,
        sandbox: sandbox(),
        branchStrategy: { type: "branch", branch: `sandcastle/issue-${issue.number}` },
        name: `issue-${issue.number}`,
        maxIterations: 40,
        agent: sandcastle.claudeCode(IMPLEMENT_MODEL),
        promptFile: "./.sandcastle/implement-prompt.md",
        promptArgs: {
          TASK_ID: String(issue.number),
          ISSUE_TITLE: issue.title,
          BRANCH: `sandcastle/issue-${issue.number}`,
        },
      }),
    ),
  );

  const merged: Issue[] = [];
  settled.forEach((outcome, i) => {
    const issue = batch[i]!;
    if (outcome.status === "rejected") {
      console.error(`  ✗ #${issue.number} failed: ${outcome.reason}`);
      skipped.add(issue.number);
    } else if (outcome.value.commits.length === 0) {
      console.error(`  ✗ #${issue.number} made no commits`);
      skipped.add(issue.number);
    } else {
      merged.push(issue);
    }
  });

  if (merged.length === 0) continue;

  await sandcastle.run({
    hooks,
    sandbox: sandbox(),
    name: "merger",
    maxIterations: 1,
    agent: sandcastle.claudeCode(MERGE_MODEL),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      BRANCHES: merged.map((i) => `- sandcastle/issue-${i.number}`).join("\n"),
      ISSUES: merged.map((i) => `- ${i.number}: ${i.title}`).join("\n"),
    },
  });

  // Anything the merger left open must not be retried in a loop; also its
  // dependents stay blocked because blockers are only satisfied by CLOSED.
  const after = loadIssues();
  for (const i of merged) {
    if (after.find((a) => a.number === i.number)?.state !== "CLOSED") {
      console.warn(`  ! #${i.number} not closed after merge; needs a look`);
      skipped.add(i.number);
    }
  }
}

console.log("\nAll done.");
