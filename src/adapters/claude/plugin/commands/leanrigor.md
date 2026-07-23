<!-- generated_by: leanrigor | asset_version: 2 -->
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

Normal output must not ask users to copy-paste LeanRigor CLI commands. Show
commands only in troubleshooting fallback or when explicitly requested.

$ARGUMENTS
