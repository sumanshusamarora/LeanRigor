<!-- generated_by: leanrigor | asset_version: 2 -->
# /leanrigor-plan

Produce or revise a persisted LeanRigor sequential plan without modifying files.

Read `.claude/leanrigor/sequential-workflow.md` first.

## Purpose

Drive the workflow only through planning gates. Deliver the plan and stop.

## Behaviour

1. Run `leanrigor flow status` or `leanrigor flow start "$ARGUMENTS" --provider auto`.
2. If clarification or approach approval is pending, present that gate and stop.
3. If approach approval is explicit, run `leanrigor flow approve-approach <workflow-id>`.
4. Present the persisted phases from `leanrigor flow status <workflow-id>`.
5. If the user requests changes, run `leanrigor flow revise-plan <workflow-id> "<feedback>"`.
6. Stop before implementation until the user explicitly approves the plan.

## Constraints

- Do not modify implementation files.
- Do not bypass clarification, approach, or plan approval gates.
- Do not commit or push.

$ARGUMENTS
