<!-- generated_by: leanrigor | asset_version: 1 -->
# /leanrigor-plan

Produce a LeanRigor execution plan without modifying any files.

## Purpose

Run bounded triage, perform narrow repository inspection, and produce an
execution graph. Deliver the plan and stop.

## Behaviour

1. Run `leanrigor triage "$ARGUMENTS" --provider auto`.
2. Read `.leanrigor/workflow.json` for the triage output.
3. Perform narrow repository inspection against the inspection targets
   identified by triage — do not scan the entire repository.
4. Produce an execution graph with:
   - Tasks ordered by dependency
   - Objectives, read sets, and write sets per task
   - Validation commands and completion criteria
   - Review level required by the selected mode
5. Present the plan and stop.

## Constraints

- Do not modify implementation files
- Do not commit, push, or run shell commands beyond triage and read operations
- Stop after delivering the plan

$ARGUMENTS
