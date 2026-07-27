---
name: leanrigor-sequential-workflow
description: Use when running LeanRigor's persisted sequential workflow in Claude Code.
allowed-tools: AskUserQuestion, Bash(${CLAUDE_PLUGIN_ROOT}/bin/leanrigor *)
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
commit, push, or spawn parallel agents automatically.
LeanRigor is parallel-ready internally, but default execution remains
sequential. Do not launch live parallel Claude agents. Use only
LeanRigor-managed worktrees returned by the CLI; do not create ad hoc
worktrees.

## Conversational Flow

`/leanrigor:start` is the primary command and owns the normal workflow:

`triage summary -> Approach approval? -> Plan approval -> coordinator/manual execution -> per-phase completion gate -> final integrated review -> commit proposal`

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
- No active workflow: start only when the user supplied a request. Invoke
  `flow start "$ARGUMENTS" --provider auto` so automatic triage can call Claude
  when available. Render from the returned `next` object when present or
  immediately read `flow next --json` when it is absent. Do not end the turn
  from raw `flow start` JSON. Use `--provider deterministic` only when the user
  explicitly requests deterministic triage.
- Multiple active workflows: use `AskUserQuestion` to let the user choose among
  them (header: "Workflow"). Show ID, request, state, mode, and updated time in
  each option description. Do not render an ordinary text question first. Fall
  back to a numbered list only when `AskUserQuestion` is genuinely unavailable.
- Completed and cancelled workflows are not selected by default.
- Never attach a new request to an unrelated active workflow silently.

## Approval Actions

When `flow next --json` returns `approvalActions`, call the `AskUserQuestion`
tool to present a structured selector. This is mandatory whenever the tool is available.
Map each action's `label` to the option label and `description` to
the option description. Use a short header (max 12 chars) derived from the
current gate: "Approach", "Plan", "Commit", "Phase", or "Workflow" for
multi-workflow selection. Do not render an ordinary text question such as
"Approve or reject this approach?" before calling the selector.

Fall back to a numbered list of explicit choices only when `AskUserQuestion` is
genuinely unavailable in the current Claude Code environment. Each action has a
deterministic `command` which remains the authority for the transition. Do not infer approval from conversational tone — the user must select an action or type an explicit response.
Do not use `ExitPlanMode` as a substitute for LeanRigor approval.

For the post-triage approach gate, render a compact summary before the selector:

```text
Workflow created and triaged

Workflow: <id>
Mode: <Fast|Standard|Rigorous>

Assessment
<complexity, ambiguity, risk, blast radius, and concise explanation where available>

Key constraints
<persisted triage constraints and explicit revision feedback>

Recommended approach
<persisted recommended approach>

No implementation has started. Your approval is required before planning.
```

Then call `AskUserQuestion` with one concise question and these options in
order:

1. `Approve approach and create plan` — Continue to model-assisted planning
   using the approved triage constraints.
2. `Revise approach` — Let me provide changes or additional constraints before
   planning.
3. `View workflow details` — Show full triage, policy, provenance, and current
   workflow state.
4. `Cancel workflow` — Stop this workflow without starting implementation.

For the clarification gate (`state: awaiting_clarification`), render the
persisted question explicitly and verbatim before waiting for the user's answer:

```text
Workflow created and triaged

Workflow: <id>
Request: <request>
Mode: <Fast|Standard|Rigorous>

Triage clarification

Question: <next.summary.question or clarification.question>

Why this matters: <next.summary.reason or clarification.reason>
```

Do not replace the question with the reason. Do not end with a blank prompt
after "before continuing". If `AskUserQuestion` is available, ask exactly the
persisted question there as well; otherwise ask for a free-form answer in plain
language. The answer must be recorded through `flow answer <workflow-id>
"<answer>" --provider auto`.

### Free-form fallback

The following typed responses remain supported as a fallback:

- `approve`, `looks good`, `continue` at `awaiting_approach_approval`: approve approach with `flow approve-approach <workflow-id> --provider auto`, adding `--add-constraint`, `--remove-constraint`, or `--override-constraint "<old> => <new>"` for any user-supplied constraint changes, then immediately render the generated plan for plan approval. Use deterministic planning only when explicitly requested or when the model provider falls back with a recorded reason.
- `approve`, `looks good`, `continue` at `awaiting_plan_approval`: approve plan, then use coordinator execution with `flow execute-next --provider auto` or `flow execution-poll --provider auto`. Do not begin manual lease/start/workspace execution unless the user explicitly selected manual execution.
- `show status` during execution: render the persisted `recommendedNextPhase`
  as the primary action. Show `otherDependencyReadyPhases` separately as
  available only after explicit user choice. Do not replace Phase 2 with Phase
  4 merely because both are dependency-ready.
- `revise ...` at `awaiting_approach_approval`: record the feedback with `flow revise-approach <workflow-id> "<feedback>"`, rerender the updated approach summary, and ask for approval again. Do not start planning.
- `revise ...` at `awaiting_plan_approval`: use `flow revise-plan <workflow-id> "<feedback>" --provider auto` unless deterministic planning was explicitly requested.
- `reject because ...`: reject the approach with the supplied reason.
- `cancel`: cancel the workflow after confirming intent when destructive to progress.
- `show plan` / `show status`: render persisted plan/status.
- `repair it` at `needs_repair`: start the bounded repair requested by the gate.
- `continue` at `needs_repair`, `needs_review`, or `needs_replan`: do not bypass the gate; explain the required repair, review, or replan.

Ask one concise clarification for ambiguous responses.

## Phase And Review Rules

Execution mode is explicit:

- `execution.mode = coordinator`: default when LeanRigor workspaces and an
  execution provider are configured. Claude approves the plan, invokes or
  resumes the coordinator, monitors persisted execution records, and presents
  gates. Invoke `flow execute-next --provider auto` or
  `flow execution-poll --provider auto`; use the scripted provider only when
  the user explicitly requests scripted/deterministic execution. Claude must
  not implement phase edits itself and must not edit the original working tree.
- If provider dispatch cannot start, present explicit choices: retry configured
  provider, use another available provider, switch to manual execution, or
  cancel. Do not silently substitute providers or modes.
- `execution.mode = manual`: available only after explicit user selection.
  Claude may perform phase work manually, but only in the
  LeanRigor-assigned phase workspace and only through persisted
  phase-completion gates.

Never mix coordinator and manual execution within one workflow. Never claim a
phase is complete from visible file changes alone; only persisted LeanRigor
state and gates decide completion. Never compensate for an unavailable workflow
transition by narrating that the workflow is complete. Report the persisted
state and the exact blocker.

During execution, each phase must pass:

`planned -> ready -> leased/running -> targeted validation -> completion gate -> completed | needs_repair | needs_review | needs_replan | blocked`

In coordinator mode, invoke `flow execute-next --provider auto` or
`flow execution-poll --provider auto` and continue until the next meaningful
persisted gate. A worker completion should be followed by result collection,
completion gate evaluation, internal phase integration, combined validation
when all phases are integrated, and the final integrated review gate. Stop only
when the coordinator reports a user gate, repair, conflict, final review,
commit proposal, or a real error.

Coordinator-owned leases are completed by the coordinator only. Do not infer,
probe, or reuse a provider lease owner string from status output to run
`phase-complete` directly. If the coordinator cannot collect a provider result,
present the recorded provider failure and the allowed recovery choices.

In manual mode before implementation, read the current workflow revision and use a stable owner
ID for this Claude session. Acquire/start a phase lease for one ready phase and
create its phase workspace. Before editing, verify that the current directory
equals the active phase workspace returned by LeanRigor and that Git root is
that workspace. If not, stop rather than editing the wrong tree. Refresh the
lease during long phases where practical, run declared validation in the phase
workspace or explicitly record skipped validation with a reason.

Before submitting phase completion evidence, retrieve the exact evidence contract
with `flow evidence-template <workflowId> <phaseId>`. Write the evidence JSON file
conforming to the template — every field in the template must be present,
including workflow ID, workflow revision, and phase ID. Store evidence in the
workflow-owned artifact location from `artifactPath` or pass that file to
`flow phase-complete --evidence-file`; do not use arbitrary `/tmp` paths across
retries. Then submit criterion evidence, Git workspace evidence, validation,
assumptions, risks, and scope deviations with `flow phase-complete` as the same
manual owner. Follow the returned gate decision; Claude must not unlock the
next phase itself.

After a phase gate passes, integrate the approved phase into the LeanRigor
integration worktree. After all required phases are integrated, run combined
validation in the integration worktree before final integrated review. On
`integration_conflict`, present the conflict-repair gate and do not resolve with
ours/theirs.

If a transition returns `revision_conflict`, reread workflow state and present
the changed situation. Never retry a rejected transition blindly. Raw lease and
lock commands are troubleshooting details, not normal user-facing output.

Final integrated review remains required after all phase gates pass and the
current integration head has passing combined validation.

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
