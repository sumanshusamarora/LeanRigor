<!-- generated_by: leanrigor | asset_version: 3 -->
# LeanRigor Conversational Workflow

Use `leanrigor flow` as the persisted source of truth. Users should respond in
plain language; Claude invokes LeanRigor transitions internally and renders
concise summaries.

Normal flow:

`triage summary -> Approach approval? -> Plan approval -> sequential execution -> per-phase completion gate -> final integrated review -> commit proposal`

Use `leanrigor flow active --json` to discover active workflows and
`leanrigor flow next --json` to inspect the current gate. Do not show shell
commands during normal use.
LeanRigor is parallel-ready internally, but default execution remains
sequential. Do not spawn parallel agents.

## Engineering Methodology

LeanRigor's shared methodology is installed under
`.claude/leanrigor/methodology/`. After reading the current workflow mode from
`flow next --json`, load:

- `.claude/leanrigor/methodology/core.md`
- `.claude/leanrigor/methodology/modes/<fast|standard|rigorous>.md`

Then load only the relevant methodology files for the current step:

- planning or plan revision: `.claude/leanrigor/methodology/planning.md`
- design-heavy changes: `.claude/leanrigor/methodology/design.md`
- implementation edits: `.claude/leanrigor/methodology/implementation.md`
- bugs, failures, failed repairs, or flaky behavior:
  `.claude/leanrigor/methodology/debugging.md`
- validation selection or recording: `.claude/leanrigor/methodology/testing.md`
- phase or final review: `.claude/leanrigor/methodology/review.md`
- completion evidence or success claims:
  `.claude/leanrigor/methodology/evidence.md`
- security, migration, API, data, privacy, production, infrastructure,
  concurrency, or destructive-operation risks:
  `.claude/leanrigor/methodology/safeguards.md`

Do not load every methodology file for every task. Fast mode must stay compact.

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
- Approval at plan derives ready phases; initialize the integration workspace,
  then start one ready phase internally with a stable session owner, phase lease,
  and phase workspace.
- `continue` must not bypass `needs_repair`, `needs_review`, or `needs_replan`.
- Ask one concise clarification for ambiguous responses.
- Before editing, verify that the current directory equals the active phase
  workspace returned by LeanRigor and that Git root is that workspace. If not,
  stop rather than editing the wrong tree.
- Use the workspace path returned by LeanRigor for all phase work. Never edit
  the user's original working tree when a phase workspace exists.
- Read the current revision before mutating. Run or skip declared validation
  with a reason in the phase workspace, then submit phase completion evidence as
  the same lease owner.
- After the phase gate passes, integrate the approved phase into the LeanRigor
  integration worktree. Run combined validation in the integration worktree
  before final integrated review.
- Refresh long-running leases where practical. On `revision_conflict`, reread state and present the changed gate instead of blindly retrying.
- Final integrated review remains required after all phase gates pass.
- On `integration_conflict`, present the conflict-repair gate; do not resolve
  with ours/theirs.
- Never run user-facing `git commit`, `git push`, amend, rebase, deploy, or
  spawn parallel agents automatically. LeanRigor may create internal transfer
  commits on LeanRigor-owned branches after a phase gate passes; these are not
  the final user commit and are not pushed.

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
