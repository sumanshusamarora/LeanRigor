# LeanRigor

A first-draft, local workflow controller for applying proportional engineering discipline to AI coding tasks.

## Status

This repository is an architectural and functional draft. The core primitives are executable and tested. Claude Code integration is scaffolded; production-grade agent dispatch and isolated worktrees are future work.

## Principles

- Cheap automatic triage by default.
- Fast, Standard, and Rigorous workflows.
- Capability-based model routing instead of vendor coupling.
- Blocking questions only, one at a time.
- Explicit execution DAG and file ownership.
- Targeted validation.
- Commit preparation without automatic commit.

## Quick start

```bash
npm install
npm run build
node dist/src/cli/index.js setup --root /path/to/repository
node dist/src/cli/index.js triage "Fix the assignment regression" --root /path/to/repository
node dist/src/cli/index.js doctor --root /path/to/repository
```

## Documents

- [Product rationale](PRODUCT.md)
- [Architecture](ARCHITECTURE.md)
- [Workflow](docs/workflow.md)
- [Claude Code adapter](docs/claude-code.md)
- [Setup](docs/setup.md)
- [Model routing](docs/model-routing.md)
- [OpenCode roadmap](docs/opencode-roadmap.md)

## Deliberate limitations

- Triage currently has a deterministic fallback; live model invocation belongs in the harness adapter.
- Parallel execution interfaces exist, but the first draft does not autonomously spawn coding agents.
- File leases are in-memory in the core draft.
- Worktree isolation is documented but not implemented.
- Commit planning is intentionally conservative and requires human review.

## Triage and review defaults

The Claude adapter uses the configured `small` tier—the provider-resolved `haiku` alias by default—for bounded task triage. Triage output is schema validated and then subjected to deterministic repository policy. Fast mode requires positive low-risk evidence; high-risk triggers escalate to Rigorous.

A lightweight preflight runs for every task. Standard, Rigorous, and multi-agent implementations receive automatic integrated review; Fast mode receives a final diff sanity check.

## Model-backed triage

`leanrigor triage` now uses the configured Claude small-model profile by default, validates the returned `TriageOutput`, applies deterministic safety policy, retries malformed output once, and falls back to local deterministic triage.

```bash
leanrigor triage "Fix the broken assignment API" --provider auto
leanrigor triage "Fix a README typo" --provider deterministic
```
