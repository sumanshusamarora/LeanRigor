---
description: Start or resume the conversational LeanRigor workflow.
argument-hint: "[coding request or response]"
allowed-tools: AskUserQuestion, Bash(leanrigor *)
---

<!-- generated_by: leanrigor | asset_version: 6 -->
# /leanrigor

Primary conversational LeanRigor workflow command.

Write user-provided request, answer, and feedback text through a tool-native
file operation and pass the matching `--*-file` option. Never interpolate user
text into a Bash command.

Read `.claude/leanrigor/sequential-workflow.md` first and follow its
AskUserQuestion selector contract at every decision gate.

## Behaviour

1. Use `leanrigor flow active --json` and `leanrigor flow next --json`
   internally to find the current gate.
2. If `$ARGUMENTS` is a new request and no active workflow exists, start the
   workflow internally with `leanrigor flow start --request-file <request-file> --provider auto`,
   then inspect the returned `next` object when present or immediately read
   `leanrigor flow next --json` when it is absent. If `next.approvalActions`
   exists, call `AskUserQuestion` in the same assistant turn before replying.
   Do not end the turn from raw `flow start` JSON or from a summary-only triage
   report. Do not use `--provider deterministic` unless the user explicitly asks
   for deterministic triage. LeanRigor lazily creates `.leanrigor/` and its
   `.gitignore` on first use — no explicit init is needed.
3. If one active workflow exists, resume it and interpret `$ARGUMENTS` as a
   natural-language response when present.
4. If multiple active workflows exist, present the selection and ask the user
   to choose.
5. Render distinct `Approach approval`, `Plan approval`, `Phase completion
   review`, `Final integrated review`, and `Commit proposal` states.
   The post-triage approach selector options are exactly `Approve approach and
   create plan`, `Revise approach`, `View workflow details`, and `Cancel
   workflow`; state that no implementation has started.
   At `awaiting_clarification`, render `Question: <persisted question>`
   verbatim and `Why this matters: <persisted reason>` when present. Do not
   replace the question with the reason or leave a blank prompt after "before
   continuing".
6. After user approval, invoke the transition internally and continue to the
   next meaningful gate before replying. If the user changes constraints while
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
8. When execution providers/workspaces are configured, use the coordinator
   execution path (`flow execute-next --provider auto` /
   `flow execution-poll --provider auto`) and render only persisted
   coordinator gates. Do not use `--provider scripted` unless the user explicitly
   asks for scripted/deterministic execution. Do not implement phase edits in
   the original working tree. If provider dispatch fails, present explicit
   choices: retry the configured provider, use another available provider,
   switch to manual execution, or cancel. Manual execution requires explicit
   user selection.
9. Never compensate for an unavailable workflow transition by narrating that the
   workflow is complete. Report the persisted state and the exact blocker.

Normal output must not ask users to copy-paste LeanRigor CLI commands. Show
commands only in troubleshooting fallback or when explicitly requested.
Approval selectors must use the `questions[0].question`,
`questions[0].header`, `questions[0].options`, and
`questions[0].multiSelect = false` AskUserQuestion shape, with option labels
and descriptions copied from persisted `approvalActions` in order.

$ARGUMENTS
