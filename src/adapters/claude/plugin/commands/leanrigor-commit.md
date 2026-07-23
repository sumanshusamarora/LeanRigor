<!-- generated_by: leanrigor | asset_version: 2 -->
# /leanrigor-commit

Prepare a LeanRigor commit proposal without executing it.

## Behaviour

1. Run `leanrigor flow status` to confirm the workflow is in
   `awaiting_commit_approval`.
2. Run `leanrigor flow commit-plan <workflow-id>` and present the proposal.
3. Inspect the diff when useful:
   - Staged changes: `git diff --cached`
   - All changes: `git diff HEAD`
4. Confirm the proposal contains:
   - commit messages
   - file groups
   - exact commands
   - rationale
5. Present the proposal and stop. Wait for explicit user confirmation before
   executing any git commands.

## Constraints

- Do not run `git commit` without explicit user confirmation
- Do not run `git push` under any circumstances
- Do not amend, rebase, or rewrite history
- Do not stage or unstage files without user direction
