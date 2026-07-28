---
description: Show concise human-readable LeanRigor workflow status.
argument-hint: "[workflow-id]"
allowed-tools: AskUserQuestion, Bash(${CLAUDE_PLUGIN_ROOT}/bin/leanrigor *)
---

# /leanrigor:status

Load `plugin-skills/sequential-workflow` before handling any workflow gate.
That skill is the workflow UX contract.

Invoke `${CLAUDE_PLUGIN_ROOT}/bin/leanrigor` internally.

Behaviour:

1. If a workflow ID is supplied, inspect it with `flow next <id> --json`.
2. Otherwise discover the active workflow with `flow active --json`.
3. If multiple active workflows exist, show ID, request, state, mode, and
   updated time in `AskUserQuestion` option descriptions when available. Do not
   render an ordinary text question first.
4. Render the normalized envelope `status` and exact `decision` when present.
   For phase evidence, use `flow phase-result <workflow-id> <phase-id> --json`
   and keep provider completion, completion-gate acceptance, and integration
   distinct.

Do not print raw JSON or shell commands in normal status output. Show underlying
commands only in troubleshooting mode or when explicitly requested.

At every LeanRigor decision gate, `AskUserQuestion` is mandatory when the tool
is available. Do not render an ordinary text question first. Fall back to
numbered choices only when the tool is genuinely unavailable. Never infer
approval from conversational tone. Do not use
`ExitPlanMode` as a substitute for LeanRigor approval.

$ARGUMENTS
