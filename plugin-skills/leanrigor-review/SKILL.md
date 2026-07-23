---
name: leanrigor-review
description: Record the final integrated LeanRigor review for the current diff.
---

# /leanrigor-review

Run:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/leanrigor" flow status $ARGUMENTS
```

Inspect the full diff, apply the mode's review level, then record `passed`,
`needs_repair`, `needs_replan`, or `blocked`:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/leanrigor" flow record-review <workflow-id> --status <status> --summary "<summary>"
```

Do not commit or push.

$ARGUMENTS
