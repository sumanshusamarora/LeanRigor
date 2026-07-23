---
description: Show or perform the valid LeanRigor phase/final review step.
argument-hint: "[workflow-id or review response]"
---

# /leanrigor:review

Use `plugin-skills/sequential-workflow` as the workflow UX contract.

Invoke `${CLAUDE_PLUGIN_ROOT}/bin/leanrigor` internally.

Behaviour:

1. Inspect the active or supplied workflow with `flow next --json`.
2. If a phase gate is pending, show `Phase completion review`, explain failed
   or uncertain criteria, validation state, deviations, and repair/replan needs.
3. If all phases are complete and the workflow is validating/reviewing, perform
   the final integrated review for the current diff and record the result
   internally.
4. If a final review already produced a commit proposal, show `Commit proposal`
   and do not create a duplicate review workflow.

Do not silently repair during review. Do not commit or push. Show raw commands
only if automatic invocation fails or the user asks for them.

$ARGUMENTS
