---
description: Show, generate, approve, or revise the active LeanRigor plan.
argument-hint: "[request or plan response]"
allowed-tools: AskUserQuestion, Bash(${CLAUDE_PLUGIN_ROOT}/bin/leanrigor *)
---

# /leanrigor:plan

Load `plugin-skills/sequential-workflow` before handling any workflow gate.
That skill is the workflow UX contract.

Invoke `${CLAUDE_PLUGIN_ROOT}/bin/leanrigor` internally.

Behaviour:

1. Discover active workflows with `flow active --json`.
2. If one active workflow exists, inspect it with `flow next --json`.
3. If no active workflow exists and `$ARGUMENTS` is a coding request, start one
   with `flow start "$ARGUMENTS" --provider auto`.
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
   `flow revise-plan <workflow-id> "<feedback>" --provider auto` internally and
   render the revised plan.

Do not create a duplicate workflow when an active relevant workflow already
exists. Do not modify implementation files from this command.

At every LeanRigor decision gate, `AskUserQuestion` is mandatory when the tool
is available. Do not render an ordinary text question first. Fall back to
numbered choices only when the tool is genuinely unavailable. Never infer
approval from conversational tone. Do not use
`ExitPlanMode` as a substitute for LeanRigor approval.

$ARGUMENTS
