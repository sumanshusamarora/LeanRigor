---
description: Start or resume a persisted LeanRigor workflow for a coding request.
argument-hint: "[coding request]"
---

# /leanrigor:start

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
6. During execution, work only on the active phase. Phases are small functional
   outcomes with criteria, expected areas, and validation expectations.
7. Run or explicitly skip declared validation, record the result, then submit
   structured criterion evidence with `flow phase-complete --evidence-file`.
   Follow the returned gate decision; do not unlock the next phase yourself.
8. Report unexpected scope changes, assumptions, skipped validation, and
   remaining risks. Do not hide incomplete work under a successful summary.
9. Show the commit proposal after per-phase gates and final review pass. Never run `git commit` or
   `git push`.

Marketplace mode must not create a repository-local `.claude/` directory.

$ARGUMENTS
