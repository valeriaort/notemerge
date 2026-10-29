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
// node_modules is isolated per sandbox: the container installs Linux native
// modules (better-sqlite3) which must never overwrite the host's macOS build.
const sandbox = (name: string) => {
  mkdirSync(`.sandcastle/cache/node_modules/${name}`, { recursive: true });
  return docker({
    imageName: "notemerge-sandcastle",
    mounts: [
      {
        hostPath: `.sandcastle/cache/node_modules/${name}`,
        sandboxPath: "/home/agent/workspace/node_modules",
      },
      { hostPath: ".sandcastle/cache/npm", sandboxPath: "/home/agent/.npm" },
      {
        hostPath: ".sandcastle/cache/playwright",
        sandboxPath: "/home/agent/.cache/ms-playwright",
      },
    ],
  });
};

// Runs in every sandbox before the agent starts. No-ops until ticket #3 has
// created package.json; installs the Playwright browser once it is a dependency.
const hooks = {
  sandbox: {
    onSandboxReady: [
      {
        command:
          "[ -f package.json ] && npm install && (grep -q playwright package.json && npx playwright install chromium || true) || true",
        // Cold node_modules (isolated per sandbox) took 51s on #4 against the 60s default.
        timeoutMs: 10 * 60 * 1000,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Usage-limit handling
// ---------------------------------------------------------------------------
// Sandcastle has no notion of Claude usage limits, so a limit hit surfaces as a
// generic agent failure. We recognise limit-like errors by message, sleep, and
// re-run the same step. Retries re-run on the same branch, so commits already
// made are kept (resumeSession is not usable with maxIterations > 1).
// The patterns are a best guess; widen them if a real limit slips through.

const LIMIT_PATTERN =
  /usage limit|rate.?limit|limit reached|hit your .{0,30}limit|quota|credit|\b429\b|overloaded|resets? (at|in|\d)/i;
const BACKOFF_MIN = [5, 10, 20, 30]; // minutes; last value repeats
const MAX_SINGLE_WAIT_MS = 6 * 60 * 60 * 1000; // longer than this: stop and tell the user
const MAX_TOTAL_WAIT_MS = 12 * 60 * 60 * 1000;

let totalWaitedMs = 0;
let limitAbort: string | undefined;

const errorText = (e: unknown): string => {
  if (e instanceof Error) return `${e.name}: ${e.message}\n${String((e as { cause?: unknown }).cause ?? "")}`;
  return String(e);
};

// Claude Code reports either "...usage limit reached|<epoch seconds>" or
// "You've hit your 5-hour limit · resets 8pm (UTC)". Only UTC clock times are parsed.
const parseResetMs = (text: string): number | undefined => {
  const epoch = text.match(/limit reached\|(\d{10})/i);
  if (epoch) return Number(epoch[1]) * 1000;
  const m = text.match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i);
  if (!m) return undefined;
  let hour = Number(m[1]) % 12;
  if (m[3]!.toLowerCase() === "pm") hour += 12;
  const t = new Date();
  t.setUTCHours(hour, Number(m[2] ?? 0), 0, 0);
  // A time that passed within the last 15 minutes means the limit has just reset.
  if (t.getTime() <= Date.now() - 15 * 60_000) t.setUTCDate(t.getUTCDate() + 1);
  return t.getTime();
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Network outages --------------------------------------------------------
// A dropped connection makes agent calls fail with ordinary-looking errors. We
// recognise them, poll until Anthropic and GitHub answer again, then retry the
// step on the same branch. Timings are env-overridable so the path can be tested.
const NETWORK_PATTERN =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|socket hang up|fetch failed|getaddrinfo|Could not resolve host|Unable to connect|Failed to connect|connection (error|reset|refused|timed out|closed)|network (error|is unreachable)|ERR_NETWORK/i;
const NET_POLL_MS = Number(process.env.NM_NET_POLL_MS ?? 20_000);
const NET_SETTLE_MS = Number(process.env.NM_NET_SETTLE_MS ?? 15_000);
const NET_MAX_WAIT_MS = 3 * 60 * 60 * 1000; // per outage
const NET_MAX_UP_RETRIES = 6; // network-looking errors while the network is up: likely not an outage
let outageSeen = false; // set when a network problem was handled; enables a final retry pass

async function networkUp(): Promise<boolean> {
  const reach = (url: string) =>
    fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5_000) }).then(() => true, () => false);
  const [a, g] = await Promise.all([reach("https://api.anthropic.com"), reach("https://api.github.com")]);
  return a && g;
}

// Resolves true once the network answers, false if it stayed down past the cap.
async function waitForNetwork(label: string): Promise<boolean> {
  if (await networkUp()) return true;
  outageSeen = true;
  console.warn(`  ⏸ ${label}: network is down. Polling every ${Math.round(NET_POLL_MS / 1000)}s (cap ${NET_MAX_WAIT_MS / 3_600_000}h).`);
  const t0 = Date.now();
  while (Date.now() - t0 < NET_MAX_WAIT_MS) {
    await sleep(NET_POLL_MS);
    if (await networkUp()) {
      console.warn(`  ▶ ${label}: network is back after ${Math.round((Date.now() - t0) / 1000)}s.`);
      return true;
    }
  }
  return false;
}

async function withLimitRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let netRetries = 0;
  for (let attempt = 0; ; attempt++) {
    if (limitAbort) throw new Error(`skipped, run aborted: ${limitAbort}`);
    try {
      return await fn();
    } catch (e) {
      const text = errorText(e);
      if (!LIMIT_PATTERN.test(text)) {
        // An outage usually shows up as a silent agent (idle timeout), not a network error.
        const idle = /AgentIdleTimeoutError/.test(text);
        if (!NETWORK_PATTERN.test(text) && !(idle && !(await networkUp()))) throw e;
        const wasDown = !(await networkUp());
        netRetries = wasDown ? 0 : netRetries + 1;
        if (netRetries > NET_MAX_UP_RETRIES) throw e;
        console.warn(`  ⏸ ${label}: network error (${text.split("\n")[0]!.slice(0, 120)}). Waiting for connectivity.`);
        outageSeen = true;
        if (!(await waitForNetwork(label))) throw e;
        await sleep(NET_SETTLE_MS);
        continue;
      }

      const resetAt = parseResetMs(text);
      const waitMs = resetAt
        ? Math.max(resetAt - Date.now(), 0) + 60_000
        : BACKOFF_MIN[Math.min(attempt, BACKOFF_MIN.length - 1)]! * 60_000;

      if (waitMs > MAX_SINGLE_WAIT_MS || totalWaitedMs + waitMs > MAX_TOTAL_WAIT_MS) {
        limitAbort = `${label}: usage limit needs ${Math.round(waitMs / 60_000)} min wait, over the cap`;
        throw e;
      }
      totalWaitedMs += waitMs;
      console.warn(
        `  ⏸ ${label}: usage limit suspected (${text.split("\n")[0]!.slice(0, 160)}). ` +
          `Waiting ${Math.round(waitMs / 60_000)} min, then retrying (attempt ${attempt + 1}).`,
      );
      await sleep(waitMs);
    }
  }
}

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

// Synchronous gh call that rides out connectivity loss instead of crashing the run.
function ghWithRetry(ghArgs: string[]): string {
  const t0 = Date.now();
  for (;;) {
    try {
      return execFileSync("gh", ghArgs, { encoding: "utf8" });
    } catch (e) {
      if (Date.now() - t0 > NET_MAX_WAIT_MS) throw e;
      outageSeen = true;
      console.warn(`  ⏸ gh ${ghArgs.slice(0, 2).join(" ")} failed (${errorText(e).split("\n")[0]!.slice(0, 120)}). Retrying in ${Math.round(NET_POLL_MS / 1000)}s.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, NET_POLL_MS);
    }
  }
}

function loadIssues(): Issue[] {
  const raw = ghWithRetry([
    "issue", "list", "--state", "all", "--limit", "200",
    "--json", "number,title,state,body,labels",
  ]);
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
let retryPasses = 0;

for (let wave = 1; wave <= MAX_WAVES; wave++) {
  const { ready, waiting } = classify(loadIssues(), skipped);
  if (ready.length === 0) {
    console.log("\nNothing ready.");
    for (const w of waiting)
      console.log(`  #${w.issue.number} waiting on ${w.on.map((n) => "#" + n).join(", ")}`);
    if (skipped.size) console.log(`  skipped this session: ${[...skipped].map((n) => "#" + n).join(", ")}`);
    // Failures during an outage may be transient: give skipped issues one more pass.
    if (skipped.size && outageSeen && retryPasses < 1) {
      retryPasses++;
      console.log("  A network outage was handled earlier; retrying skipped issues once.");
      skipped.clear();
      continue;
    }
    break;
  }

  const batch = ready.slice(0, CONCURRENCY);
  console.log(`\n=== Wave ${wave}: ${batch.map((i) => `#${i.number}`).join(", ")} ===\n`);

  const settled = await Promise.allSettled(
    batch.map((issue) =>
      withLimitRetry(`#${issue.number}`, () => sandcastle.run({
        hooks,
        sandbox: sandbox(`issue-${issue.number}`),
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
      })),
    ),
  );

  if (limitAbort) {
    console.error(`\nStopping: ${limitAbort}. Re-run after the limit resets.`);
    process.exit(2);
  }

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

  await withLimitRetry("merger", () => sandcastle.run({
    hooks,
    sandbox: sandbox("merger"),
    name: "merger",
    maxIterations: 1,
    agent: sandcastle.claudeCode(MERGE_MODEL),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      BRANCHES: merged.map((i) => `- sandcastle/issue-${i.number}`).join("\n"),
      ISSUES: merged.map((i) => `- ${i.number}: ${i.title}`).join("\n"),
    },
  }));

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
