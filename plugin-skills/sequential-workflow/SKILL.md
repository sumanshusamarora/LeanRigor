---
name: leanrigor-sequential-workflow
description: Use when running LeanRigor's persisted sequential workflow in Claude Code.
---

LeanRigor is Claude's persisted workflow controller. Users interact in plain
language; Claude invokes LeanRigor CLI transitions internally and renders
concise workflow summaries.

Use the plugin-owned runtime internally:

`${CLAUDE_PLUGIN_ROOT}/bin/leanrigor`

## Engineering Methodology

LeanRigor's shared methodology lives under `methodology/` in the plugin root.
After reading the current workflow mode from `flow next --json`, load:

- `methodology/core.md`
- `methodology/modes/<fast|standard|rigorous>.md`

Then load only the relevant methodology files for the current step:

- planning or plan revision: `methodology/planning.md`
- design-heavy changes: `methodology/design.md`
- implementation edits: `methodology/implementation.md`
- bugs, failures, failed repairs, or flaky behavior: `methodology/debugging.md`
- validation selection or recording: `methodology/testing.md`
- phase or final review: `methodology/review.md`
- completion evidence or success claims: `methodology/evidence.md`
- security, migration, API, data, privacy, production, infrastructure,
  concurrency, or destructive-operation risks: `methodology/safeguards.md`

Do not load every methodology file for every task. Fast mode must stay compact.

Repository-local state:

- `.leanrigor/config.json`
- `.leanrigor/workflows/`

Do not create or modify repository `.claude/` files in marketplace mode. Do not
commit, push, create worktrees, or spawn parallel agents automatically.

## Conversational Flow

`/leanrigor:start` is the primary command and owns the normal workflow:

`triage summary -> Approach approval? -> Plan approval -> sequential execution -> per-phase completion gate -> final integrated review -> commit proposal`

Use `flow active --json` to discover repository workflows and `flow next
--json` to read the next gate. Use transition commands internally after user
approval. Do not show shell commands during normal use.

Labels must stay distinct:

- `Approach approval`
- `Plan approval`
- `Phase completion review`
- `Final integrated review`
- `Commit proposal`

Do not call an approach summary a plan. Do not ask for plan approval until
persisted phases exist.

## Active Workflow Selection

- One active workflow: resume it.
- No active workflow: start only when the user supplied a request.
- Multiple active workflows: show ID, request, state, mode, and updated time;
  ask the user to choose.
- Completed and cancelled workflows are not selected by default.
- Never attach a new request to an unrelated active workflow silently.

## Natural Responses

Interpret common responses using the current persisted state:

- `approve`, `looks good`, `continue` at `awaiting_approach_approval`: approve approach, then immediately render the generated plan for plan approval.
- `approve`, `looks good`, `continue` at `awaiting_plan_approval`: approve plan and begin the first phase.
- `revise ...`: revise the current approach/plan when that gate is active.
- `reject because ...`: reject the approach with the supplied reason.
- `cancel`: cancel the workflow after confirming intent when destructive to progress.
- `show plan` / `show status`: render persisted plan/status.
- `repair it` at `needs_repair`: start the bounded repair requested by the gate.
- `continue` at `needs_repair`, `needs_review`, or `needs_replan`: do not bypass the gate; explain the required repair, review, or replan.

Ask one concise clarification for ambiguous responses.

## Phase And Review Rules

During execution, each phase must pass:

`active -> targeted validation -> completion gate -> completed | needs_repair | needs_review | needs_replan | blocked`

Run declared validation or explicitly record skipped validation with a reason.
Submit criterion evidence, changed files, validation, assumptions, risks, and
scope deviations with `flow phase-complete`. Follow the returned gate decision;
Claude must not unlock the next phase itself.

Final integrated review remains required after all phase gates pass.

## Presentation

Render human summaries first:

- workflow ID, request, mode, state;
- current phase and completion-gate status;
- criteria and validation progress;
- repair attempts, blockers, and next action;
- concise phase list or commit groups when relevant.

Avoid raw JSON, repeated methodology, full state-machine dumps, and shell
commands in normal output.

## Troubleshooting

If a LeanRigor command fails, show:

```text
I could not run the LeanRigor transition automatically.

You can retry, or run:
<exact command>

Error:
<concise error>
```

Raw commands belong only in this troubleshooting fallback, manual/advanced
documentation, or when the user explicitly asks for them.
