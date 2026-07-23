<!-- generated_by: leanrigor | asset_version: 1 -->
# /leanrigor-commit

Prepare a LeanRigor commit proposal without executing it.

## Behaviour

1. Run `leanrigor status` to confirm the workflow is at or near the
   commit-preparation phase.
2. Inspect the diff:
   - Staged changes: `git diff --cached`
   - All changes: `git diff HEAD`
3. Group changes by cohesive functionality following the task graph in
   `.leanrigor/workflow.json` where available.
4. Propose commit groups with:
   - Conventional commit messages (`type(scope): description`)
   - Exact `git add` and `git commit` commands for each group
   - Rationale for each grouping
5. **Present the proposal and stop. Wait for explicit user confirmation before
   executing any git commands.**

## Constraints

- Do not run `git commit` without explicit user confirmation
- Do not run `git push` under any circumstances
- Do not amend, rebase, or rewrite history
- Do not stage or unstage files without user direction
