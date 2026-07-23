# Workflow

LeanRigor provides a persisted sequential workflow under
`.leanrigor/workflows/<workflow-id>.json`.

In Claude Code, the normal user experience is conversational:

```text
/leanrigor:start Add campaign selection to lead assignments
-> triage summary
-> Approach approval, when required
-> Plan approval
-> sequential execution
-> per-phase completion gate
-> Final integrated review
-> Commit proposal
```

Claude invokes LeanRigor transitions internally. Users normally reply with
plain language such as `Approve`, `Revise the plan to separate the migration`,
`Continue`, `Repair it`, `Show status`, or `Cancel`. Raw CLI commands are shown
only for troubleshooting, advanced/manual use, or explicit user request.

## Advanced CLI

```bash
leanrigor flow start "Fix the assignment regression" --provider auto
leanrigor flow active --json
leanrigor flow next <workflow-id> --json
leanrigor flow status <workflow-id>
leanrigor flow answer <workflow-id> "<answer>"
leanrigor flow approve-approach <workflow-id>
leanrigor flow approve-plan <workflow-id>
leanrigor flow ready <workflow-id> --json
leanrigor flow phase-start <workflow-id> phase-1 --owner <session-id>
leanrigor flow record-validation <workflow-id> --phase phase-1 --command "npm test" --exit 0 --result "targeted tests passed"
leanrigor flow phase-complete <workflow-id> phase-1 --owner <session-id> --evidence-file phase-1-completion.json
leanrigor flow phase-status <workflow-id> phase-1
leanrigor flow repair <workflow-id> phase-1 --reason "Targeted validation failed"
leanrigor flow record-review <workflow-id> --status passed --summary "Integrated review passed"
leanrigor flow commit-plan <workflow-id>
leanrigor flow complete <workflow-id>
```

`flow active --json` supports safe workflow discovery:

- one active workflow: resume it;
- none: start only when a request is available;
- multiple: show ID, request, state, mode, and updated time;
- completed and cancelled workflows are not selected by default.

`flow next --json` returns the current gate label, pending decision, allowed
natural-language intents, human-readable summary data, and internal operation
names. It intentionally treats shell commands as troubleshooting details rather
than normal user-facing output.

## Lifecycle

| State | Meaning | Next safe action |
|---|---|---|
| `created` | Workflow file exists with request and repository root. | Internal transition to triage. |
| `triaging` | Triage is running; implementation files must not be edited. | Persist triage result. |
| `awaiting_clarification` | One blocking question is required. | `flow answer`. |
| `awaiting_approach_approval` | Standard/Rigorous approach gate is pending. | `flow approve-approach` or `flow reject-approach`. |
| `planning` | Sequential plan is being generated. | Internal transition to plan approval. |
| `awaiting_plan_approval` | Phased plan is ready but implementation is blocked. | `flow approve-plan` or `flow revise-plan`. |
| `executing` | One or more phases may be ready in the DAG; default dispatch remains one phase at a time. | Start/lease a ready phase, record validation, submit completion evidence, repair, review, or replan. |
| `validating` | All phase gates passed; final validation/review is still required. | `flow record-validation`, then review. |
| `reviewing` | Final integrated review is being recorded. | `flow record-review`. |
| `awaiting_commit_approval` | Review passed and a commit proposal exists. | Inspect proposal; optionally `flow complete`. |
| `completed` | Workflow was closed by explicit user action. | None. |
| `blocked` | Safe progress needs external action or repair budget is exhausted. | Resolve externally or cancel. |
| `cancelled` | User cancelled the workflow. | None. |

## Triage

`flow start` runs the existing triage runner. Model-backed triage is used when
configured, output is schema-validated, deterministic policy overrides are
mandatory, malformed output is retried once, and fallback is deterministic.

Triage persists mode, risk, complexity, escalation reasons, assumptions,
clarification, provider/source, attempts, and warnings. Triage does not create a
detailed implementation plan and does not edit implementation files.

## Gates

Clarification asks at most one blocking question. Non-blocking preferences are
recorded as assumptions or left to the active coding session.

Fast mode skips the separate approach gate only when the task is obvious,
unambiguous, low blast radius, and has no security, data, operational, or
architecture risk. All modes require plan approval before implementation.

Standard and Rigorous mode require approach approval before planning. Rejection
blocks the workflow rather than silently choosing a different path.

## Planning

Plans are DAGs sized by functional outcome and dependency boundary. Default
execution remains sequential, but phases have stable IDs and explicit
dependency IDs so readiness can be derived deterministically.
Each phase should usually have one primary objective, a clear deliverable,
acceptance criteria, bounded expected read/write areas, validation commands,
and a meaningful dependency relationship to later phases.

Plan validation checks that phase dependencies are acyclic, criteria are
inspectable, validation expectations are present, and no phase is an obvious
container such as "implement the whole feature" or "update backend, frontend,
tests and docs." File-count heuristics are advisory: cohesive refactors may
touch many files, while unrelated changes in one file still belong in separate
phases.

Mode differences:

| Mode | Phase sizing |
|---|---|
| Fast | One compact phase is acceptable for genuinely small, low-risk work. |
| Standard | Prefer a few cohesive phases; split materially distinct implementation, consumer, coverage, or documentation outcomes. |
| Rigorous | Isolate migrations, security-sensitive work, public contracts, production infrastructure, destructive operations, and other high-risk boundaries. |

The implementation intentionally avoids parallel agents, worktrees, OpenCode,
Codex, and CodeGraph. Higher `execution.maxParallelPhases` values change
scheduler recommendations only.

Planning methodology is loaded from `methodology/planning.md` plus the current
mode overlay. Plans should include the desired outcome, inspected current
behavior, approach, affected boundaries, acceptance criteria, validation
strategy, and relevant risks. Rigorous plans must isolate migration, security,
public contract, data, and production-impacting boundaries when present.

## Execution Contract

LeanRigor CLI owns durable state, locks, leases, and approval gates. Claude Code owns the actual
repository inspection, edits, command execution, and review work in the active
session. After each significant step Claude records concise evidence back into
LeanRigor with `flow record-validation`, `flow phase-complete`, and
`flow record-review`.

Each phase lifecycle is:

```text
planned -> ready -> leased/running -> targeted validation -> completion gate
-> completed | needs_repair | needs_review | needs_replan | blocked
```

A phase does not transition directly from ready execution to completed. A ready
phase must be leased to an explicit owner, and completion must be submitted by
that same owner while the lease is active. The next dependent phase unlocks only
when the completion gate returns `completed`.

## Concurrency Controls

Every state-changing command uses revisioned atomic persistence:

1. acquire the workflow lock;
2. load current workflow state;
3. verify `--expected-revision` when supplied;
4. validate and apply one transition;
5. increment revision once;
6. write through a temporary file and atomic rename;
7. release the lock after ownership verification.

Revision conflicts are explicit:

```json
{
  "ok": false,
  "code": "revision_conflict",
  "expectedRevision": 12,
  "actualRevision": 13
}
```

Workflow locks protect short mutations only. Phase leases protect future
long-running owners. `lease-phase`, `heartbeat-phase`, `release-phase`, and
`recover-leases` are advanced troubleshooting commands; normal Claude use calls
them internally. Expired leases without completion evidence return to `ready`
when dependencies remain valid. Expired leases with partial evidence move to
`needs_review`. Incompatible workflow/dependency changes move to
`needs_replan`. Recovery is idempotent and never marks a phase completed.

`flow ready --json` reports all theoretically ready phases plus
`dispatchableCount` after `execution.maxParallelPhases` and conflicts are
applied. Default `maxParallelPhases` is `1`.

## Ownership Conflicts

Phases declare repository-relative expected read and write areas. Supported
patterns are literal paths, directory paths, `*`, and trailing `/**`.
Path-based ownership is conservative scheduling metadata, not proof of semantic
isolation.

Blocking conflicts include overlapping write/write areas, write/read overlap
when `execution.writeReadConflictsBlock` is true, and shared sensitive paths.
Sensitive defaults include package manifests and lockfiles, TypeScript config,
`.git/**`, `.github/**`, `migrations/**`, `schema/**`, and `infra/**`.
Standard and Rigorous phases without explicit ownership are not parallel
eligible.

Completion evidence persists:

- original objective;
- every acceptance criterion with `met`, `not_met`, `uncertain`, or
  `not_applicable`;
- concise evidence for each criterion;
- changed files;
- validation commands, exit codes, summaries, and skipped-validation reasons;
- scope deviations;
- assumptions introduced during execution;
- remaining risks;
- dependent-phase readiness;
- timestamp and workflow revision.

Completion evidence must not include chain of thought or verbose
self-reflection.

Example evidence file:

```json
{
  "criteria": [
    {
      "criterion": "The requested behavior follows nearby patterns.",
      "status": "met",
      "evidence": ["Updated service path uses the existing assignment helper."]
    }
  ],
  "filesChanged": ["src/services/assignment.ts", "tests/assignment.test.ts"],
  "validation": [
    {
      "command": "npm test -- assignment",
      "exitStatus": 0,
      "result": "8 tests passed"
    }
  ],
  "scopeDeviations": [],
  "assumptions": [],
  "remainingRisks": []
}
```

## Completion Gate

The gate produces one of:

| Decision | Meaning |
|---|---|
| `completed` | All required criteria are met, evidence exists, validation expectations are satisfied, scope is compatible, and no critical risk remains. |
| `needs_repair` | The objective is still valid and a bounded repair can address incomplete work or failed validation. |
| `needs_review` | Criteria may be met but evidence is ambiguous, specialist judgement is required, or sensitive areas were touched unexpectedly. |
| `needs_replan` | Scope expanded materially, assumptions invalidated the plan, contracts changed, or dependencies need restructuring. |
| `blocked` | External access/information is missing, a safety condition cannot be met, or a repair budget is exhausted into a blocker. |

Deterministic policy owns the final transition. It checks missing evidence,
missing or failed validation, skipped validation by mode, criteria not marked
`met`, changed files outside expected scope, high-risk path triggers, migration
and dependency detection, public contract changes, repair budgets, and phase
dependency status. Model or agent judgement may inform semantic evidence, but
it cannot override these deterministic checks.

Scope deviations are recorded and evaluated rather than treated as automatic
failures. Examples that escalate include a documentation phase changing runtime
behavior, a frontend phase changing migrations, a low-risk phase touching
authentication paths, a new production dependency, or a public contract change
not present in the approved plan.

Repair is bounded per phase:

```bash
leanrigor flow repair <workflow-id> <phase-id> --reason "<reason>"
```

The repair record includes attempt number, reason, requested scope, validation
after repair, and final outcome. After the configured repair budget is
exhausted, LeanRigor moves the phase to review/replan/block instead of looping.

## Validation And Review

Validation is proportional to mode:

| Mode | Default expectation |
|---|---|
| Fast | Syntax/type sanity where relevant, targeted command, diff sanity check. |
| Standard | Targeted tests, package/module checks where available, integrated review. |
| Rigorous | Targeted and broader tests, risk-specific checks, deep or specialist review where triggered. |

Every validation record includes command, exit status, concise result, skipped
flag, skipped reason when relevant, and timestamp. LeanRigor does not mark
validation successful without evidence. Fast may accept skipped validation with
a reason; Standard and Rigorous reject skipped validation by default.

Final review records one of:

- `passed`
- `needs_repair`
- `needs_replan`
- `blocked`

Per-phase gates check local completeness and evidence so unfinished work cannot
progress. The final integrated review remains required and checks cross-phase
consistency, the original request, integration regressions, and overall scope.
Integrated review repair still appends a bounded repair phase and returns to
execution until the configured review repair budget is exhausted. Replan returns
to plan approval. Blocked requires external action.

Testing and review methodology are prompt guidance layered on top of these
deterministic gates. Testing guidance requires behavior-focused validation and
clear skipped-check reasons. Review guidance maps to sanity, integrated, deep,
and specialist review levels. Evidence guidance requires each completion claim
to identify the claim, evidence, verification status, and remaining uncertainty
concisely.

## Debugging And Safeguards

Bug and failure work loads `methodology/debugging.md`: reproduce, observe,
narrow, form hypotheses, test the cheapest discriminating hypothesis, identify
root cause, implement the minimal fix, add regression coverage, and verify no
adjacent regression.

Security, migration, API/contract, data, privacy, production, infrastructure,
concurrency, and destructive-operation triggers load `methodology/safeguards.md`.
Those safeguards guide least privilege, server-side enforcement, idempotent
migrations, expand/migrate/contract rollout, contract tests, rollback,
observability, and no unverified production writes.

## Commit Proposal

After review passes, LeanRigor generates a commit proposal grouped by completed
phase file evidence. It shows commit messages, file groups, rationale, and exact
commands. LeanRigor never runs `git commit` or `git push` automatically.

## Resume And Cancel

```bash
leanrigor flow list --root /path/to/repository
leanrigor flow resume <workflow-id> --root /path/to/repository
leanrigor flow cancel <workflow-id> --root /path/to/repository
```

Workflow state is repository-local and survives process restarts, Claude Code
restarts, and context compaction. Reads and writes are schema-validated; writes
are atomic, guarded by a persistent workflow lock, and checked by revision.

Status and resume expose the current phase objective, gate decision, criteria
progress, validation status, repair attempts, scope deviations, blocker or
pending-review reason, and next valid action.
