---
name: leanrigor-commit
description: Show the LeanRigor commit proposal without committing.
---

# /leanrigor-commit

Confirm the workflow is in `awaiting_commit_approval`:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/leanrigor" flow status $ARGUMENTS
```

Then show:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/leanrigor" flow commit-plan <workflow-id>
```

Present proposed commit messages, file groups, rationale, and exact commands.
Never run `git commit` or `git push`.

$ARGUMENTS
