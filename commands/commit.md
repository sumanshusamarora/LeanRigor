---
description: Show the persisted LeanRigor commit proposal without committing.
argument-hint: "[workflow-id]"
---

# /leanrigor:commit

Use `plugin-skills/sequential-workflow` as the workflow UX contract.

Invoke `${CLAUDE_PLUGIN_ROOT}/bin/leanrigor` internally.

Behaviour:

1. Inspect the active or supplied workflow with `flow next --json`.
2. If the workflow is not at `Commit proposal`, explain the current gate and
   next action instead of creating another workflow.
3. When a commit proposal exists, read it internally and render grouped commit
   messages, files, and rationale.
4. Clearly state that no commit or push has occurred.
5. Ask for explicit user direction before any git action. Never push.

Do not print raw LeanRigor CLI syntax unless troubleshooting or explicitly
requested.

$ARGUMENTS
