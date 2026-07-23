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

Phase lifecycle during `executing`:

`active -> targeted validation -> completion gate -> completed | needs_repair | needs_review | needs_replan | blocked`

Phase rules:

- Keep phases as small functional outcomes with one objective, a deliverable,
  acceptance criteria, bounded expected areas, validation expectations, and
  meaningful dependencies.
- Work only on the active phase.
- Run declared validation or explicitly record skipped validation with a reason.
- Submit concise criterion evidence, changed files, scope deviations,
  assumptions, and remaining risks through `flow phase-complete`.
- Follow the returned gate decision. Do not mark a phase done because Claude
  believes it is done, and do not unlock the next phase yourself.
- Use `flow repair` only for bounded repairs requested by the gate.
- Escalate incomplete, uncertain, blocked, or out-of-scope work instead of
  summarizing it as successful.
