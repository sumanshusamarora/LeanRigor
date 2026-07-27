---
description: Start or resume the conversational LeanRigor workflow.
argument-hint: "[coding request or response]"
allowed-tools: AskUserQuestion, Bash(${CLAUDE_PLUGIN_ROOT}/bin/leanrigor *)
---

# /leanrigor:start

Load `plugin-skills/sequential-workflow` before handling any workflow gate.
That skill is the workflow UX contract.

Invoke the plugin-owned runtime internally through
`${CLAUDE_PLUGIN_ROOT}/bin/leanrigor`.

Behaviour:

1. Read active workflow selection with `flow active --json`.
2. If `$ARGUMENTS` is a new coding request and no active workflow exists, start
   a workflow with `flow start "$ARGUMENTS" --provider auto`, then render from
   the returned `next` object when present or immediately read `flow next
   --json` when it is absent. Do not end the turn from raw `flow start` JSON.
   Do not use `--provider deterministic` unless the user explicitly asks for
   deterministic triage.
3. If one active workflow exists, resume it and interpret `$ARGUMENTS` as a
   natural-language response when present.
4. If multiple active workflows exist, use `AskUserQuestion` for the workflow
   selector when available. Do not render an ordinary text question first.
   Do not guess.
5. At approval gates, render `Approach approval` or `Plan approval` with a
   concise summary and use `AskUserQuestion` for the action selector when
   available. The post-triage approach selector options are exactly `Approve
   approach and create plan`, `Revise approach`, `View workflow details`, and
   `Cancel workflow`; state that no implementation has started. After explicit
   approach approval, invoke
   `flow approve-approach <workflow-id> --provider auto` internally so plan
   generation can call Claude when available. Include `--add-constraint`,
   `--remove-constraint`, or `--override-constraint "<old> => <new>"` for any
   user-supplied approval constraint changes. Do not use
   `--provider deterministic` unless the user explicitly asks for deterministic
   planning. Continue to the next meaningful gate before responding.
   At `awaiting_clarification`, render `Question: <persisted question>`
   verbatim and `Why this matters: <persisted reason>` when present. Do not
   replace the question with the reason or leave a blank prompt after "before
   continuing".
6. For plan revisions, invoke
   `flow revise-plan <workflow-id> "<feedback>" --provider auto` internally.
   Preserve any explicit user request for deterministic planning.
7. During execution, use `execution.mode = coordinator` when execution
   providers/workspaces are configured: invoke `flow execute-next --provider auto`
   or `flow execution-poll --provider auto`, monitor persisted coordinator
   state, and present the returned gate. Do not use the scripted provider unless
   the user explicitly asks for a scripted/deterministic execution provider. Do
   not edit the original working tree or implement the phase directly in
   coordinator mode.
8. If provider dispatch cannot start, present explicit recovery choices:
   retry configured provider, use another available provider, switch to manual
   execution, or cancel. Use `execution.mode = manual` only after explicit user
   selection. In manual mode, work only in the active phase workspace and record
   validation/completion evidence before presenting a phase gate.
9. Render the persisted final review and commit proposal conversationally. Never commit or
   push automatically.

At every LeanRigor decision gate, `AskUserQuestion` is mandatory when the tool
is available. Do not render an ordinary text question first. Fall back to
numbered choices only when the tool is genuinely unavailable. Never infer
approval from conversational tone. Do not use
`ExitPlanMode` as a substitute for LeanRigor approval.

Never compensate for an unavailable workflow transition by narrating that the
workflow is complete. Report the persisted state and the exact blocker.

Normal output must not ask the user to copy-paste LeanRigor CLI commands. Show
the exact command only if automatic invocation fails or the user asks for it.

$ARGUMENTS
