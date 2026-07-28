---
description: Start or resume the conversational LeanRigor workflow.
argument-hint: "[coding request or response]"
allowed-tools: AskUserQuestion, Bash(leanrigor *)
---

<!-- generated_by: leanrigor | asset_version: 7 -->
# /leanrigor

Primary conversational LeanRigor workflow command.

Write user-provided request, answer, and feedback text through a tool-native
file operation and pass the matching `--*-file` option. Never interpolate user
text into a Bash command.

Read `.claude/leanrigor/sequential-workflow.md` first and follow its
AskUserQuestion selector contract at every decision gate.

## Behaviour

1. Use `leanrigor flow active --json` and the normalized
   `leanrigor flow next --json` decision envelope as the persisted source of
   truth.
2. If `$ARGUMENTS` is a new request and no active workflow exists, start the
   workflow internally with `leanrigor flow start --request-file <request-file> --provider auto`,
   then refresh with `leanrigor flow next --json`. If `decision` exists, call
   `AskUserQuestion` in the same assistant turn before replying.
   Do not end the turn from raw `flow start` JSON or from a summary-only triage
   report. Do not use `--provider deterministic` unless the user explicitly asks
   for deterministic triage. LeanRigor lazily creates `.leanrigor/` and its
   `.gitignore` on first use — no explicit init is needed.
3. If one active workflow exists, resume it and interpret `$ARGUMENTS` as a
   natural-language response when present.
4. If multiple active workflows exist, present the selection and ask the user
   to choose.
5. Render the envelope's `status` exactly. Keep Workflow Plan approval, Phase
   Execution Brief approval, workspace preparation, provider dispatch,
   provider completion, completion-gate acceptance, integration, final
   integrated validation, and user-approved final completion distinct.
   The post-triage approach selector options are exactly `Approve approach and
   create plan`, `Revise approach`, `View workflow details`, and `Cancel
   workflow`; state that no implementation has started.
   At `awaiting_clarification`, render `Question: <persisted question>`
   verbatim and `Why this matters: <persisted reason>` when present. Do not
   replace the question with the reason or leave a blank prompt after "before
   continuing".
6. After every state-changing transition, refresh with `flow next --json`
   before deciding what to render or execute. Render the returned persisted
   status or decision. Invoke another operation only when
   `nextOperation.automaticallyPermitted` is true. If the user changes constraints while
   approving the approach, convert those changes to structured flags such as
   `--add-constraint`, `--remove-constraint`, or `--override-constraint`; do not
   keep them only in conversation. For approach approval, use
   `leanrigor flow approve-approach <workflow-id> --provider auto ...` so plan
   generation can call Claude when available. Do not use
   `--provider deterministic` unless the user explicitly asks for deterministic
   planning.
7. For plan revision feedback, use
   `leanrigor flow revise-plan <workflow-id> --feedback-file <feedback-file> --provider auto`
   unless deterministic planning was explicitly requested.
8. After Workflow Plan approval, refresh, render the persisted
   Phase Execution Brief decision, and wait for exact brief approval. When
   execution providers/workspaces are configured, only then use the coordinator
   execution path (`flow execute-next --provider auto` /
   `flow execution-poll --provider auto`) and render only persisted
   coordinator gates. Read completion evidence with
   `flow phase-result <workflow-id> <phase-id> --json`; do not inspect phase
   worktrees in the normal path. Do not use `--provider scripted` unless the user explicitly
   asks for scripted/deterministic execution. Do not implement phase edits in
   the original working tree. Never switch to manual execution unless a
   persisted decision explicitly offers it and the user selects it. Distinguish dependency-ready from dispatch-ready and render
   exact dispatch blockers. For a workspace bootstrap decision, show the exact
   command and risk summary and run only its persisted approval action; never
   improvise dependency installation. Treat stale/mismatched provider results
   or unexpected write scope as persisted review/replan gates.
9. Use `decision.question` and every `decision.options` entry verbatim and in
   order. Match the selected option by `intent` and run only its persisted
   command. Never invent, cache, or reconstruct question state. Never call
   `AskUserQuestion` when `decision` is absent, and never report "No new
   question to present" while a persisted decision exists.
10. Never compensate for an unavailable workflow transition by narrating that the
   workflow is complete. Report the persisted state and the exact blocker.

Normal output must not ask users to copy-paste LeanRigor CLI commands. Show
commands only in troubleshooting fallback or when explicitly requested.
Approval selectors must use the envelope's `decision.question` for
`questions[0].question`,
`questions[0].header`, `questions[0].options`, and
`questions[0].multiSelect = false` AskUserQuestion shape, with option labels
and descriptions copied from persisted `decision.options` in order.

$ARGUMENTS
