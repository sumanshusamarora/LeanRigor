---
description: Show, generate, approve, or revise the active LeanRigor plan.
argument-hint: "[request or plan response]"
---

# /leanrigor:plan

Use `plugin-skills/sequential-workflow` as the workflow UX contract.

Invoke `${CLAUDE_PLUGIN_ROOT}/bin/leanrigor` internally.

Behaviour:

1. Discover active workflows with `flow active --json`.
2. If one active workflow exists, inspect it with `flow next --json`.
3. If no active workflow exists and `$ARGUMENTS` is a coding request, start one.
4. If multiple active workflows exist, present the selection and ask which plan
   to inspect.
5. If approach approval is pending, show `Approach approval`; when the user
   approves, invoke approval internally and immediately render the generated
   `Plan approval`.
6. If a plan exists, show the persisted phases and validation expectations.
7. If the user gives revision feedback, invoke plan revision internally and
   render the revised plan.

Do not create a duplicate workflow when an active relevant workflow already
exists. Do not modify implementation files from this command.

$ARGUMENTS
