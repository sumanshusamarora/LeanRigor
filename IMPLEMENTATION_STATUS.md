# Implementation status

This document describes the current `main` branch. It distinguishes implemented behaviour from prototype integrations and roadmap work. The README provides the concise product view; this file is the detailed inventory.

## Implemented and covered by automated tests

### Adaptive workflow and policy

- Fast, Standard, and Rigorous workflow modes.
- Separate task-complexity and workflow-risk assessment.
- Model-backed triage with schema validation, one retry, deterministic policy overrides, and deterministic fallback.
- Positive evidence required before Fast mode is selected.
- Explicit high-risk triggers for migrations, security, public contracts, production infrastructure, concurrency, data integrity, destructive operations, and other high-blast-radius work.
- At most one blocking clarification at a time.
- Explicit approach and plan approval where required.
- Portable model tiers: `small`, `medium`, `large`, and `inherit`.
- User model mappings and selected execution preferences, committed repository policy, local configuration, provenance reporting, and enforced policy constraints that cannot be weakened by personal or local settings.

### Persisted workflow state

- Versioned workflows under `.leanrigor/workflows/<workflow-id>.json`.
- Atomic writes, monotonic revisions, persistent workflow locks, schema validation, corruption errors, and explicit revision conflicts.
- Persisted triage, assumptions, approvals, phase DAG, evidence, validation, repairs, integration, final review, and commit proposal.
- Safe active-workflow discovery, resume, cancellation, and restart recovery.

### Planning and completion gates

- Small functional phases with stable IDs, dependencies, acceptance criteria, expected read/write areas, and validation expectations.
- Dependency-derived ready scheduling and conservative ownership-conflict checks.
- Durable phase leases, heartbeats, expiry, release, and stale-lease recovery.
- Structured completion evidence for each acceptance criterion, changed files, validation, scope deviations, assumptions, and remaining risks.
- Deterministic gate outcomes: `completed`, `needs_repair`, `needs_review`, `needs_replan`, or `blocked`.
- Failed or missing validation, missing evidence, unmet criteria, incompatible scope, dependency state, repair budgets, and sensitive-path triggers override optimistic provider or model claims.
- Bounded phase and integrated-review repair loops.

### Git workspaces and integration

- Git preflight for repository suitability and operation-in-progress safety.
- One LeanRigor-owned integration worktree per workflow.
- Isolated phase worktrees and branches tied to active leases.
- Frozen workflow base commit and controlled dependency-aware phase bases.
- Git evidence capture including changed and relevant untracked files, diff hash, binary indicators, file-mode changes, workspace identity, and heads.
- Internal mechanical phase commits only after completion gates pass.
- Dependency-ordered integration through controlled cherry-pick.
- Idempotent already-integrated handling and persisted textual-conflict metadata.
- Combined validation tied to the current integration head.
- Final integrated review eligibility only after accepted phases are integrated and combined validation passes.
- Conservative recovery and cleanup that preserve dirty, conflicted, unintegrated, or ownership-uncertain workspaces.
- The original user branch, index, unstaged files, untracked files, stash, and checkout are not modified by workspace operations.

### Execution coordinator and providers

- Provider-neutral `ExecutionProvider` contract with capabilities, dispatch, status, result collection, and cancellation.
- `ExecutionCoordinator` for dispatch eligibility, leases, worktree assignment, provider lifecycle, heartbeat, timeout, cancellation, result collection, completion gates, integration, combined validation, and final-review progression.
- Persisted execution records and bounded provider diagnostics without hidden reasoning.
- Deterministic scripted provider and disposable real-Git execution harness.
- `execute-next`, `execute-ready`, `execution-status`, `execution-poll`, `execution-cancel`, and recovery commands.
- Provider process success alone never marks a phase complete.

### Claude Code integration

- Native marketplace packaging and global namespaced commands:
  - `/leanrigor:start`
  - `/leanrigor:init`
  - `/leanrigor:plan`
  - `/leanrigor:status`
  - `/leanrigor:review`
  - `/leanrigor:commit`
- Bundled runtime invoked through `${CLAUDE_PLUGIN_ROOT}`.
- Marketplace auto-bootstrap of repository-local `.leanrigor/` state without installing command files into the target repository's `.claude/` directory.
- Read-only triage agent and shared adaptive engineering methodology.
- Project-local fallback assets for development and pre-release testing.
- Repeat-safe installation, content-equality adoption, modified-file preservation, shared-settings merge, owned-file repair, and conservative uninstall.
- Git protection hook for Claude-controlled `git commit`, `git push`, and `git reset --hard` attempts.
- Installation, version, configuration, model-resolution, hook, bootstrap, and shadowing diagnostics.

### Packaging and repository checks

Repository CI is configured to run:

- clean dependency installation;
- TypeScript type checking;
- Vitest;
- ESLint;
- production and marketplace-plugin builds;
- plugin-version-bump checks;
- strict plugin validation when available;
- diff whitespace checks;
- marketplace runtime auto-bootstrap smoke;
- npm package-content inspection.

## Implemented but prototype or environment-dependent

### Claude CLI execution provider

The `claude-cli` provider is implemented as a prototype. It:

- launches authenticated Claude Code CLI print mode in the assigned phase worktree;
- requests schema-constrained structured output;
- persists bounded status, stdout, and stderr artifacts under `.leanrigor/executions/`;
- supports restartable polling, timeout, cancellation, and diagnostics;
- submits results to LeanRigor's completion and integration gates.

Live verification requires a locally authenticated Claude CLI and is intentionally not part of ordinary CI. The repository provides `scripts/smoke-claude-cli-execution.sh` for this path.

### Marketplace runtime behaviour

Packaging, command assets, bootstrap, hooks, and workflow contracts are covered by automated checks. Some behaviour still depends on the installed Claude Code runtime, including command-cache refresh and live hook firing after marketplace updates. These paths require periodic real-Claude smoke testing.

### Parallel coordinator execution

The scheduler, leases, ownership checks, coordinator, and provider contract support more than one eligible phase when configured. Default `execution.maxParallelPhases` remains `1`.

Higher parallelism is not yet promoted as a stable autonomous multi-agent Claude experience. Native Claude subagent orchestration is not implemented.

## Current limitations

- The user-config schema currently accepts `execution.defaultProvider`, `execution.defaultMode`, `execution.verbosity`, and `paths.claudeExecutable`, but the central effective-config resolver does not yet apply those fields. Use explicit provider/command options until that wiring is implemented.
- Repository-policy `minimumTiers` enforcement currently applies to triage. Other workflow stages should use committed `routing` requirements; `minimumTiers.planning`, `minimumTiers.implementation`, `minimumTiers.review`, and `modelFallback` are schema-valid but not yet applied by the central merger.
- Claude Code is the only supported coding-agent adapter.
- The npm package is private and unpublished; source installation is for development and pre-release testing.
- Native Claude subagent orchestration is not implemented.
- Semantic conflict repair is not implemented; textual conflicts are detected and preserved for explicit repair.
- OpenCode, Codex, Cursor, Copilot, and other adapters are not implemented.
- Methodology and model-assisted semantic judgement improve evidence quality but are not formal proofs.
- LeanRigor does not provide a complete security audit or remove the need for human review.

## Roadmap

Near-term themes are:

1. native Claude phase-worker orchestration;
2. integrated semantic conflict repair;
3. additional execution-provider and coding-agent adapters;
4. cross-platform CI and release automation;
5. reproducible workflow-quality, latency, and token-use benchmarks.

Roadmap functionality must remain labelled as planned until verified in code and tests.
