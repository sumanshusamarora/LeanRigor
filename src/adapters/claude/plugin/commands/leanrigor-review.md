<!-- generated_by: leanrigor | asset_version: 2 -->
# /leanrigor-review

Show or perform the valid LeanRigor review step.

Read `.claude/leanrigor/sequential-workflow.md` first.

## Behaviour

1. Use `leanrigor flow next --json` internally for the active or supplied
   workflow.
2. If a phase gate needs attention, render `Phase completion review` with
   failed/uncertain criteria, validation state, scope deviations, and required
   repair/replan action.
3. If all phases passed and final review is pending, inspect the current diff,
   perform the configured integrated review, and record the result internally.
4. If a commit proposal already exists, show `Commit proposal`; do not create a
   duplicate review workflow.

Do not silently repair during review. Do not commit or push. Show raw commands
only for troubleshooting or explicit user request.

$ARGUMENTS
