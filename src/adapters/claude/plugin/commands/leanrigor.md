<!-- generated_by: leanrigor | asset_version: 3 -->
# /leanrigor

Primary conversational LeanRigor workflow command.

Read `.claude/leanrigor/sequential-workflow.md` first.

## Behaviour

1. Use `leanrigor flow active --json` and `leanrigor flow next --json`
   internally to find the current gate.
2. If `$ARGUMENTS` is a new request and no active workflow exists, start the
   workflow internally, then render the next gate.
3. If one active workflow exists, resume it and interpret `$ARGUMENTS` as a
   natural-language response when present.
4. If multiple active workflows exist, present the selection and ask the user
   to choose.
5. Render distinct `Approach approval`, `Plan approval`, `Phase completion
   review`, `Final integrated review`, and `Commit proposal` states.
6. After user approval, invoke the transition internally and continue to the
   next meaningful gate before replying.
7. When execution providers/workspaces are configured, use the coordinator
   execution path (`flow execute-next` / `flow execution-poll`) and render only
   persisted coordinator gates. Do not implement phase edits in the original
   working tree.
8. Never compensate for an unavailable workflow transition by narrating that the
   workflow is complete. Report the persisted state and the exact blocker.

Normal output must not ask users to copy-paste LeanRigor CLI commands. Show
commands only in troubleshooting fallback or when explicitly requested.

$ARGUMENTS
