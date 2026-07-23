---
description: Show or revise the current persisted LeanRigor sequential plan.
argument-hint: "[request or plan feedback]"
---

# /leanrigor-plan

Use:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/leanrigor" flow status
```

If no workflow exists and `$ARGUMENTS` is a coding request, start one:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/leanrigor" flow start "$ARGUMENTS" --provider auto
```

Respect pending clarification and approach gates. If a plan already exists and
the user gives feedback, run:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/leanrigor" flow revise-plan <workflow-id> "$ARGUMENTS"
```

Present the persisted phased plan and stop before implementation until explicit
approval.

$ARGUMENTS
