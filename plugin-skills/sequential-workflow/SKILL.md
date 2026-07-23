---
name: leanrigor-sequential-workflow
description: Use when running LeanRigor's persisted sequential workflow in Claude Code.
---

LeanRigor runs as a global Claude Code plugin while keeping repository-specific
state local to the current repository.

Global plugin files live under `${CLAUDE_PLUGIN_ROOT}`. Invoke the CLI through:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/leanrigor" flow ...
```

Repository-local files:

- `.leanrigor/config.json`
- `.leanrigor/workflows/`

Do not create or modify repository `.claude/` files in marketplace mode. Do not
commit, push, create worktrees, or spawn parallel agents automatically.

Workflow:

`created -> triaging -> awaiting_clarification? -> awaiting_approach_approval? -> planning -> awaiting_plan_approval -> executing -> validating -> reviewing -> awaiting_commit_approval -> completed`

`blocked` and `cancelled` are explicit escape states.
