<!-- generated_by: leanrigor | asset_version: 2 -->
# /leanrigor-plan

Show, generate, approve, or revise the persisted LeanRigor plan.

Read `.claude/leanrigor/sequential-workflow.md` first.

## Behaviour

1. Use `leanrigor flow active --json` and `leanrigor flow next --json`
   internally.
2. Show an existing plan when one exists; do not create a duplicate workflow.
3. If approach approval is pending, render `Approach approval`; after approval,
   invoke the transition internally and immediately render `Plan approval`.
4. If no active workflow exists and `$ARGUMENTS` is a request, start one.
5. If the user gives revision feedback, revise the persisted plan internally
   and render the revised phases.

Do not modify implementation files from this command. Do not show raw CLI
commands except for troubleshooting or explicit user request.

$ARGUMENTS
