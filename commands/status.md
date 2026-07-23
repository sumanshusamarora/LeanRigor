---
description: Report the current repository-local LeanRigor workflow state.
argument-hint: "[workflow-id]"
---

# /leanrigor:status

Run:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/leanrigor" flow status $ARGUMENTS
```

Report lifecycle state, mode, pending user action, current phase objective,
completion-gate status, criteria progress, validation status, repair attempts,
scope deviations, blockers or pending-review reason, review state, and next
valid command. State is repository-local under `.leanrigor/`.

$ARGUMENTS
