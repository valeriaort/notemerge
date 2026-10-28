# TASK

Implement GitHub issue #{{TASK_ID}}: {{ISSUE_TITLE}}

Pull it in with `gh issue view {{TASK_ID}} --comments`. Its body links the parent spec (#1, `docs/SPEC.md`); read the relevant parts. Only work on this issue.

Work on branch {{BRANCH}}.

# CONTEXT

Read these before exploring code:

- `CONTEXT.md`: the glossary. Use its vocabulary exactly in code, tests and comments.
- `docs/SPEC.md`: behaviour and testing decisions. `docs/DESIGN.md`: rationale. Read `docs/adr/` if it exists.
- Do not open `NoteMerge Screens.html`, `Product Description.pdf` or `prototype/` unless the issue needs UI details; variant D of the prototype is the UI reference.

Blocking issues are already merged into your branch. Their code is the base to build on; do not redo it.

Recent commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# PARALLEL WORK

Other agents are implementing sibling issues on other branches at the same time and everything is merged afterwards. To keep merges clean:

- Add new files per concern (a route file, a migration, a strings file per screen) rather than growing shared files.
- Touch shared files (schema, route registry, config, strings index) with the smallest additive edit. Do not reformat or reorder them.
- Never rename or move existing modules unless the issue demands it.

# EXECUTION

Use red-green-refactor, one test at a time. Verify behaviour at the server API seam with the provider fakes, as the spec's Testing Decisions describe; browser checks only cover keyboard interaction and screen behaviour.

# FEEDBACK LOOPS

Before each commit, run whichever of these exist in `package.json` and make them pass: `npm run typecheck`, `npm run test`, `npm run test:browser`. If this is the very first issue (#3), you are creating these scripts; make them exist.

# COMMIT

Commit on {{BRANCH}} with a message that:

1. Starts with `#{{TASK_ID}}:`
2. Says what was built and key decisions
3. Notes blockers or follow-ups

# THE ISSUE

If the issue is not fully done, comment on it with what was done and what remains. Do not close it; the merge step does that. Check every acceptance criterion before finishing.

When complete, output <promise>COMPLETE</promise>.

ONLY WORK ON THIS ISSUE.
