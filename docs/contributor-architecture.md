# Contributor architecture

This guide is the shortest path into LeanRigor's implementation. Read it before changing workflow state, execution, Git workspaces, or provider integration.

## Core boundary

LeanRigor is the workflow and policy control plane.

It owns:

- triage, risk, and mode selection;
- planning and phase DAG generation;
- approvals and dispatch eligibility;
- ownership and conflict policy;
- evidence and completion requirements;
- integration ordering and validation requirements;
- final review, resumability, and audit state.

Execution providers own provider-specific worker launch, process lifecycle, status, cancellation, and structured results. Workspace providers may own generic Git mechanics, but LeanRigor retains safety and gate coupling.

## Important invariants

- Deterministic policy has final authority over model recommendations.
- A phase cannot complete without its completion gate.
- Failed validation blocks dependent phases.
- Combined validation must correspond to the current integration head.
- The original user working tree must remain untouched by isolated workspace execution.
- Internal mechanical commits are allowed only on LeanRigor-owned branches.
- The final user commit and any push remain explicit user actions.
- Hidden chain of thought is never persisted.

## Main implementation areas

- `src/core/flow.ts` — workflow lifecycle, schema migration, and state transitions.
- `src/core/types.ts` — persisted workflow and phase contracts.
- `src/core/scheduler.ts` — dependency and readiness scheduling.
- `src/core/workflow-store.ts` — atomic revisioned persistence.
- `src/core/workflow-lock.ts` — workflow mutation locks.
- `src/core/git-workspace.ts` — phase and integration workspace mechanics.
- `src/core/execution/` — coordinator and execution-provider contracts.
- `src/adapters/claude/` — Claude Code integration and project-local assets.
- `commands/`, `agents/`, `plugin-skills/`, `methodology/` — Claude-facing workflow and methodology assets.
- `tests/helpers/execution-harness.ts` — deterministic disposable Git test support.

## Deterministic versus prompt-owned responsibilities

Use deterministic code for state transitions, safety triggers, revision checks, leases, dependency status, validation exit codes, scope/path rules, repair budgets, and final eligibility.

Prompts may help assess semantics, propose plans, explain trade-offs, and summarise evidence. Prompts must not override deterministic blockers or narrate a workflow into a state that was not persisted.

## Adding an execution provider

A provider should implement the existing provider contract rather than modifying workflow policy. It should return structured handles, status, and results; support cancellation where possible; avoid persisting hidden reasoning; and clearly distinguish process success from phase completion.

Add deterministic provider tests before live-provider smoke testing.

## Changing workflow state

Any new state or transition should include:

- a documented reason;
- schema and migration handling;
- deterministic transition rules;
- status and resume behaviour;
- restart coverage;
- compatibility with existing workflows;
- tests preventing prompt-only state fabrication.

## Changing Git integration

Git changes require disposable real-repository tests covering the original working tree, internal branches, integration ordering, conflicts, recovery, cleanup, and no automatic final commit or push.

## Pull-request expectations

A focused pull request should explain the problem, architecture impact, deterministic and prompt-owned responsibilities, tests, smoke scenarios, compatibility, documentation changes, README feature-inventory impact, and remaining limitations.
