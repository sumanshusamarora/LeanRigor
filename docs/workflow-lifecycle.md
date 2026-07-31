# LeanRigor Workflow Lifecycle — End-to-End Flow

This document maps every state, transition, gate, and recovery path in the
LeanRigor workflow engine. It's kept in sync with `src/core/flow.ts` and
`src/core/execution/coordinator.ts`.

## Workflow Lifecycle State Machine

```mermaid
stateDiagram-v2
    direction LR

    [*] --> created: flow start

    created --> triaging: auto-triage runs
    triaging --> awaiting_clarification: model needs answer
    triaging --> planning: triage complete, approach auto-approved
    triaging --> awaiting_approach_approval: approach needs approval

    awaiting_clarification --> triaging: user answer recorded
    awaiting_clarification --> cancelled: cancel

    awaiting_approach_approval --> planning: approve-approach
    awaiting_approach_approval --> triaging: revise-approach
    awaiting_approach_approval --> cancelled: cancel

    planning --> awaiting_plan_approval: plan generated
    planning --> blocked: planning fallback review needed

    awaiting_plan_approval --> executing: approve-plan
    awaiting_plan_approval --> planning: revise-plan
    awaiting_plan_approval --> cancelled: cancel

    blocked --> planning: retry-planning
    blocked --> cancelled: cancel

    executing --> validating: all phases completed
    executing --> blocked: phase blocked

    validating --> reviewing: final integrated validation passed
    validating --> blocked: validation failed

    reviewing --> awaiting_commit_approval: final integrated review recorded
    reviewing --> cancelled: cancel

    awaiting_commit_approval --> completed: complete-workflow
    awaiting_commit_approval --> cancelled: cancel

    completed --> [*]
    cancelled --> [*]
```

## Phase Lifecycle (within `executing`)

```mermaid
stateDiagram-v2
    direction TB

    planned --> ready: dependencies completed + brief approved
    ready --> leased: dispatch eligibility confirmed
    leased --> running: provider session started
    running --> completion_pending: provider returned result

    completion_pending --> completed: gate passed ★

    completion_pending --> needs_repair: criterion not met / validation failed
    completion_pending --> needs_review: contradictory evidence / high-risk scope / uncertain
    completion_pending --> needs_replan: material scope deviation
    completion_pending --> blocked: explicitly blocked by provider

    needs_repair --> ready: repair accepted, phase retried
    needs_repair --> needs_replan: repair failed too many times
    needs_repair --> blocked: repair escalation

    needs_review --> ready: review passed, phase accepted
    needs_review --> needs_replan: review rejected

    needs_replan --> planned: plan revised, brief regenerated

    blocked --> ready: user recovery action
    blocked --> needs_replan: plan revision needed

    completed --> [*]: phase integrated into workspace
```

## Completion Gate Decision Tree

```mermaid
flowchart TD
    GATE["Phase Completion Gate
    (decideCompletionGate)"] --> DISABLED{"Gate disabled
    by config?"}
    DISABLED -->|yes| COMPLETED["✓ completed"]
    DISABLED -->|no| BLOCKED{"blockedReason
    provided?"}

    BLOCKED -->|yes| BLOCK["✗ blocked"]
    BLOCKED -->|no| CONTRADICT{"contradictory
    evidence?"}

    CONTRADICT -->|yes| REVIEW["⚠ needs_review"]
    CONTRADICT -->|no| MATERIAL{"material scope
    deviation?"}

    MATERIAL -->|yes| REPLAN["✗ needs_replan
    (e.g. file outside approved write areas)"]
    MATERIAL -->|no| HIGHRISK{"high-risk scope
    deviation?"}

    HIGHRISK -->|yes| REVIEW2["⚠ needs_review
    (e.g. sensitive path touched)"]
    HIGHRISK -->|no| NOTMET{"criterion
    not_met?"}

    NOTMET -->|yes| REPAIR["↻ needs_repair"]
    NOTMET -->|no| VALFAILED{"validation
    failed?"}

    VALFAILED -->|yes| REPAIR2["↻ needs_repair"]
    VALFAILED -->|no| VALMISSING{"validation
    missing?"}

    VALMISSING -->|yes| REPAIR3["↻ needs_repair"]
    VALMISSING -->|no| UNCERTAIN{"criterion
    uncertain?"}

    UNCERTAIN -->|yes| REVIEW3["⚠ needs_review"]
    UNCERTAIN -->|no| NOEVID{"evidence missing
    for met criterion?"}

    NOEVID -->|yes| REVIEW4["⚠ needs_review"]
    NOEVID -->|no| CRITICAL{"critical
    remaining risk?"}

    CRITICAL -->|yes| REVIEW5["⚠ needs_review"]
    CRITICAL -->|no| COMPLETED2["✓ completed"]
```

## Provider Scope Violation — Recovery Paths

When the AI provider writes to a file outside the approved `writeAreas` in the
phase brief, the system classifies the unexpected write by risk tier and
applies proportional handling:

```mermaid
flowchart TD
    PROVIDER["Provider returns result"] --> CHECK{"All changed files
    within approved write areas?"}

    CHECK -->|yes| CONTINUE["Continue to completion gate"]
    CHECK -->|no| CLASSIFY["Classify each unexpected
    write by risk tier"]

    CLASSIFY --> AUTOLOW{"All writes are
    low-risk?"}
    AUTOLOW -->|"yes (build artifacts,
    lockfiles, new test files,
    documentation)"| AUTO["SystemPolicy auto-accept:
    recorded as acceptedDrifts,
    phase retries with
    expanded scope"]

    AUTOLOW -->|no| AUTOTEST{"All writes are bounded
    test artifacts + brief
    requires test writes?"}
    AUTOTEST -->|yes| AUTOTEST_ACCEPT["SystemPolicy auto-accept
    (bounded-test-artifact policy)"]

    AUTOTEST -->|no| HIGHCHECK{"Any high-risk
    (security, migration,
    API contract)?"}
    HIGHCHECK -->|yes| BLOCK["Block with
    provider_scope_violation.
    Options: discard, revise-plan,
    cancel-workflow"]

    HIGHCHECK -->|no| MEDIUM["Medium-risk files only.
    Quarantine with
    provider_scope_violation.
    Options:"]

    MEDIUM --> ACCEPT_OPT["★ accept-out-of-scope-and-continue
    (NEW) — Accepts the extra writes
    as user-approved drifts and
    continues with expanded scope"]

    MEDIUM --> DISCARD["discard-out-of-scope-and-retry
    — Discards out-of-scope files,
    preserves approved work, retries"]

    MEDIUM --> REVISE_BRIEF["revise-phase-brief
    — User adds files to approved paths"]

    MEDIUM --> REVISE_PLAN["revise-plan — Full plan revision"]

    ACCEPT_OPT --> PROVIDER
    AUTO --> PROVIDER
    AUTOTEST_ACCEPT --> PROVIDER
    DISCARD --> PROVIDER
```

### Risk Classification

| Risk Tier | Examples | Handling |
|-----------|----------|----------|
| **Low** | Build artifacts (`dist/`, `runtime/`), lockfiles, new test files, docs, generated `.d.ts`/`.map` files | **Auto-accepted** by system policy — recorded as `acceptedDrifts` |
| **Medium** | Config files (`.json`, `.yaml`), non-test source files | **User can accept** with one click (`accept-out-of-scope-and-continue`) or discard |
| **High** | Migrations, API schemas, auth/security paths, production config | **Blocked** — requires plan revision |

### Recovery Actions

| Action | Effect | When Available |
|--------|--------|----------------|
| `accept-out-of-scope-and-continue` ★ NEW | Records extra writes as user-approved drifts, continues | Medium-risk files only |
| `discard-out-of-scope-and-retry` | Reverts extra files, preserves approved work, retries | Any unexpected writes |
| `revise-phase-brief` | User provides feedback, brief is regenerated | Always |
| `revise-plan` | Full replan | Always |
| `cancel-workflow` | Give up | Always |

### Automatic Low-Risk Acceptance

Files in these categories are **automatically accepted** without any user
intervention, matching the principle that build artifacts and side-effect
files that change as a natural consequence of implementation should not
block forward progress:

- **Build output directories**: `dist/**`, `build/**`, `runtime/**`, `.next/**`, `coverage/**`, `__pycache__/**`, `target/**`
- **Lockfiles**: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, etc.
- **New test files** in `tests/` or `__tests__/` directories (untracked additions)
- **Documentation**: `docs/**`, `.md`, `.mdx`, `.rst` files
- **Generated code**: `.d.ts`, `.map`, `.min.js`, `.min.css` files

These are recorded as `acceptedDrifts` with `acceptedBy: "system-policy"` and
do not trigger the execution-recovery decision.

## Integration & Validation Flow

```mermaid
flowchart TD
    PHASE_DONE["Phase completed"] --> INTEGRATE["integratePhase()
    Cherry-pick phase commit
    into integration worktree"]

    INTEGRATE --> INT_OK{"Integration
    succeeded?"}
    INT_OK -->|yes| NEXT["Next phase ready
    or all phases done"]
    INT_OK -->|no| CONFLICT["integration-conflict
    decision → user resolves"]

    NEXT --> ALL_DONE{"All phases
    completed?"}
    ALL_DONE -->|no| NEXT_PHASE["Next phase brief +
    approval + execution"]
    ALL_DONE -->|yes| VALIDATE["Final integration
    validation"]

    VALIDATE --> VAL_OK{"Validation
    passed?"}
    VAL_OK -->|yes| REVIEW["Final integrated review"]
    VAL_OK -->|no| REPAIR_VAL["Repair validation"]

    REVIEW --> COMMIT_APPROVAL["awaiting_commit_approval"]
    COMMIT_APPROVAL --> COMPLETE["completed"]
```

## Key Data Structures

### Phase Execution Brief (`PhaseExecutionBrief`)

The contract between the plan and the provider. Defines:

| Field | Purpose |
|-------|---------|
| `writeAreas` | **The approved file patterns the provider may modify** |
| `readAreas` | File patterns the provider may read |
| `testObligations` | Tests the provider is expected to write |
| `acceptanceCriteria` | Success conditions for the phase |
| `validationCommands` | Commands to verify the phase |
| `exclusions` | Explicitly excluded files/areas |
| `assumptions` | What the brief assumes |
| `materialChangesFromWorkflowPlan` | Drifts from the original plan |

### Scope Deviation Detection (`detectScopeDeviations`)

Flags these categories of out-of-scope changes:

```typescript
// All of these produce "needs_replan":
"changed file outside expected scope: <file>"
"production dependency or package manifest changed outside approved phase scope: <file>"
"migration introduced outside approved phase scope: <file>"
"public contract changed outside approved phase scope: <file>"
"scope deviation: '<file>' classified as <type>. Phase expected documentation changes only."

// This produces "needs_review":
"sensitive path touched by non-rigorous phase: <file>"
```

### Accepted Drifts (`PhaseDriftAcceptance`)

When drift is explicitly accepted (by user or system policy):

```typescript
interface PhaseDriftAcceptance {
  decisionId: string;
  acceptedAt: string;
  acceptedBy: "user" | "system-policy";  // system-policy = automatic
  briefRevision: number;
  reason: string;
  materialChanges: MaterialPlanChange[];
}
```

System-policy drifts expand `approvedWriteAreas()` without user intervention.
Currently only used for bounded test artifacts.

## Configuration Gates That Affect Blocking

From `leanrigor.config.json` / defaults:

| Key | Default | Effect |
|-----|---------|--------|
| `completionGate.enabled` | `true` | When `false`, skips the gate for fully-met criteria |
| `completionGate.requireEvidence` | `true` | When `false`, doesn't block on missing evidence |
| `completionGate.requireValidation` | `true` | When `false`, doesn't block on missing validation |
| `completionGate.allowSkippedValidation.fast` | `true` | Fast mode tolerates skipped validation |
| `completionGate.allowSkippedValidation.standard` | `false` | Standard mode does not |
| `completionGate.maxRepairAttempts.fast` | `1` | Max repair attempts before escalation |
| `completionGate.maxRepairAttempts.standard` | `2` | |
| `execution.sensitivePaths` | `[]` | Extra paths that trigger review on touch |

## Summary of Recommendations

1. **Add an "accept-and-continue" recovery path** for scope violations on non-critical
   files (build artifacts, generated files, lockfiles). Classify files by risk tier
   and auto-accept low-risk ones.

2. **Expand automatic drift acceptance** beyond just test artifacts. Build artifacts
   (`dist/`, `runtime/`, etc.) and dependency manifests that change as a natural
   consequence of the implementation should not require manual intervention.

3. **Simplify the revise-phase-brief UX**. Instead of requiring the user to craft
   freeform feedback, present a structured choice: "Add these files to approved
   write areas?" with explicit file list and accept/reject per file.

4. **Make the completion gate configurable per-file-pattern**. Let repos declare
   patterns that are always auto-accepted (e.g., `runtime/**`, `dist/**`).
