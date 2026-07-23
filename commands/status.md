---
description: Report the current repository-local LeanRigor workflow state.
argument-hint: "[workflow-id]"
---

# /leanrigor:status

Run:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/leanrigor" flow status $ARGUMENTS
```

Report lifecycle state, mode, pending user action, phase progress, validation,
review, blockers, and next valid commands. State is repository-local under
`.leanrigor/`.

$ARGUMENTS
