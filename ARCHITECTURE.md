# Architecture

## Core boundary

LeanRigor is the workflow and policy control plane for AI coding sessions.

It owns:

- triage, task complexity, workflow risk, and final mode selection;
- planning and phase DAG generation;
- approvals and dispatch eligibility;
- ownership and path-conflict policy;
- evidence requirements and completion gates;
- integration ordering and validation requirements;
- final review, resumability, and audit state.

Execution providers own provider-specific worker launch, process lifecycle, status, heartbeat, timeout, cancellation, and structured results.

Workspace providers may eventually own reusable Git mechanics. LeanRigor retains the LeanRigor-specific coupling between workspace identity, phase ownership, evidence, integration order, combined validation, and user-working-tree safety.

## Layering

The implementation is split into four conceptual layers:

1. **Workflow and methodology** — policies, prompts, schemas, engineering guidance, and mode overlays.
2. **Deterministic orchestration core** — workflow state, triage policy, approvals, DAG scheduling, leases, evidence gates, persistence, validation, review, and commit planning.
3. **Workspace and integration substrate** — Git preflight, phase and integration worktrees, internal transfer commits, conflict state, combined validation, recovery, and cleanup.
4. **Adapters and execution providers** — Claude Code integration first, provider-specific worker launch, status, result collection, and cancellation.

The core does not depend on hard-coded vendor model IDs. It selects portable capability tiers:

- `small`
- `medium`
- `large`
- `inherit`

Adapters resolve these tiers to provider-specific aliases or concrete models.

## Deterministic versus prompt-owned responsibilities

Deterministic code owns:

- workflow states and transitions;
- repository-policy minimums and mandatory escalation;
- approach and plan approval gates;
- revision checks, workflow locks, leases, and dependency status;
- validation records and exit codes;
- evidence presence and required criterion status;
- scope/path checks and sensitive-path escalation;
- repair budgets and final eligibility;
- integration order and combined-validation identity;
- no automatic final commit, push, deployment, or destructive production write.

Prompts and models may help:

- assess semantics within a bounded contract;
- propose approaches and plans;
- implement work through an execution provider or approved manual path;
- select useful tests;
- review code and summarise evidence;
- explain trade-offs and uncertainty.

Prompt output cannot override deterministic blockers or narrate a workflow into a state that was not persisted.

## Adaptive triage and mode selection

Automatic triage is enabled by default. The triage path:

1. gathers a versioned deterministic evidence packet from the request,
   explicitly named paths, bounded repository metadata, package manifests,
   policy state, and Git status metadata;
2. asks the configured triage provider for one tool-free
   `ModelTriageRecommendation`;
3. validates the structured result and allows one repair for malformed output;
4. optionally runs a separate targeted inspection only for concrete questions
   with explicit allowed paths and read/byte budgets;
5. reruns the tool-free recommendation when inspection adds verified facts;
6. applies deterministic repository-policy overrides as the final authority;
7. falls back to deterministic local triage when provider recommendation is
   unavailable or invalid;
8. persists deterministic evidence, model recommendation, policy decision,
   final mode, override reasons, provider provenance, inspection diagnostics,
   attempts, warnings, assumptions, and blocking clarification.

Complexity and risk are independent. Fast requires positive evidence of low risk. Rigorous requires an explicit policy trigger such as security, migrations, public contracts, production infrastructure, data integrity, concurrency, destructive operations, or high blast radius.

Default mode intent:

| Mode | Intent |
|---|---|
| Fast | Brief inspection, compact plan, targeted validation, diff sanity review. |
| Standard | Inspected approach, cohesive phased plan, explicit approval, targeted validation, integrated review. |
| Rigorous | Explicit approach gate, isolated risk boundaries, stronger evidence, broader validation, deep or specialist review where triggered. |

## Persisted workflow state

Each workflow is stored under:

```text
.leanrigor/workflows/<workflow-id>.json
```

State is schema-validated, revisioned, and written atomically. State-changing operations:

1. acquire a persistent workflow lock;
2. reload current state;
3. verify the expected revision when supplied;
4. apply one valid transition;
5. increment the revision once;
6. write through a temporary file and atomic rename;
7. release the lock after ownership verification.

The primary lifecycle is:

```text
created
→ triaging
→ awaiting_clarification?
→ awaiting_approach_approval?
→ planning
→ awaiting_plan_approval
→ executing
→ validating
→ reviewing
→ awaiting_commit_approval
→ completed
```

`blocked` and `cancelled` are explicit escape states.

Persisted workflow state includes the original request, repository root, mode, risk, complexity, approvals, plan, phase state, leases, execution records, validation, completion evidence, scope deviations, internal Git evidence, integration state, final review, and commit proposal.

## Planning, DAGs, and ownership

Plans are explicit DAGs of small functional outcomes rather than file lists. Each phase has:

- a stable ID;
- one primary objective;
- explicit dependency IDs;
- inspectable acceptance criteria;
- expected read and write areas;
- validation expectations;
- mode and risk context.

The scheduler derives readiness from dependency completion, workflow state, active leases, ownership conflicts, sensitive paths, and `execution.maxParallelPhases`.

Path ownership is a conservative scheduling safeguard, not semantic proof. Write/write overlap blocks. Write/read overlap blocks by default. Sensitive shared files conflict broadly. Standard and Rigorous phases without explicit ownership are not parallel eligible.

## Execution coordinator and provider contract

The provider-neutral contract is defined by `ExecutionProvider`:

- `capabilities()`;
- `dispatch(input)`;
- `getStatus(handle)`;
- `collectResult(handle)`;
- `cancel(handle, reason)`.

The `ExecutionCoordinator` is the single deterministic control layer for provider-driven phase work. It:

1. reads current workflow state;
2. asks the scheduler for dispatchable phases;
3. honours `execution.maxParallelPhases` and ownership conflicts;
4. acquires phase leases;
5. creates assigned phase worktrees;
6. dispatches workers through a provider;
7. persists execution handles and status;
8. polls workers and refreshes healthy leases;
9. applies timeout, heartbeat, cancellation, and recovery policy;
10. collects structured results;
11. persists validation and completion evidence;
12. invokes the deterministic completion gate;
13. creates an internal transfer commit only after the gate passes;
14. integrates accepted phases in dependency order;
15. runs combined validation against the current integration head;
16. advances to final integrated review only when all required conditions pass.

Provider results are evidence, not authority. Process exit alone cannot complete a phase.

Current providers:

- `scripted` — deterministic provider used by disposable real-Git tests; supports success, failure, malformed evidence, timeout, heartbeat loss, unexpected file changes, and other recovery scenarios.
- `claude-cli` — prototype provider using authenticated Claude Code CLI print mode inside the assigned phase worktree. It requests structured output, persists bounded diagnostic artifacts, supports polling and cancellation, and never commits, pushes, merges, or deploys.

Manual execution remains an explicit fallback. In manual mode, the active coding session may edit only inside the assigned phase workspace and must submit persisted completion evidence.

## Completion gates

A phase lifecycle is:

```text
planned
→ ready
→ leased / running
→ completion_pending
→ completed | needs_repair | needs_review | needs_replan | blocked
```

The completion gate checks:

- required criterion evidence;
- validation presence, exit status, and permitted skip reasons;
- dependency state;
- changed files and Git evidence;
- scope deviations and expected areas;
- high-risk paths and newly detected risk triggers;
- public contracts, migrations, and new dependencies;
- remaining risks;
- repair budgets;
- active lease and workspace identity.

The gate returns one of:

| Decision | Meaning |
|---|---|
| `completed` | Evidence and validation satisfy the approved phase contract. |
| `needs_repair` | A bounded repair can address incomplete or failed work. |
| `needs_review` | Evidence is ambiguous or specialist judgement is required. |
| `needs_replan` | Scope, assumptions, contracts, or dependencies materially changed. |
| `blocked` | Safe progress requires external action or a repair budget is exhausted. |

Dependent phases unlock only after the prerequisite gate returns `completed`.

## Git workspace and integration architecture

Workspace setup runs a real Git preflight and records the canonical repository root, frozen base commit, original branch or detached-HEAD state, worktree support, active Git operations, and workspace-root safety.

The default workspace root is outside the source tree:

```text
<repository-parent>/.leanrigor-worktrees/<repository-name>/<workflow-id>/
```

Each workflow has one integration worktree and branch:

```text
leanrigor/<workflow-short-id>/integration
```

Each active phase may have one isolated phase worktree and branch:

```text
leanrigor/<workflow-short-id>/<phase-id>
```

Names are sanitized, bounded, persisted, collision-checked, and coupled to ownership metadata. LeanRigor never deletes a worktree merely because its path or branch resembles a LeanRigor name.

After a completion gate passes, LeanRigor records changed and relevant untracked files, diff hash, binary and file-mode indicators, workspace identity, base commit, and workspace head. It then creates an internal mechanical commit on the LeanRigor-owned phase branch.

Integration cherry-picks accepted phase commits into the integration worktree in dependency order. Textual conflicts are persisted and left for explicit repair. LeanRigor does not choose `ours` or `theirs`, rebase the user's branch, touch the user's index or stash, or push any branch.

Combined validation runs with the integration worktree as `cwd` and is valid only for the recorded integration head. Final integrated review requires all completed phases to be integrated and the current integration head to have passing combined validation.

## Configuration hierarchy

LeanRigor separates committed team policy from personal and local provider choices:

| Layer | Location | Purpose |
|---|---|---|
| User preferences | `~/.config/leanrigor/config.json` | Personal defaults and concrete model choices. |
| Repository policy | `leanrigor.config.json` | Committed safety policy, portable routing requirements, and team constraints. |
| Local overrides | `.leanrigor/config.json` | Private repository-specific settings and concrete provider values. |
| Runtime state | `.leanrigor/workflows/` | Persisted workflows and audit evidence. |

The central resolver applies:

```text
built-in defaults
→ adapter-derived defaults
→ user preferences
→ committed repository policy
→ local configuration
→ repository-policy constraints re-applied
```

Repository policy minimums, mandatory gates, and caps cannot be weakened by personal or local settings. Repository policy uses portable model tiers; adapters and personal configuration resolve them to provider-specific models. Claude aliases may also resolve through the standard `ANTHROPIC_DEFAULT_*` environment variables.

## Claude Code integration boundary

LeanRigor ships two Claude Code integration paths.

### Marketplace plugin

```text
Repository root
  ├── .claude-plugin/     marketplace and plugin manifests
  ├── commands/           namespaced marketplace commands
  ├── agents/             read-only triage agent
  ├── plugin-skills/      shared workflow skill
  ├── methodology/        engineering methodology and mode overlays
  ├── internal-skills/    non-discovered workflow references
  ├── hooks/              plugin hooks and Git protection
  ├── bin/                launcher
  └── runtime/            bundled CLI runtime
```

Marketplace installation is global to Claude Code. The plugin runtime auto-bootstraps repository-local LeanRigor state on first use. It does not install project-local command files into the target repository.

### Project-local fallback

Source or future npm installation can run:

```bash
leanrigor init --adapter claude --root /path/to/repository
```

This installs LeanRigor-owned `.claude/` commands, agent, methodology references, hook script, and shared settings entries. Installation is repeat-safe, preserves unrelated files and settings, and replaces modified LeanRigor-owned files only when explicitly requested.

## Engineering methodology

Shared methodology lives under `methodology/`:

- `core.md` — universal principles and deterministic/prompt boundary;
- `planning.md`, `design.md`, `implementation.md`, `debugging.md`, `testing.md`, `review.md`, `evidence.md`, and `safeguards.md` — composable step guidance;
- `modes/fast.md`, `modes/standard.md`, and `modes/rigorous.md` — proportional depth overlays.

The workflow loads the core methodology, the selected mode overlay, and only the domain files relevant to the current step. Methodology improves semantic quality; deterministic state and gates remain authoritative.

## Safety boundaries

LeanRigor does not automatically:

- create the final user commit;
- push;
- deploy;
- perform destructive production writes;
- resolve textual conflicts through `ours` or `theirs`;
- persist hidden chain of thought.

Internal commits are allowed only on LeanRigor-owned branches for controlled transfer and validation. User approvals remain explicit where required.

## Current limitations and roadmap

Implemented but experimental or not yet stable as a broad user-facing capability:

- Claude CLI provider execution;
- provider-driven higher parallelism;
- marketplace hook behaviour across all Claude Code versions and operating systems.

Planned:

1. native Claude phase-worker/subagent orchestration;
2. semantic conflict-repair workflow;
3. additional provider and coding-agent adapters, including OpenCode and Codex;
4. cross-platform CI and release automation;
5. reproducible workflow-quality, latency, and token-use benchmarks.

Roadmap items must remain labelled as planned until verified in implementation and tests.
