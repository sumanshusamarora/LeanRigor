<!-- generated_by: leanrigor | asset_version: 4 -->
# /leanrigor-commit

Show the persisted LeanRigor commit proposal without executing it.

Read `.claude/leanrigor/sequential-workflow.md` first.

## Behaviour

1. Use `leanrigor flow next --json` internally for the active or supplied
   workflow.
2. If the workflow is not at `Commit proposal`, explain the current gate and
   next action instead of creating another workflow.
3. If a proposal exists, render grouped commit messages, files, and rationale.
4. State clearly that no commit or push has occurred.
5. Ask for explicit user direction before any git action. Never push.

Do not print raw CLI syntax except for troubleshooting or explicit user request.

$ARGUMENTS
