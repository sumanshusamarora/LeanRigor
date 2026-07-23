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
6. During execution, work only on the active phase, record validation and
   completion evidence internally, then follow the returned phase gate decision.
7. Render final review and commit proposal conversationally. Never commit or
   push automatically.

Normal output must not ask the user to copy-paste LeanRigor CLI commands. Show
the exact command only if automatic invocation fails or the user asks for it.

$ARGUMENTS
