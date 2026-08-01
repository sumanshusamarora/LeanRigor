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

Write user-provided request, answer, and feedback text through a tool-native
file operation and pass its path with `--request-file`, `--answer-file`, or
`--feedback-file`. Never interpolate user text into a Bash command.

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

`triage summary -> approach approval -> Workflow Plan approval -> Phase Execution Brief approval -> workspace preparation -> provider dispatch -> provider result -> completion gate -> integration -> next Phase Execution Brief or final integrated review -> final completion`

Use `flow active --json` to discover repository workflows and `flow next
--json` to read the next gate. Use transition commands internally after user
approval. Do not show shell commands during normal use.

Lifecycle terms must stay distinct:

- `Approach approval`
- `Workflow Plan approval`
- `Phase Execution Brief approval`
- `Workspace prepared`
- `Provider dispatched`
- `Provider completed`
- `Completion gate passed`
- `Phase accepted`
- `Phase integrated`
- `Final integrated validation passed`
- `Final integrated review`
- `User-approved final completion`

Never collapse these into `Phase complete and approved`.

## Active Workflow Selection

- One active workflow: resume it.
- No active workflow: start only when the user supplied a request. Invoke
  `flow start --request-file <request-file> --provider auto` so automatic triage can call Claude
  when available. Refresh with `flow next --json` after start. Do not end the
  turn from raw `flow start` JSON. Use `--provider deterministic` only when the user
  explicitly requests deterministic triage.
- Multiple active workflows: use `AskUserQuestion` to let the user choose among
  them (header: "Workflow"). Show ID, request, state, mode, and updated time in
  each option description. Do not render an ordinary text question first. Fall
  back to a numbered list only when `AskUserQuestion` is genuinely unavailable.
- Completed and cancelled workflows are not selected by default.
- Never attach a new request to an unrelated active workflow silently.

## Decision Envelope

`flow next --json`, execution commands, polling, recovery, completion, and
integration use one normalized persisted envelope. `status` is authoritative.
When `decision` exists, it contains a stable ID, exact revision identity,
question, and ordered options. `nextOperation.automaticallyPermitted`
distinguishes an automatic operation from a user decision.

After every state-changing command: read its envelope, refresh with `flow next
--json`, render persisted status or decision, and invoke no additional
operation unless `automaticallyPermitted` is true.

When an envelope returns `decision`, call `AskUserQuestion` in the same
assistant turn. This is mandatory whenever the tool is available. Use
`decision.question` verbatim and copy every presented `decision.options` label
and description in order. The controller limits and prioritizes this list to
at most four options for `AskUserQuestion`. Match the selected option by persisted `intent` and run
only its persisted command. Never infer, cache, or reconstruct a question.
Never call `AskUserQuestion` without a current `decision`.

Keep the two presentation surfaces separate throughout the workflow. `flow next
--json` always includes `presentation.markdown`; render it verbatim as normal
assistant Markdown before calling `AskUserQuestion`. The selector question must be exactly
`decision.question`; never copy `summary`, `status`, or
`presentation.markdown` into it. The selector is for a compact choice, not for
displaying an approval artifact.

Use this `AskUserQuestion` input shape for approval selectors:

```json
{
  "questions": [
    {
      "question": "<decision.question>",
      "header": "Approach",
      "options": [
        { "label": "<decision.options[0].label>", "description": "<decision.options[0].description>" }
      ],
      "multiSelect": false
    }
  ]
}
```

Replace `header` with the current gate header and include every presented
option in order.

Fall back to a numbered list of explicit choices only when `AskUserQuestion` is
genuinely unavailable in the current Claude Code environment. Each action has a
deterministic `command` which remains the authority for the transition. Do not infer approval from conversational tone — the user must select an action or type an explicit response.
Do not use `ExitPlanMode` as a substitute for LeanRigor approval.

For the post-triage approach gate, render a compact summary before the selector.
`flow next --json` returns both the decision envelope and the rich `summary`
field in a single call. Render `summary` first, then call `AskUserQuestion`
with `decisionEnvelope.decision.question` and `.options`:

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

Then call `AskUserQuestion` in the same turn with one concise question and
these options in order:

1. `Approve approach and create plan` — Continue to model-assisted planning
   using the approved triage constraints.
2. `Add constraints to workflow strategy` — Let me provide changes or additional constraints before
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
Provisional recommendation: <Fast|Standard|Rigorous>
Final mode: pending clarification

Triage clarification

Question: <next.summary.question or clarification.question>

Why this matters: <next.summary.reason or clarification.reason>
```

Do not replace the question with the reason. Do not end with a blank prompt
after "before continuing". If `AskUserQuestion` is available, ask exactly the
persisted question there as well; otherwise ask for a free-form answer in plain
language. The answer must be recorded through `flow answer <workflow-id>
--answer-file <answer-file> --provider auto`.

Clarification is already filtered by LeanRigor core. Do not invent additional
triage questions from repository scope or planning uncertainty; those are handled
by targeted inspection or planning. When `next.summary.modeStatus` is
`provisional`, do not present the mode as final.

### Free-form fallback

The following typed responses remain supported as a fallback:

- `approve`, `looks good`, `continue` at `awaiting_approach_approval`: approve approach with `flow approve-approach <workflow-id> --provider auto`, adding `--add-constraint`, `--remove-constraint`, or `--override-constraint "<old> => <new>"` for any user-supplied constraint changes, then immediately render the generated plan for plan approval. Use deterministic planning only when explicitly requested or when the model provider falls back with a recorded reason.
- `approve`, `looks good`, `continue` at `awaiting_plan_approval`: approve only the Workflow Plan, then call `flow next --json` and render the persisted Phase Execution Brief approval decision. Do not invoke coordinator or manual execution until the user approves the exact brief revision.
- `revise ...` at a Phase Execution Brief gate: persist the feedback with
  `flow phase-brief <workflow-id> <phase-id> --feedback-file
  <feedback-file>`, then render the new brief and its new pending decision.
  Never reuse approval from the superseded revision.
- `show status` during execution: render the persisted `recommendedNextPhase`
  as the primary action. Show `otherDependencyReadyPhases` separately as
  available only after explicit user choice. Do not replace Phase 2 with Phase
  4 merely because both are dependency-ready.
- `revise ...` at `awaiting_approach_approval`: record the feedback with `flow revise-approach <workflow-id> --feedback-file <feedback-file>`, rerender the updated workflow strategy summary, and ask for approval again. Do not start planning. This action records additional constraints; it does not regenerate the approach.
- `revise ...` at `awaiting_plan_approval`: use `flow revise-plan <workflow-id> --feedback-file <feedback-file> --provider auto` unless deterministic planning was explicitly requested.
- `reject because ...`: reject the approach with the supplied reason.
- `cancel`: cancel the workflow after confirming intent when destructive to progress.
- `show plan` / `show status`: render persisted plan/status.
- `repair it` at `needs_repair`: start the bounded repair requested by the gate.
- `continue` at `needs_repair`, `needs_review`, or `needs_replan`: do not bypass the gate; explain the required repair, review, or replan.

Ask one concise clarification for ambiguous responses.

## Phase And Review Rules

Before phase approval, render the persisted Phase Execution Brief from `flow
next --json`. Render `presentation.markdown` verbatim in a normal assistant
message before the selector. The response also includes both
`decisionEnvelope` (question and options for `AskUserQuestion`) and `summary`
(the rich brief details). Show the
objective, concrete deliverable, inspected current behaviour, implementation
approach, read/write paths, relevant files and symbols, acceptance criteria,
test obligations, validation, dependencies, assumptions, exclusions, risks,
changes from the approved Workflow Plan, and inspection provenance from
`summary`. Use the returned decision options in order from
`decisionEnvelope.decision.options`. Do not summarise the Workflow Plan phase as
though it were the detailed brief.

Brief generation is a read-only planning operation. It must not initialize a
workspace, dispatch the implementation provider, approve a phase, or expand
write scope. If LeanRigor reports `Phase Execution Brief unavailable`, present
its persisted retry, plan-boundary revision, diagnostics, and cancel actions.
Do not invent a placeholder brief or proceed to execution.

The coordinator is the normal execution path. Invoke `flow execute-next
--provider auto` or `flow execution-poll --provider auto` only after the exact
brief is approved and the refreshed envelope permits it. Use the scripted
provider only when explicitly requested. Claude must not implement phase edits
itself or edit the original working tree. Present only persisted recovery
decisions; never silently switch provider or execution mode, and never fall
back to main-session implementation. Manual execution requires an explicit
persisted choice and explicit user selection.

Never claim a
phase is complete from visible file changes alone; only persisted LeanRigor
state and gates decide completion. Never compensate for an unavailable workflow
transition by narrating that the workflow is complete. Report the persisted
state and the exact blocker.

During execution, each phase must pass:

`planned -> ready -> leased/running -> targeted validation -> completion gate -> completed | needs_repair | needs_review | needs_replan | blocked`

Use `flow phase-result <workflow-id> <phase-id> --json` to render provider
identity, changed files, scope checking, validation evidence, completion gate,
integration, risks, blockers, and next safe actions. Do not run `cd
<phase-worktree> && git diff`, inspect the phase worktree, or request generic
Bash trust in the normal path. Manual inspection is allowed only when the user
explicitly requests it or persisted evidence is incomplete and a dedicated
decision states the reason.

Coordinator-owned leases are completed by the coordinator only. Do not infer,
probe, or reuse a provider lease owner string from status output to run
`phase-complete` directly. If the coordinator cannot collect a provider result,
present the recorded provider failure and the allowed recovery choices.

After a phase gate passes, integrate the approved phase into the LeanRigor
integration worktree. After all required phases are integrated, run combined
validation in the integration worktree before final integrated review. On
`integration_conflict`, present the conflict-repair gate and do not resolve with
ours/theirs.

After Phase N is accepted and integrated, refresh. For phase-by-phase
workflows, render the freshly persisted Phase N+1 brief decision and its exact
options; never show a generic `Continue`. For workflow-authorized Standard
flows, show a concise preflight status and continue only while the envelope
marks the next operation automatically permitted.

If a transition returns `revision_conflict`, reread workflow state and present
the changed situation. Never retry a rejected transition blindly. Raw lease and
lock commands are troubleshooting details, not normal user-facing output.

Final integrated review remains required after all phase gates pass and the
current integration head has passing combined validation.

## Presentation

Render human summaries first. `flow next --json` returns both `decisionEnvelope`
and the rich `summary` field, plus a deterministic `presentation.markdown`
artifact for every workflow state. Always render that artifact as normal
assistant Markdown before a decision selector. Never put that artifact inside
`AskUserQuestion`: the selector receives only `decision.question` and its
options.

Render at minimum:

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
