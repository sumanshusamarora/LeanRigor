---
description: Show, generate, approve, or revise the persisted LeanRigor plan.
argument-hint: "[request or plan response]"
allowed-tools: AskUserQuestion, Bash(leanrigor *)
---

<!-- generated_by: leanrigor | asset_version: 7 -->
# /leanrigor-plan

Show, generate, approve, or revise the persisted LeanRigor plan.

Read `.claude/leanrigor/sequential-workflow.md` first and follow its
AskUserQuestion selector contract at every decision gate.
Write user-provided request and feedback text through a tool-native file
operation and pass the matching `--*-file` option. Never interpolate user text
into a Bash command.

## Behaviour

1. Use `leanrigor flow active --json` and `leanrigor flow next --json`
   internally.
2. Show an existing plan when one exists; do not create a duplicate workflow.
3. If approach approval is pending, render `Approach approval`; after approval,
   invoke `leanrigor flow approve-approach <workflow-id> --provider auto`
   internally and immediately render `Plan approval`. Use deterministic
   planning only when explicitly requested or when model planning falls back with
   a recorded reason.
4. If no active workflow exists and `$ARGUMENTS` is a request, start one with
   `leanrigor flow start --request-file <request-file> --provider auto`, then refresh with
   `leanrigor flow next --json`. If the normalized `decision` exists, call
   `AskUserQuestion` in the same assistant turn before replying.
5. If the user gives revision feedback, revise the persisted plan internally
   with `leanrigor flow revise-plan <workflow-id> --feedback-file <feedback-file> --provider auto`
   and render the revised phases.
6. If `decision.type` is `planning-fallback-review`, render persisted
   `planning.attemptRecords`, warnings, diagnostics, and fallback reason. Keep
   invocation failure distinct from validation failure; when validation is
   `not-attempted`, do not claim a candidate plan had structural or semantic
   defects. Never reconstruct rejected plan contents. Offer only the persisted
   retry-planning, revise-plan, view-details, and cancel choices, and invoke
   `leanrigor flow retry-plan <workflow-id> --provider auto` only when its
   persisted option is selected. Never offer plan approval at this gate.

Do not modify implementation files from this command. Do not show raw CLI
commands except for troubleshooting or explicit user request.
Approval selectors must use the `questions[0].question`,
`questions[0].header`, `questions[0].options`, and
`questions[0].multiSelect = false` AskUserQuestion shape, with option labels
and descriptions copied from persisted `decision.options` in order. Use
`decision.question` verbatim. Refresh after every transition and never infer,
cache, or reconstruct the next question.

$ARGUMENTS
