# TASK

Merge the following branches into the current branch, in the order listed:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are conflicts, read both sides and keep the intent of both (these branches were built in parallel; shared files such as schema, route registry, config and strings usually need both additions). Never drop either side's tests.
3. After each merge, run whichever of `npm run typecheck`, `npm run test`, `npm run test:browser` exist and make them pass before continuing. Fix integration problems yourself.

Make a commit for any fixes beyond the merge commits.

# CLOSE ISSUES

Only for branches that merged cleanly and pass checks, close the issue:

`gh issue close <ID> --comment "Completed by Sandcastle"`

Issues:

{{ISSUES}}

If a branch cannot be merged safely, do not close its issue; leave a comment explaining why. Once finished, output <promise>COMPLETE</promise>.
