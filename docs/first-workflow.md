# First workflow

A practical walkthrough for your first LeanRigor workflow. By the end you will have installed LeanRigor, started a task, seen mode selection and approvals, checked status, and reached a commit proposal — all without leaving Claude Code.

## 1. Install the marketplace plugin

LeanRigor ships as a Claude Code marketplace plugin. Install it once globally:

```text
/plugin marketplace add sumanshusamarora/LeanRigor
/plugin install leanrigor@leanrigor
```

That is the only installation step. LeanRigor auto-bootstraps repository-local state under `.leanrigor/` on first use. No separate `init` command, no project-local `.claude/` files, no manual configuration required for ordinary use.

> [!NOTE]
> The npm package is not yet published as a stable public package. The marketplace plugin is the recommended user installation path. See [Setup](setup.md) for source-install and project-local fallback alternatives.

Verify everything is working:

```text
/leanrigor:init
```

This reports installation mode, runtime source, configuration health, and model-tier resolution. It is safe to run any time.

## 2. Start your first task

From any Git repository, type:

```text
/leanrigor:start Fix the typo in the README
```

Replace the request with your own task. LeanRigor immediately begins a structured workflow:

1. **Triage** — classifies the task by complexity and risk, then selects a workflow mode.
2. **Mode and approvals** — presents the selected mode and any required approvals conversationally.
3. **Execution** — coordinates phased work with completion evidence.
4. **Final review and commit proposal** — presents an integrated review and a commit plan for your approval.

The entire interaction is conversational. Claude invokes LeanRigor transitions internally. You reply with plain language: `approve`, `continue`, `show status`, `revise the plan to …`, or `cancel`.

## 3. Understand mode selection

LeanRigor picks one of three workflow modes based on task complexity and explicit risk triggers:

| ⚡ Fast | 🛠️ Standard | 🛡️ Rigorous |
|---|---|---|
| Clearly bounded, low-risk changes | Normal features, fixes, and refactors | Security, migrations, public contracts, production infrastructure, concurrency, data integrity, destructive operations, and high blast radius |
| Compact plan, targeted validation, sanity review | Phased plan, explicit approval, integrated review | Explicit approach gate, isolated risk boundaries, stronger evidence, deeper review |

Fast mode requires positive evidence that the task is bounded and low risk. Rigorous mode is triggered deterministically by explicit risk categories. Standard is the default for normal engineering work.

Mode selection is **not** a suggestion. It is a persisted policy decision that governs planning depth, approval requirements, evidence gates, and review level. See [Workflow and completion gates](workflow.md) for the full lifecycle.

## 4. Respond to approvals

LeanRigor may pause at two approval gates before implementation begins:

### Approach approval (Standard and Rigorous modes)

Before a detailed plan is generated, Standard and Rigorous workflows may present an **approach summary**: the proposed strategy, primary risks, alternatives considered, validation approach, and a clear note that no implementation has started. Reply:

- `approve` — accept the approach; LeanRigor generates the phased plan.
- `revise the approach to …` — persist feedback or new constraints, then review the updated approach gate.
- `show status` / `view details` — inspect persisted triage, policy, provenance, and workflow state without changing it.
- `cancel` — cancel the workflow without starting implementation.

Fast mode skips approach approval because the task is clearly bounded.

### Plan approval (all modes)

LeanRigor presents a **phased plan**: small functional phases with dependencies, acceptance criteria, expected file areas, and validation expectations. Reply:

- `approve` — accept the plan; execution begins.
- `revise the plan to …` — provide feedback for a revised plan.
- `reject because …` — cancel the workflow with a recorded reason.

> [!IMPORTANT]
> Implementation is blocked until plan approval. LeanRigor will not edit files or create workspaces before you approve.

## 5. Check status any time

```text
/leanrigor:status
```

Status shows the current workflow: its ID, mode, lifecycle state, phase progress with acceptance criteria, recorded validation, any blockers, and the next expected action. It is safe to run at any point — during execution, between phases, or while waiting on a gate.

You can also resume a workflow after interruption. LeanRigor discovers the active workflow automatically and continues from the persisted state.

## 6. Understand evidence and completion gates

Each phase must pass a **completion gate** before the next phase can begin. The gate checks:

- Were all acceptance criteria met?
- Was declared validation run (or explicitly skipped with a reason)?
- Are changed files within the expected areas?
- Did scope deviate from the plan?
- Has the repair budget been exhausted?

Gates are **deterministic** — a provider process exiting successfully does not automatically pass a phase. LeanRigor collects the result, checks evidence and validation, and only then accepts, requests repair, requests review, requests replanning, or blocks the phase.

Outcomes:

| Gate decision | Meaning |
|---|---|
| `completed` | Phase passes; next phase or integration proceeds. |
| `needs_repair` | A bounded issue was found; repair within the repair budget. |
| `needs_review` | Deeper human review is required before proceeding. |
| `needs_replan` | The plan no longer fits; replan from this point. |
| `blocked` | External action is required before continuing. |

In Claude Code, gates are presented conversationally. Claude reports the gate decision and the next expected action.

> [!NOTE]
> **Current limitation:** Default execution is sequential (`execution.maxParallelPhases` is `1`). The scheduler and coordinator are parallel-capable, but autonomous multi-agent execution is not yet presented as a stable user-facing capability.

## 7. Final integrated review

After all phases pass their completion gates, LeanRigor requires a **final integrated review**. This review examines the combined change across all phases in the integration workspace — not individual phases in isolation. Combined validation must pass against the current integration head before the review gate opens.

In Claude Code, the review is presented conversationally: a summary of all integrated changes, validation results, any remaining risks, and a review recommendation.

## 8. Commit proposal

The workflow ends with a **commit proposal** — a summary of the integrated changes with suggested commit messages. LeanRigor presents the proposal for your review.

> [!IMPORTANT]
> LeanRigor **never** creates the final user commit or pushes to a remote. Internal mechanical commits may be created on LeanRigor-owned branches to support controlled transfer and validation, but the final commit is always yours to review and create.

LeanRigor also blocks automatic `git commit`, `git push`, and `git reset --hard` in Claude-controlled execution paths via its Git protection hook.

## Putting it all together

A typical Fast-mode conversation flows like this:

```text
You:     /leanrigor:start Fix the typo in the README
Claude:  [triage summary] Fast mode. Here is the plan: [one phase]. Approve?
You:     approve
Claude:  [executes the phase, records evidence, presents completion gate]
         Phase complete. Running final integrated review…
         [review summary]
         Commit proposal: [suggested message]. Review and commit when ready.
```

A Standard-mode conversation adds approach and plan approval:

```text
You:     /leanrigor:start Add an optional API field and update its consumer
Claude:  [triage summary] Standard mode. Approach: [strategy, risks, alternatives]. Approve?
You:     approve
Claude:  Plan: [phases with criteria and validation]. Approve?
You:     approve
Claude:  [executes phases sequentially with completion gates]
         All phases integrated. Final review: [summary]. Commit proposal: […]
```

A Rigorous-mode conversation adds an explicit approach gate with stronger evidence requirements and deeper review:

```text
You:     /leanrigor:start Add a database migration affecting authenticated production requests
Claude:  [triage summary] Rigorous mode — deterministic escalation for migration risk.
         Approach: [detailed strategy, isolated risk boundary, broader validation].
         Approve?
You:     approve
Claude:  Plan: [phases with explicit risk isolation, stronger evidence gates].
         Approve?
You:     approve
Claude:  [isolated workspace execution, completion gates, combined validation]
         Final integrated review: [deep review]. Commit proposal: […]
```

## Common patterns

### Resume an interrupted workflow

Just start Claude Code and type `/leanrigor:start` with no request. LeanRigor discovers the active workflow and resumes from the persisted state.

### Inspect without changing anything

```text
/leanrigor:status
/leanrigor:review
```

These commands are read-only. They report persisted state without advancing the workflow.

### Cancel a workflow

Reply `cancel` at any approval gate. LeanRigor records the cancellation reason. You can also cancel from the CLI if needed:

```bash
leanrigor flow cancel <workflow-id> --reason "no longer needed" --root /path/to/repo
```

## Known limitations

These limitations are current as of the latest `main` branch. They are not permanent design choices.

- **Claude Code only.** Claude Code is the only supported coding-agent adapter. OpenCode, Codex, Cursor, Copilot, and other integrations are roadmap items.
- **Sequential execution by default.** The engine supports parallel phases, but `execution.maxParallelPhases` defaults to `1`. Autonomous multi-agent execution is not yet a stable user-facing capability. Native Claude subagent orchestration is not implemented.
- **Claude CLI execution provider is a prototype.** It requires a locally authenticated Claude CLI and is not part of ordinary CI.
- **No semantic conflict repair.** Textual integration conflicts are detected and preserved for explicit repair. Semantic resolution is not implemented.
- **npm package is private.** The package is not published as a stable public package. Source installation is for development and pre-release testing.
- **Some config fields are not yet wired.** `execution.defaultProvider`, `execution.defaultMode`, `execution.verbosity`, and `paths.claudeExecutable` are schema-valid but not yet applied by the central config resolver. Use explicit CLI flags until that wiring is complete.
- **Config `minimumTiers` only applies to triage.** Planning, implementation, and review tier minimums are schema-valid but not yet enforced. Only the triage tier minimum is active.

See [Implementation status](../IMPLEMENTATION_STATUS.md) for the detailed verification inventory.

## Next steps

- [Setup and installation](setup.md) — source install, project-local assets, diagnostics, troubleshooting.
- [Workflow and completion gates](workflow.md) — full lifecycle, advanced CLI, gate mechanics.
- [Claude Code adapter](claude-code.md) — adapter architecture, installation modes, mixed-mode cleanup.
- [Configuration reference](configuration.md) — config layers, model tiers, repository policy.
- [Engineering methodology](methodology.md) — the methodology behind planning, implementation, testing, and review.
