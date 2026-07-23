<!-- generated_by: leanrigor | asset_version: 2 -->
# LeanRigor Conversational Workflow

Use `leanrigor flow` as the persisted source of truth. Users should respond in
plain language; Claude invokes LeanRigor transitions internally and renders
concise summaries.

Normal flow:

`triage summary -> Approach approval? -> Plan approval -> sequential execution -> per-phase completion gate -> final integrated review -> commit proposal`

Use `leanrigor flow active --json` to discover active workflows and
`leanrigor flow next --json` to inspect the current gate. Do not show shell
commands during normal use.

Labels:

- `Approach approval`
- `Plan approval`
- `Phase completion review`
- `Final integrated review`
- `Commit proposal`

Rules:

- One active workflow: resume it.
- No active workflow: start only when the user supplied a request.
- Multiple active workflows: show ID, request, state, mode, updated time, and ask the user to choose.
- Interpret `approve`, `looks good`, and `continue` according to the current gate.
- Approval at approach immediately generates and renders the actual phased plan.
- Approval at plan starts execution.
- `continue` must not bypass `needs_repair`, `needs_review`, or `needs_replan`.
- Ask one concise clarification for ambiguous responses.
- Run or skip declared validation with a reason, then submit phase completion evidence.
- Final integrated review remains required after all phase gates pass.
- Never run `git commit`, `git push`, amend, rebase, deploy, create worktrees, or spawn parallel agents automatically.

Presentation:

- Human-readable first: workflow ID, request, mode, state, current phase, gate status, criteria/validation progress, repair attempts, blockers, and next action.
- Do not print raw JSON or CLI commands unless troubleshooting or explicitly requested.

Troubleshooting fallback:

```text
I could not run the LeanRigor transition automatically.

You can retry, or run:
<exact command>

Error:
<concise error>
```
