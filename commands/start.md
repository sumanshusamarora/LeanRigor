---
description: Start or resume the conversational LeanRigor workflow.
argument-hint: "[coding request or response]"
---

# /leanrigor:start

Use `plugin-skills/sequential-workflow` as the workflow UX contract.

Invoke the plugin-owned runtime internally through
`${CLAUDE_PLUGIN_ROOT}/bin/leanrigor`.

Behaviour:

1. Read active workflow selection with `flow active --json`.
2. If `$ARGUMENTS` is a new coding request and no active workflow exists, start
   a workflow, then read `flow next --json`.
3. If one active workflow exists, resume it and interpret `$ARGUMENTS` as a
   natural-language response when present.
4. If multiple active workflows exist, show the concise selection and ask the
   user to choose. Do not guess.
5. At approval gates, render `Approach approval` or `Plan approval` with a
   concise summary. After approval, invoke the transition internally and
   continue to the next meaningful gate before responding.
6. During execution, use `execution.mode = coordinator` when execution
   providers/workspaces are configured: invoke `flow execute-next` or
   `flow execution-poll`, monitor persisted coordinator state, and present the
   returned gate. Do not edit the original working tree or implement the phase
   directly in coordinator mode.
7. Use `execution.mode = manual` only when no execution provider/workspace path
   is available. In manual mode, work only in the active phase workspace and
   record validation/completion evidence before presenting a phase gate.
8. Render the persisted final review and commit proposal conversationally. Never commit or
   push automatically.

Never compensate for an unavailable workflow transition by narrating that the
workflow is complete. Report the persisted state and the exact blocker.

Normal output must not ask the user to copy-paste LeanRigor CLI commands. Show
the exact command only if automatic invocation fails or the user asks for it.

$ARGUMENTS
