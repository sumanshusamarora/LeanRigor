---
description: Show or perform the valid LeanRigor review step.
argument-hint: "[workflow-id or review response]"
allowed-tools: AskUserQuestion, Bash(leanrigor *)
---

<!-- generated_by: leanrigor | asset_version: 7 -->
# /leanrigor-review

Show or perform the valid LeanRigor review step.

Read `.claude/leanrigor/sequential-workflow.md` first and follow its
AskUserQuestion selector contract at every decision gate.

## Behaviour

1. Use `leanrigor flow next --json` internally for the active or supplied
   workflow.
2. If a phase gate needs attention, read `leanrigor flow phase-result
   <workflow-id> <phase-id> --json` and render provider completion,
   identity/scope checks, completion-gate acceptance, and integration
   separately with the required recovery action.
3. If all phases are accepted and integrated and final review is pending, use
   persisted integrated evidence and record the configured review result.
   Do not inspect phase worktrees in the normal path.
4. If a commit proposal already exists, show `Commit proposal`; do not create a
   duplicate review workflow.

Do not silently repair during review. Do not commit or push. Show raw commands
only for troubleshooting or explicit user request.

$ARGUMENTS
