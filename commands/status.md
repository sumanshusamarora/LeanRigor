---
description: Show concise human-readable LeanRigor workflow status.
argument-hint: "[workflow-id]"
---

# /leanrigor:status

Use `plugin-skills/sequential-workflow` as the workflow UX contract.

Invoke `${CLAUDE_PLUGIN_ROOT}/bin/leanrigor` internally.

Behaviour:

1. If a workflow ID is supplied, inspect it with `flow next <id> --json`.
2. Otherwise discover the active workflow with `flow active --json`.
3. If multiple active workflows exist, show ID, request, state, mode, and
   updated time, then ask the user to choose.
4. Render a concise status report: workflow ID, request, mode, state, current
   phase, pending decision, completion-gate status, repair attempts, blockers,
   and next action.

Do not print raw JSON or shell commands in normal status output. Show underlying
commands only in troubleshooting mode or when explicitly requested.

$ARGUMENTS
