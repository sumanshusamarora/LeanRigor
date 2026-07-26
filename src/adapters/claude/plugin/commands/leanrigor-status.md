---
description: Report concise human-readable LeanRigor workflow status.
argument-hint: "[workflow-id]"
allowed-tools: AskUserQuestion, Bash(leanrigor *)
---

<!-- generated_by: leanrigor | asset_version: 6 -->
# /leanrigor-status

Report concise human-readable LeanRigor workflow status.

Read `.claude/leanrigor/sequential-workflow.md` first and follow its
AskUserQuestion selector contract when a workflow selection or decision gate is
present.

## Behaviour

1. Use `leanrigor flow active --json` and `leanrigor flow next --json`
   internally.
2. If multiple active workflows exist, show ID, request, state, mode, and
   updated time, then ask the user to choose.
3. Render workflow ID, request, mode, current state, current phase, pending
   decision, completion-gate status, repair attempts, blockers, and next action.

Do not default to raw JSON or shell commands. Show underlying commands only in
troubleshooting mode or when explicitly requested.

$ARGUMENTS
