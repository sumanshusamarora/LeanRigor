<!-- generated_by: leanrigor | asset_version: 2 -->
# /leanrigor

Primary LeanRigor entry point for a persisted sequential coding workflow.

Read `.claude/leanrigor/sequential-workflow.md` first.

## Behaviour

1. Inspect current state:
   - If `$ARGUMENTS` is present, run `leanrigor flow start "$ARGUMENTS" --provider auto`.
   - If no request is present, run `leanrigor flow status`; if needed, run
     `leanrigor flow list` and resume the active workflow selected by the user.
2. Present the next required action from LeanRigor state.
3. For `awaiting_clarification`, ask exactly the persisted question and stop.
   After the user answers, run `leanrigor flow answer <workflow-id> "<answer>"`.
4. For `awaiting_approach_approval`, present the persisted recommendation,
   risks, alternatives, and validation strategy. Stop for explicit approval or
   rejection before running `approve-approach` or `reject-approach`.
5. For `awaiting_plan_approval`, present the persisted phased plan. Stop for
   explicit approval or revision before running `approve-plan` or `revise-plan`.
6. For `executing`, work only on the single active phase. After edits, record
   changed files and commands with `leanrigor flow phase-complete`.
7. For `validating`, run proportional validation, then record every result with
   `leanrigor flow record-validation`. Do not mark validation successful without
   evidence or a skipped-validation reason.
8. For `reviewing` or after validation, inspect the full diff and record the
   integrated review with `leanrigor flow record-review`.
9. For `awaiting_commit_approval`, show `leanrigor flow commit-plan`. Do not run
   git commit or push.

## Constraints

- Do not bypass approval gates.
- Do not spawn sub-agents, create worktrees, or use parallel execution.
- Do not run git commit or git push.
- Do not modify files outside the active phase without recording scope deviation.

$ARGUMENTS
