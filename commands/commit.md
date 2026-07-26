---
description: Show the persisted LeanRigor commit proposal without committing.
argument-hint: "[workflow-id]"
allowed-tools: AskUserQuestion, Bash(${CLAUDE_PLUGIN_ROOT}/bin/leanrigor *)
---

# /leanrigor:commit

Load `plugin-skills/sequential-workflow` before handling any workflow gate.
That skill is the workflow UX contract.

Invoke `${CLAUDE_PLUGIN_ROOT}/bin/leanrigor` internally.

Behaviour:

1. Inspect the active or supplied workflow with `flow next --json`.
2. If the workflow is not at `Commit proposal`, explain the current gate and
   next action instead of creating another workflow.
3. When a commit proposal exists, read it internally and render grouped commit
   messages, files, and rationale.
4. Clearly state that no commit or push has occurred.
5. Use `AskUserQuestion` for commit-proposal actions when available. Do not
   render an ordinary text question first. Ask for explicit user direction
   before any git action. Never push.

Do not print raw LeanRigor CLI syntax unless troubleshooting or explicitly
requested.

At every LeanRigor decision gate, `AskUserQuestion` is mandatory when the tool
is available. Do not render an ordinary text question first. Fall back to
numbered choices only when the tool is genuinely unavailable. Never infer
approval from conversational tone. Do not use
`ExitPlanMode` as a substitute for LeanRigor approval.

$ARGUMENTS
