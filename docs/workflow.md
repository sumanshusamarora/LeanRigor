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
leanrigor flow approve-plan <workflow-id> --approval-policy workflow-authorized
leanrigor flow approve-plan <workflow-id> --approval-policy phase-by-phase
leanrigor flow phase-brief <workflow-id> phase-1
leanrigor flow phase-brief <workflow-id> phase-1 --feedback-file brief-feedback.txt
leanrigor flow phase-brief-show <workflow-id> phase-1
leanrigor flow approve-phase <workflow-id> phase-1 --brief-revision 1 --workflow-revision 4
leanrigor flow ready <workflow-id> --json
leanrigor flow execute-next <workflow-id> --provider scripted --json
leanrigor flow execute-ready <workflow-id> --provider scripted --json
leanrigor flow execution-status <workflow-id> --json
leanrigor flow execution-poll <workflow-id> --provider scripted --json
leanrigor flow execution-cancel <workflow-id> <phase-id> --json
leanrigor flow execution-recover <workflow-id> --json
leanrigor flow workspace-init <workflow-id> --json
leanrigor flow phase-start <workflow-id> phase-1 --owner <session-id>
leanrigor flow workspace-create-phase <workflow-id> phase-1 --owner <session-id> --json
leanrigor flow record-validation <workflow-id> --phase phase-1 --command "npm test" --exit 0 --result "targeted tests passed"
leanrigor flow phase-complete <workflow-id> phase-1 --owner <session-id> --evidence-file phase-1-completion.json
leanrigor flow integrate-phase <workflow-id> phase-1 --owner <session-id> --json
leanrigor flow integration-status <workflow-id> --json
leanrigor flow validate-integration <workflow-id> --json
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
| `executing` | A phase may be at read-only brief preflight, exact-revision approval, or coordinator execution. The first plan-order dependency-ready phase remains recommended for Standard/Rigorous workflows. | Resolve the persisted brief decision first; coordinator dispatch is allowed only after exact brief approval. |
| `validating` | All phase gates passed; final validation/review is still required. | `flow record-validation`, then review. |
| `reviewing` | Final integrated review is being recorded. | `flow record-review`. |
| `awaiting_commit_approval` | Review passed and a commit proposal exists. | Inspect proposal; optionally `flow complete`. |
| `completed` | Workflow was closed by explicit user action. | None. |
| `blocked` | Safe progress needs external action or repair budget is exhausted. | Resolve externally or cancel. |
| `cancelled` | User cancelled the workflow. | None. |

## Triage

`flow start` runs the evidence-driven triage runner. LeanRigor first creates a
bounded deterministic evidence packet. Explicit GitHub issue references such as
`issue #12`, `owner/repo#12`, or GitHub issue URLs are resolved before model
triage when repository identity and GitHub access are available. The evidence
packet records issue provenance, lookup status, bounded title/body content,
acceptance criteria, and safe lookup failures; unavailable issue lookup remains
explicit and does not make offline workflows unusable.

Model-backed triage then produces a tool-free recommendation from that packet;
it does not receive repository navigation tools during normal triage.
Deterministic policy makes the final mode decision, malformed recommendation
output receives one repair attempt, and fallback is deterministic.

Additional repository inspection is separate from recommendation. It only runs
for concrete repository-owned questions with explicit or deterministically
derived allowed paths, read and byte budgets, and a fact-only result schema.
Failed inspection leaves unresolved evidence unknown, and policy handles the
result conservatively.

Triage persists mode, risk, complexity, deterministic evidence, model
recommendation, policy decision, targeted inspection diagnostics, escalation
reasons, assumptions, clarification, provider/source, attempts, and warnings.
Triage does not create a detailed implementation plan and does not edit
implementation files.

## Gates

Clarification asks at most one blocking question. Non-blocking preferences are
recorded as assumptions or left to the active coding session.
Model-requested clarification is advisory: LeanRigor classifies the question as
user intent, user policy, safety-critical, repository-discoverable,
planning-detail, already resolved, or unnecessary. Only user-owned intent,
policy, and safety-critical questions block triage. Repository scope questions
are inspected when bounded scope is available or deferred to planning; planning
details wait for plan approval. When clarification blocks final triage, the UI
must label the mode as provisional rather than final.

Fast mode skips the separate approach gate only when the task is obvious,
unambiguous, low blast radius, and has no security, data, operational, or
architecture risk. All modes require plan approval before implementation.

Standard and Rigorous mode require approach approval before planning. The
post-triage gate presents `Approve approach and create plan`, `Revise approach`,
`View workflow details`, and `Cancel workflow`. Approval starts planning only
after the explicit transition succeeds. Approach revision feedback is persisted
with `flow revise-approach` and the workflow remains at the approach gate.
Cancellation records a cancelled workflow without deleting worktrees or
repository files.

Approach approval may include structured constraint changes:

```bash
leanrigor flow approve-approach <workflow-id> \
  --add-constraint "Tests must be updated" \
  --add-constraint "All checks must pass" \
  --remove-constraint "Preserve backward compatibility"
```

LeanRigor persists original triage constraints, policy constraints, user
additions, removals, overrides, audit entries, and final effective constraints.
Planning receives an authoritative structured constraint set with policy,
triage, user additions, user removals, user overrides, and the final effective
constraints. Removed triage constraints and explicit overrides are validated
before a plan can be presented for approval. A user-approved compatibility
waiver removes triage-level compatibility requirements from the final effective
set, but policy-owned compatibility requirements are not silently removed and
must be resolved explicitly. Policy-owned mandatory safety constraints remain
active and cannot be silently removed by user deltas.

## Planning

Plans are DAGs sized by functional outcome and dependency boundary. Default
execution remains sequential, but phases have stable IDs and explicit
dependency IDs so readiness can be derived deterministically.
Each phase should usually have one primary objective, a clear deliverable,
acceptance criteria, bounded expected read/write areas, validation commands,
and a meaningful dependency relationship to later phases.

Plan validation checks that phase dependencies are acyclic, criteria are
inspectable, validation expectations are present, no phase is an obvious
container such as "implement the whole feature" or "update backend, frontend,
tests and docs," and no phase contradicts approved effective constraints. For
example, a plan cannot reach approval if the user waived backward
compatibility but a phase introduces a compatibility migration. LeanRigor first
attempts same-model repair with the exact diagnostic; if the contradiction
remains, approval is blocked with the persisted affected phase, effective
constraint, repair attempt, and resolution. File-count heuristics are advisory:
cohesive refactors may touch many files, while unrelated changes in one file
still belong in separate phases.

Plan approval presents the persisted phase DAG with concise context rather than
a separate design document: workflow and model provenance, overall strategy,
architecture boundaries, effective approved constraints, dependencies and
execution order, validation strategy, provider mode, and isolated-worktree
policy. Approval remains explicit; implementation starts only through the
coordinator execution command after plan approval.

### Workflow Plan and Phase Execution Brief

Every mode presents a Workflow Plan before implementation. It records the
workflow ID and mode, planning/provider provenance, overall strategy, phase
DAG, architecture and write boundaries, effective constraints, validation and
review obligations, workspace strategy, and the current approval
recommendation. The persisted DAG remains authoritative; planning detail is
not deferred until implementation.

Before a phase can be approved, LeanRigor runs a provider-neutral, read-only
brief-planning pipeline. Deterministic scope starts with approved phase paths,
named issue paths, repository metadata, test layout, and justified direct
imports. The request enforces read-count, byte, and timeout budgets. Every
controlled scope expansion records its path, reason, source path when
applicable, and read-only status. The persisted result contains facts,
unresolved questions, warnings, files read, bytes read, and provider/model-tier
provenance; it does not contain hidden reasoning or a model transcript.

The generated Phase Execution Brief adds a concrete deliverable, inspected
current behavior, actionable implementation approach, bounded reads and writes,
relevant files and symbols, dependencies, assumptions, exclusions, acceptance
criteria, current test obligations, validation, risks, prior-phase context, and
repository/constraint/inspection identities. Current test obligations are
derived from task type, risk, mode, plan criteria, and repository checks; the
more comprehensive deterministic obligation system remains separate work.

Deterministic quality validation rejects copied phase prose, generic approaches,
unbounded implementation writes, uninspectable criteria, missing validation or
manual validation, unjustified missing tests, missing risk representation, and
missing or mismatched provenance. Exact diagnostics may receive one bounded
same-provider repair that changes only deficient fields. The pipeline
revalidates and fails closed if repair is still inadequate; it never substitutes
a generic approvable fallback.

Exact file, symbol, narrowed-read, and additional configured-validation
refinements are recorded as non-material. New write boundaries, removed
validation requirements, changed acceptance criteria or dependencies, and newly
discovered material security, migration, architecture, or public-contract risks
are structured and visible rather than hidden in prose.

Brief approval is tied to its exact revision. Briefs become stale after a plan
revision or other material change and are regenerated before they can be
approved or executed. Provider findings that reveal unexpected scope preserve
partial work in the phase worktree, then route through replan or review; they
never silently expand the approved plan.

Revision feedback is persisted and creates a replacement brief revision and
pending decision. The previous decision is superseded and its approval cannot
carry forward. Inspection or quality failure remains at phase preflight with
retry, plan-boundary revision, diagnostics, and cancellation actions; it does
not prepare a workspace or dispatch an implementation provider.

Current limitation: the approved detailed brief is not yet propagated as the
implementation provider's execution contract, and universal dispatch hardening
across every legacy/runtime entry point remains Phase 3 work. The complete live
provider lifecycle is therefore not claimed as verified by this phase.

### Adaptive Approval

LeanRigor computes recommendations from deterministic mode, risk, ambiguity,
blast-radius, phase dependency, assumptions, and material-drift evidence. Model
confidence is not an approval decision input. The recommendation, its rule and
reasons, the selected policy, selection source, timestamp, workflow revision,
phase authorisation, override, and later changes are persisted in workflow
history.

- Fast and Standard persist the selected later-phase approval policy, but
  Workflow Plan approval still creates a separate pending Phase 1 brief
  decision before execution.
- Standard presents Workflow Plan policy choices, **Revise plan**, **View full
  details**, and **Cancel workflow**. The user may override the recommended
  later-phase policy unless deterministic policy forbids workflow-wide approval.
- Rigorous presents **Approve Workflow Plan and prepare Phase 1 brief** at the
  plan gate. Phase 1 remains unauthorized until its exact persisted brief
  revision is shown and separately approved. Each completed phase clears its
  authorisation and returns the next ready brief for approval.

Workflow-wide authorisation never covers material drift. Scheduler eligibility
requires complete dependencies, a prepared workspace, a current brief without
unresolved material changes, approval-policy permission, recorded required user
approval, and existing deterministic gates. The coordinator remains the sole
provider dispatch path; the interactive controller does not implement phase
files unless manual execution was explicitly selected.

Mode differences:

| Mode | Phase sizing |
|---|---|
| Fast | One compact phase is acceptable for genuinely small, low-risk work. |
| Standard | Prefer a few cohesive phases; split materially distinct implementation, consumer, coverage, or documentation outcomes. |
| Rigorous | Isolate migrations, security-sensitive work, public contracts, production infrastructure, destructive operations, and other high-risk boundaries. |

The implementation intentionally avoids OpenCode, Codex, CodeGraph, a desktop
UI, and a large custom process manager. Higher `execution.maxParallelPhases`
values are honored by the execution coordinator when a provider supports the
contract safely.

Execution status distinguishes the `recommendedNextPhase` from
`otherDependencyReadyPhases`. Standard and Rigorous workflows preserve plan
order as the primary CTA; a later independent ready phase may be displayed as
available, but it must not replace the next plan-order phase unless the user
explicitly selects out-of-order execution.

Planning methodology is loaded from `methodology/planning.md` plus the current
mode overlay. Plans should include the desired outcome, inspected current
behavior, approach, affected boundaries, acceptance criteria, validation
strategy, and relevant risks. Rigorous plans must isolate migration, security,
public contract, data, and production-impacting boundaries when present.

## Execution Contract

LeanRigor owns what may run, when it may run, what evidence is required, and
whether a phase result is accepted. Execution providers own how a worker is
launched and monitored.

The execution coordinator is the single control layer for provider-driven
phase work. It reads current state, asks the scheduler for eligible phases,
honors `execution.maxParallelPhases`, acquires phase leases, creates phase
worktrees, prepares the workspace, dispatches workers through a provider,
persists execution handles, polls status, refreshes healthy leases, collects
structured results, submits completion evidence, invokes completion gates,
integrates accepted phases, and runs combined validation when the DAG reaches
that deterministic point.

Provider results are evidence, not authority. A provider can return
`completed`, but the phase is accepted only if the LeanRigor completion gate
passes. Provider diagnostics are bounded and persisted without full transcripts
or hidden reasoning.

Execution attempts may also persist provider-session provenance and a bounded
worktree checkpoint. On provider failure, max turns, max budget, interruption,
or malformed output, LeanRigor records tracked changes, untracked files,
deletions, and a bounded diff summary. That partial work remains in the phase
worktree for repair or review, but it is not accepted, committed, merged,
discarded, or integrated automatically.

Each phase lifecycle is:

```text
planned -> ready -> leased/running -> targeted validation -> completion gate
-> completed | needs_repair | needs_review | needs_replan | blocked
```

A phase does not transition directly from ready execution to completed. A ready
phase must be leased to an explicit owner, and completion must be submitted by
that same owner while the lease is active. Provider-owned leases are completed
through the coordinator; a CLI caller cannot bypass ownership by copying or
guessing the provider lease owner string. The next dependent phase unlocks only
when the completion gate returns `completed`.

When Git workspaces are enabled, the implementation step happens in the
assigned phase worktree returned by `workspace-create-phase`, not in the
user's original checkout. Before editing, Claude must verify that the current
directory equals the active phase workspace path and that Git root matches that
workspace. If it does not, Claude stops rather than editing the wrong tree.

The phase completion gate records Git evidence from the workspace:

- workspace path and base commit;
- phase workspace HEAD;
- changed files, including relevant untracked files;
- ignored files excluded by default;
- diff hash;
- binary and file-mode indicators;
- the internal LeanRigor transfer commit when the gate passes.

LeanRigor uses internal transfer commits on LeanRigor-owned branches. These are
mechanical workflow commits, are not pushed, and are not the final user commit.
The final commit proposal remains a separate human-reviewed step.

### Providers

The provider-neutral contract includes:

- `capabilities()`;
- `dispatch(input)`;
- `getStatus(handle)`;
- `collectResult(handle)`;
- `cancel(handle, reason)`.

`scripted` is the deterministic test provider. It can create, edit, delete,
and leave untracked files in the assigned phase workspace; emit validation
evidence; fail, block, time out, stop heartbeating, return malformed evidence,
or modify unexpected files. It exists to exercise LeanRigor workflow machinery
without a live model session.

`claude-cli` (also accepted as `claude` for compatibility) is a minimal
real-Claude provider prototype using Claude Code CLI print mode in the assigned
phase workspace. It uses non-interactive arguments, sets `cwd` to the phase
worktree, persists bounded status/stdout/stderr artifacts under `.leanrigor/`,
applies timeout/cancellation, requests structured output, redacts diagnostics,
and never commits, pushes, merges, or deploys. Process exit alone is not a
completion decision; LeanRigor must collect a structured result and pass the
completion gate.

Authoritative coordinator progression is:

```text
provider terminal result
-> collect structured result
-> verify lease and phase workspace
-> persist validation/evidence
-> completion gate
-> internal phase transfer commit
-> integrate phase
-> update integration head
-> combined validation on current integration head
-> final integrated review gate
-> commit proposal only after final review passes
```

If any transition is unavailable, Claude must report the persisted state and
blocker. It must not narrate a workflow as complete while state remains
`executing`.

Runtime paths are explicit:

- `execution.mode = coordinator`: use `flow execute-next` and
  `flow execution-poll`; Claude monitors persisted gates and does not implement
  phase edits itself.
- Provider `auto` resolves to the configured provider or fails clearly with
  recovery choices. LeanRigor does not silently substitute scripted or manual
  execution.
- `execution.mode = manual`: available only after explicit user selection;
  Claude may implement a phase only in the LeanRigor-assigned phase workspace
  and must submit persisted completion evidence.

Before dispatch, workspace preparation records the worktree path, repository
identity, branch or commit basis, package-manager detection, dependency
availability, validation-command availability, any bootstrap command, command
risk, approval requirements, and evidence. Existing dependencies proceed.
Missing JavaScript dependencies block by default with the exact
lockfile-preserving command, such as `npm ci` when `package-lock.json` is
present. Automatic bootstrap is allowed only by
`execution.dependencyBootstrap = "auto-lockfile"` and must preserve manifests
and lockfiles; otherwise provider dispatch stops before implementation. The
provider handoff states that dependencies were prepared and instructs workers
not to improvise package installation.

## Integration Workspace

`workspace-init` creates one dedicated integration worktree for the workflow,
starting from the frozen workflow base commit. Later phase worktrees branch
from the current integration head that contains their dependencies. If the
integration head advances before another phase is integrated, LeanRigor checks
the recorded phase base and applies the approved internal commit through the
controlled integration path rather than silently rebasing.

By default, worktrees live outside the repository root to avoid unsafe nested
Git worktrees. The default root is:

```text
<repo-parent>/.leanrigor-worktrees/<repo-name>-<repository-path-hash>
```

The short hash is derived from the canonical repository path so separate clones
with the same directory name do not collide. `execution.workspaceRoot` can
override the location, but LeanRigor canonicalizes configured roots and rejects
locations that are the repository, contain the repository, are nested inside
the repository, or overlap Git's administrative common directory.

`integrate-phase`:

1. acquires the workflow lock;
2. verifies the phase completion gate passed;
3. verifies approved Git evidence and workspace identity;
4. enforces dependency integration order;
5. skips already integrated phases idempotently;
6. cherry-picks the internal transfer commit into the integration worktree;
7. persists success or textual conflict metadata;
8. never touches, rebases, merges, commits, or pushes the user's branch.

On conflict, LeanRigor records `integration_conflict`, conflicting files, and
the next action `create_conflict_repair`. It does not choose ours/theirs and it
does not modify the original user worktree.

`validate-integration` runs combined validation commands with the integration
worktree as `cwd`. Validation is stale when the integration head changes.
Final integrated review requires every completed phase to be integrated and
the current integration head to have passing combined validation.

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

Workspace cleanup is conservative. `workspace-cleanup` verifies LeanRigor
ownership metadata before removal, refuses dirty or unintegrated phase
worktrees in safe mode, preserves the integration worktree by default, and
does not delete remote branches. `workspace-recover` inspects missing,
orphaned, expired, dirty, or uncertain workspaces and returns `needs_review`
when ownership or data safety is unclear.

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
- final approved effective constraints;
- every acceptance criterion with `met`, `not_met`, `uncertain`, or
  `not_applicable`;
- concise evidence for each criterion;
- changed files;
- validation commands, exit codes, summaries, and skipped-validation reasons;
- scope deviations;
- assumptions introduced during execution;
- remaining risks;
- dependent-phase readiness;
- workflow-owned evidence artifact path, when an evidence file is supplied;
- timestamp and workflow revision.

Completion evidence must not include chain of thought or verbose
self-reflection. Evidence files supplied to `flow phase-complete
--evidence-file` must exist, parse as JSON, match the workflow and phase when
those fields are present, and match the current workflow revision when
`workflowRevision` is present. LeanRigor copies accepted evidence files into
`.leanrigor/workflows/<workflow-id>/artifacts/`; arbitrary `/tmp` paths should
not be used as durable evidence across retries or sessions.

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
