---
description: Start or resume a persisted LeanRigor workflow for a coding request.
argument-hint: "[coding request]"
---

# /leanrigor

Use the plugin-owned LeanRigor runtime:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/leanrigor"
```

Behaviour:

1. If `$ARGUMENTS` is present, run:
   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/leanrigor" flow start "$ARGUMENTS" --provider auto
   ```
2. If `$ARGUMENTS` is empty, run:
   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/leanrigor" flow status
   ```
3. Present the pending user action from state.
4. Ask exactly one persisted blocking clarification question when required.
5. Stop at approach and plan approval gates until the user explicitly approves.
6. During execution, work only on the active phase, then record changed files,
   commands, validation evidence, and review status through `flow`.
7. Show the commit proposal after review passes. Never run `git commit` or
   `git push`.

Marketplace mode must not create a repository-local `.claude/` directory.

$ARGUMENTS
