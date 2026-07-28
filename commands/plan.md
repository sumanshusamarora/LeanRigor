---
description: Show, generate, approve, or revise the active LeanRigor plan.
argument-hint: "[request or plan response]"
allowed-tools: AskUserQuestion, Bash(${CLAUDE_PLUGIN_ROOT}/bin/leanrigor *)
---

# /leanrigor:plan

Load `plugin-skills/sequential-workflow` before handling any workflow gate.
That skill is the workflow UX contract.

Invoke `${CLAUDE_PLUGIN_ROOT}/bin/leanrigor` internally.
Write user-provided request and feedback text through a tool-native file
operation and pass the matching `--*-file` option. Never interpolate user text
into a Bash command.

Behaviour:

1. Discover active workflows with `flow active --json`.
2. If one active workflow exists, inspect it with `flow next --json`.
3. If no active workflow exists and `$ARGUMENTS` is a coding request, start one
   with `flow start --request-file <request-file> --provider auto`, then inspect the returned
   `next` object when present or immediately read `flow next --json` when it is
   absent. If `next.approvalActions` exists, call `AskUserQuestion` in the same
   assistant turn before replying.
4. If multiple active workflows exist, use `AskUserQuestion` for the workflow
   selector when available. Do not render an ordinary text question first.
5. If approach approval is pending, show `Approach approval`; when the user
   approves through `AskUserQuestion` or an explicit fallback response, invoke
   `flow approve-approach <workflow-id> --provider auto` internally and
   immediately render the generated `Plan approval`. Do not use
   `--provider deterministic` unless the user explicitly asks for deterministic
   planning.
6. If a plan exists, show the persisted phases and validation expectations.
7. If the user gives revision feedback, invoke
   `flow revise-plan <workflow-id> --feedback-file <feedback-file> --provider auto` internally and
   render the revised plan.
8. Workflow Plan approval authorizes only the plan. Immediately read `flow next
   --json` and render the detailed Phase Execution Brief produced by bounded
   read-only inspection. Wait for approval of its exact revision. For phase
   brief feedback, use `flow phase-brief <workflow-id> <phase-id>
   --feedback-file <feedback-file>` and render the replacement revision; do not
   carry prior approval forward.

Do not create a duplicate workflow when an active relevant workflow already
exists. Do not modify implementation files from this command.

At every LeanRigor decision gate, `AskUserQuestion` is mandatory when the tool
is available. Do not render an ordinary text question first. Fall back to
numbered choices only when the tool is genuinely unavailable. Never infer
approval from conversational tone. Do not use
`ExitPlanMode` as a substitute for LeanRigor approval.
Use the selector input shape `questions[0].question`, `questions[0].header`,
`questions[0].options`, and `questions[0].multiSelect = false`, with option
labels and descriptions copied from persisted `approvalActions` in order.

$ARGUMENTS
