# Workflow

LeanRigor now provides a persisted sequential workflow under
`.leanrigor/workflows/<workflow-id>.json`.

Use the `flow` command group for end-to-end orchestration:

```bash
leanrigor flow start "Fix the assignment regression" --provider auto
leanrigor flow status <workflow-id>
leanrigor flow answer <workflow-id> "<answer>"
leanrigor flow approve-approach <workflow-id>
leanrigor flow approve-plan <workflow-id>
leanrigor flow phase-complete <workflow-id> phase-1 --files "src/api.ts" --command "npm test"
leanrigor flow record-validation <workflow-id> --command "npm test" --exit 0 --result "targeted tests passed"
leanrigor flow record-review <workflow-id> --status passed --summary "Integrated review passed"
leanrigor flow commit-plan <workflow-id>
leanrigor flow complete <workflow-id>
```

## Lifecycle

| State | Meaning | Next safe action |
|---|---|---|
| `created` | Workflow file exists with request and repository root. | Internal transition to triage. |
| `triaging` | Triage is running; implementation files must not be edited. | Persist triage result. |
| `awaiting_clarification` | One blocking question is required. | `flow answer`. |
| `awaiting_approach_approval` | Standard/Rigorous approach gate is pending. | `flow approve-approach` or `flow reject-approach`. |
| `planning` | Sequential plan is being generated. | Internal transition to plan approval. |
| `awaiting_plan_approval` | Phased plan is ready but implementation is blocked. | `flow approve-plan` or `flow revise-plan`. |
| `executing` | Exactly one phase is active. | Complete the active phase and record evidence. |
| `validating` | All phases are complete; validation evidence is required. | `flow record-validation`, then review. |
| `reviewing` | Final integrated review is being recorded. | `flow record-review`. |
| `awaiting_commit_approval` | Review passed and a commit proposal exists. | Inspect proposal; optionally `flow complete`. |
| `completed` | Workflow was closed by explicit user action. | None. |
| `blocked` | Safe progress needs external action or repair budget is exhausted. | Resolve externally or cancel. |
| `cancelled` | User cancelled the workflow. | None. |

## Triage

`flow start` runs the existing triage runner. Model-backed triage is used when
configured, output is schema-validated, deterministic policy overrides are
mandatory, malformed output is retried once, and fallback is deterministic.

Triage persists mode, risk, complexity, escalation reasons, assumptions,
clarification, provider/source, attempts, and warnings. Triage does not create a
detailed implementation plan and does not edit implementation files.

## Gates

Clarification asks at most one blocking question. Non-blocking preferences are
recorded as assumptions or left to the active coding session.

Fast mode skips the separate approach gate only when the task is obvious,
unambiguous, low blast radius, and has no security, data, operational, or
architecture risk. All modes require plan approval before implementation.

Standard and Rigorous mode require approach approval before planning. Rejection
blocks the workflow rather than silently choosing a different path.

## Planning

Plans are sequential. Each phase includes an ID, objective, rationale,
dependencies, expected files or areas, acceptance criteria, validation commands,
risk level, model tier recommendation, status, timestamps, changed files,
commands, validation results, and scope deviations.

The first implementation intentionally avoids parallel agents, worktrees,
OpenCode, Codex, CodeGraph, and per-phase completion hooks.

## Execution Contract

LeanRigor CLI owns durable state and approval gates. Claude Code owns the actual
repository inspection, edits, command execution, and review work in the active
session. After each significant step Claude records concise evidence back into
LeanRigor with `flow phase-complete`, `flow record-validation`, and
`flow record-review`.

The next phase is unlocked only after the active phase completes. Scope
deviations are persisted rather than hidden.

## Validation And Review

Validation is proportional to mode:

| Mode | Default expectation |
|---|---|
| Fast | Syntax/type sanity where relevant, targeted command, diff sanity check. |
| Standard | Targeted tests, package/module checks where available, integrated review. |
| Rigorous | Targeted and broader tests, risk-specific checks, deep or specialist review where triggered. |

Every validation record includes command, exit status, concise result, skipped
flag, skipped reason when relevant, and timestamp. LeanRigor does not mark
validation successful without evidence.

Final review records one of:

- `passed`
- `needs_repair`
- `needs_replan`
- `blocked`

Repair appends a single active repair phase and returns to execution until the
configured repair budget is exhausted. Replan returns to plan approval. Blocked
requires external action.

## Commit Proposal

After review passes, LeanRigor generates a commit proposal grouped by completed
phase file evidence. It shows commit messages, file groups, rationale, and exact
commands. LeanRigor never runs `git commit` or `git push` automatically.

## Resume And Cancel

```bash
leanrigor flow list --root /path/to/repository
leanrigor flow resume <workflow-id> --root /path/to/repository
leanrigor flow cancel <workflow-id> --root /path/to/repository
```

Workflow state is repository-local and survives process restarts, Claude Code
restarts, and context compaction. Reads and writes are schema-validated; writes
are atomic and guarded by an optimistic revision check.
