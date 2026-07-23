---
name: leanrigor
description: Start or resume a persisted LeanRigor workflow for a coding request.
---

# /leanrigor

Use the plugin-owned runtime:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/leanrigor"
```

If `$ARGUMENTS` is present, run:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/leanrigor" flow start "$ARGUMENTS" --provider auto
```

If `$ARGUMENTS` is empty, run:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/leanrigor" flow status
```

Present the pending user action from state. Stop at clarification, approach, and
plan approval gates until the user explicitly approves. In execution, work only
on the active phase, record phase completion, record validation evidence, record
final review, and show the commit proposal after review passes.

Never run `git commit` or `git push`. Marketplace mode must not create a
repository-local `.claude/` directory.

$ARGUMENTS
