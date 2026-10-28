# Test split

## API seam (primary)

All behavioural tests live in `tests/api/` and run with `npm run test` (Vitest).
They boot the server on a free port against a temporary data directory with all
provider fakes injected. They assert on external behaviour — what a student
provides and what the server returns — and do not assert on internal structure,
prompts, or intermediate data shapes beyond the documented IDs and verdict
contracts.

## Browser checks (secondary)

Browser tests live in `tests/browser/` and run with `npm run test:browser` (Playwright).
They guard **keyboard interaction and screen behaviour only** — things that
cannot be verified at the API seam. They do not duplicate API-level assertions.

Each browser test:
1. Seeds initial state through the API using `seedLecture()`.
2. Navigates to the relevant page using `openLecturePage()`.
3. Asserts on what the student sees or can do with the keyboard.

## Adding browser checks for later tickets

Import helpers from `tests/browser/helpers.ts`:

```ts
import { seedLecture, openLecturePage } from "./helpers.js";
```

Use `seedLecture(apiUrl)` to create a lecture and optionally update its notes
or stage via API calls before the browser opens it.

Use `openLecturePage(page, baseUrl, lectureId)` to navigate directly to a
lecture's Write view.

Start the server in your test with `startBrowserTestServer()` from helpers,
which boots a fresh server with fakes on a free port and tears it down after
the test.

## End-to-end smoke test

The combined journey (create → upload → transcribe → merge → review → export)
is issue #30.
