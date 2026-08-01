<!-- generated_by: leanrigor | asset_version: 7 -->
# LeanRigor Conversational Workflow

Use `leanrigor flow` as the persisted source of truth. Users should respond in
plain language; Claude invokes LeanRigor transitions internally and renders
concise summaries.
Write user-provided request, answer, and feedback text through a tool-native
file operation and pass the matching `--*-file` option. Never interpolate user
text into a shell command.

Normal flow:

`triage summary -> approach approval -> Workflow Plan approval -> Phase Execution Brief approval -> workspace preparation -> provider dispatch -> provider result -> completion gate -> integration -> next Phase Execution Brief or final integrated review -> final completion`

Use `leanrigor flow active --json` to discover active workflows and
`leanrigor flow next --json` to inspect the current gate. Do not show shell
commands during normal use.
LeanRigor is parallel-ready internally, but default execution remains
sequential. Do not spawn parallel agents.

## Configuration

LeanRigor uses a layered configuration hierarchy (highest precedence first):

1. CLI flags
2. Environment variables (`LEANRIGOR_*`, `ANTHROPIC_DEFAULT_*`)
3. Private local config: `.leanrigor/config.json` (never committed)
4. Committed repository policy: `leanrigor.config.json`
5. User config: `~/.config/leanrigor/config.json`
6. Adapter-derived defaults (Claude: small → haiku, medium → sonnet, large → opus)
7. Built-in defaults

Use `/leanrigor:init` to inspect configuration, change settings, or see
effective values with provenance.

## Engineering Methodology

LeanRigor's shared methodology is installed under
`.claude/leanrigor/methodology/`. After reading the current workflow mode from
`flow next --json`, load:

- `.claude/leanrigor/methodology/core.md`
- `.claude/leanrigor/methodology/modes/<fast|standard|rigorous>.md`

Then load only the relevant methodology files for the current step:

- planning or plan revision: `.claude/leanrigor/methodology/planning.md`
- design-heavy changes: `.claude/leanrigor/methodology/design.md`
- implementation edits: `.claude/leanrigor/methodology/implementation.md`
- bugs, failures, failed repairs, or flaky behavior:
  `.claude/leanrigor/methodology/debugging.md`
- validation selection or recording: `.claude/leanrigor/methodology/testing.md`
- phase or final review: `.claude/leanrigor/methodology/review.md`
- completion evidence or success claims:
  `.claude/leanrigor/methodology/evidence.md`
- security, migration, API, data, privacy, production, infrastructure,
  concurrency, or destructive-operation risks:
  `.claude/leanrigor/methodology/safeguards.md`

Do not load every methodology file for every task. Fast mode must stay compact.

Lifecycle terms:

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

## Decision envelope contract

`flow next --json`, execution commands, polling, recovery, completion, and
integration return the same normalized persisted envelope:

- `status` is the authoritative lifecycle summary.
- `decision`, when present, contains the stable ID, exact revision identity,
  question, and ordered options.
- `nextOperation.automaticallyPermitted` distinguishes a safe automatic
  operation from a user decision.

Controller sequence after every transition:

1. Invoke one transition.
2. Read its returned envelope.
3. If state changed, refresh with `flow next --json`.
4. Render the persisted status or decision.
5. Invoke no additional operation unless `automaticallyPermitted` is true.

Never infer, cache, or reconstruct a question from conversation. Never show a
resolved or superseded decision. Never call `AskUserQuestion` without a
current `decision`.

Rules:

- One active workflow: resume it.
- No active workflow: start only when the user supplied a request. Invoke
  `leanrigor flow start --request-file <request-file> --provider auto` so automatic triage can
  call Claude when available. Render from the returned `next` object when
  present or immediately read `leanrigor flow next --json` when it is absent.
  Do not end the turn from raw `flow start` JSON. Use `--provider
  deterministic` only when the user explicitly requests deterministic triage.
- Multiple active workflows: use `AskUserQuestion` to let the user choose among them (header: "Workflow"). Show ID, request, state, mode, and updated time in each option description. Do not render an ordinary text question first. Fall back to a numbered list only when `AskUserQuestion` is genuinely unavailable.
- When an envelope returns `decision`, call `AskUserQuestion` in the same
  assistant turn. Use `decision.question` verbatim, copy every option label and
  description from `decision.options` in order, then match the selected option
  by its persisted `intent` and run its persisted command. Do not end the turn
  after a prose summary while a decision is pending. Use a short header
  (maximum 12 characters) derived from the decision type. Fall back to a
  numbered list only when `AskUserQuestion` is unavailable. Do not infer
  approval from tone and do not use `ExitPlanMode` as LeanRigor approval.
- At the post-triage approach gate, render a compact `Workflow created and triaged` summary with workflow ID, mode, assessment, key constraints, recommended approach, and `No implementation has started. Your approval is required before planning.` Then call `AskUserQuestion` in the same turn with exactly these options in order: `Approve approach and create plan`, `Add constraints to workflow strategy`, `View workflow details`, `Cancel workflow`.
- At the clarification gate (`state: awaiting_clarification`), render the persisted question explicitly and verbatim: `Question: <next.summary.question or clarification.question>`. Also render `Why this matters: <next.summary.reason or clarification.reason>` when present. If `next.summary.modeStatus` is `provisional`, label the shown mode as `Provisional recommendation` and do not present it as final. Do not invent additional triage questions from repository scope or planning uncertainty; LeanRigor core has already filtered model-requested clarification. Do not replace the question with the reason, and do not end with a blank prompt after "before continuing". If `AskUserQuestion` is available, ask exactly the persisted question there as well; otherwise ask for a free-form answer in plain language. Record the answer with `leanrigor flow answer <workflow-id> --answer-file <answer-file> --provider auto`.
- Interpret `approve`, `looks good`, and `continue` as free-form fallback responses according to the current gate.
- Approval at approach immediately generates and renders the actual phased plan
  through `leanrigor flow approve-approach <workflow-id> --provider auto`, so
  Claude-backed planning is attempted when available. If the user approves with
  constraint changes, include structured flags on that transition:
  `--add-constraint "<constraint>"`, `--remove-constraint "<constraint>"`, or
  `--override-constraint "<old> => <new>"`. Do not acknowledge constraint
  changes conversationally unless they were passed to LeanRigor. Use
  deterministic planning only when explicitly requested or when the provider
  falls back with a recorded reason.
- Approach revisions use `leanrigor flow revise-approach <workflow-id>
  --feedback-file <feedback-file>`, then rerender the approach summary without starting planning.
- Plan revisions use
  `leanrigor flow revise-plan <workflow-id> --feedback-file <feedback-file> --provider auto`
  unless deterministic planning was explicitly requested.
- A `planning-fallback-review` is not a Workflow Plan approval gate. Render
  the persisted `planning.attemptRecords`, warnings, diagnostics, and fallback
  reason before the selector. Invocation and deterministic validation are
  separate facts: if invocation failed and validation is `not-attempted`, say
  that no candidate plan was returned and do not describe structural defects,
  semantic repair, or rejected phase contents. Never invent planning history
  from the fallback plan. Copy only the persisted retry-planning, revise-plan,
  view-details, and cancel options into `AskUserQuestion`; never add plan
  approval. Run `leanrigor flow retry-plan <workflow-id> --provider auto` only
  when the persisted retry option is selected.
- At the Workflow Plan gate, render the persisted Workflow Plan contract: strategy,
  phase DAG, effective constraints, validation strategy, provider/workspace
  policy, and deterministic approval recommendation with concise reasons. For
  Standard, present the persisted Workflow Plan policy choices plus `Revise
  plan`, `View full details`, and `Cancel workflow`. For Rigorous, present
  `Approve Workflow Plan and prepare Phase 1 brief` plus revise, details, and
  cancel. Match the selected
  persisted action to its deterministic transition; never infer an approval
  from conversational tone or use ExitPlanMode.
- After Workflow Plan approval and before coordinator dispatch, refresh state
  and render the persisted Phase Execution Brief approval decision. Offer
  `Approve <phase-id>`, `Revise phase
  brief`, `View full details`, and `Cancel workflow`.
  Approval must reference the decision's exact workflow and brief revisions.
- Approval at plan derives ready phases but does not authorize Phase 1. When
  execution providers/workspaces are configured, use `execution.mode =
  coordinator` only after exact Phase 1 brief approval: invoke
  `leanrigor flow execute-next --provider auto` or
  `leanrigor flow execution-poll --provider auto`, monitor persisted execution
  records, and present only persisted gates. Use `--provider scripted` only when
  the user explicitly requests scripted/deterministic execution. Do not
  implement phase edits yourself and do not edit the original working tree.
- After exact brief approval, refresh first. Dispatch only when the refreshed
  envelope permits `execute-next`. After provider polling, render provider
  completion, identity verification, scope checking, completion-gate result,
  and integration as separate persisted facts.
- During execution status, render the persisted `recommendedNextPhase` as the
  primary action. Show `otherDependencyReadyPhases` separately and start one
  only after explicit user choice. Do not replace Phase 2 with Phase 4 merely
  because both are dependency-ready.
- Treat `dependencyReady` and `dispatchReady` as distinct. Render every
  `dispatchBlocker` and its recovery action. A workspace bootstrap decision
  must show the exact command and risk summary, then use the persisted
  `approve-bootstrap` action; do not install dependencies in the main session
  or ask the implementation provider to install them.
- Provider execution is bound to the exact approved brief and workspace
  identity. If status reports stale brief, result identity mismatch,
  unexpected write scope, or material discovery, render the persisted review
  or replan gate. Do not reinterpret provider `completed` as acceptance.
- For `execution-recovery` decisions caused by unexpected write scope, prefer
  the persisted recovery action ordering exactly as returned. When
  `accept-out-of-scope-and-continue` is present, render it explicitly as the
  simplest forward path for low/medium-risk side-effect files before discard or
  revision paths. Explain that it records the extra files as accepted scope
  drift and continues; do not replace it with a free-form request for brief
  feedback.
- If provider dispatch or recovery cannot proceed, present only the persisted
  recovery decision. Never silently switch provider or execution mode, and
  never fall back to main-session implementation.
- Coordinator-owned leases are completed by the coordinator only. Do not infer,
  probe, or reuse a provider lease owner string from status output to run
  `phase-complete` directly.
- Manual execution is outside the normal controller path. Use it only after an
  explicit persisted choice and user selection.
- `continue` must not bypass `needs_repair`, `needs_review`, or `needs_replan`.
- Ask one concise clarification for ambiguous responses.
- Present normal phase completion from
  `leanrigor flow phase-result <workflow-id> <phase-id> --json`. Do not run
  `cd <phase-worktree> && git diff`, inspect the worktree, or request generic
  Bash trust merely to advance the workflow. Manual inspection is allowed only
  when the user explicitly requests it or persisted evidence is incomplete and
  a dedicated decision states the reason.
- Never claim a phase is complete from visible file changes alone. Never
  compensate for an unavailable workflow transition by narrating that the
  workflow is complete. Report the persisted state and the exact blocker.
- After a phase is accepted, integration status must be shown explicitly.
  Generate or refresh the next brief only after integration permits it. For
  phase-by-phase workflows, render the fresh next-phase brief decision rather
  than a generic `Continue` option. For workflow-authorized Standard flows,
  show the concise preflight status and continue only while the envelope marks
  the next operation automatically permitted.
- Refresh long-running leases where practical. On `revision_conflict`, reread state and present the changed gate instead of blindly retrying.
- Final integrated review remains required after all phase gates pass.
- On `integration_conflict`, present the conflict-repair gate; do not resolve
  with ours/theirs.
- Never run user-facing `git commit`, `git push`, amend, rebase, deploy, or
  spawn parallel agents automatically. LeanRigor may create internal transfer
  commits on LeanRigor-owned branches after a phase gate passes; these are not
  the final user commit and are not pushed.

Presentation:

- Human-readable first: workflow ID, request, mode, state, current phase, gate status, criteria/validation progress, repair attempts, blockers, and next action.
- Do not print raw JSON or CLI commands unless troubleshooting or explicitly requested.

Troubleshooting fallback:

```text
I could not run the LeanRigor transition automatically.

You can retry, or run:
<exact command>

Error:
<concise error>
```
