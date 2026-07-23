# LeanRigor

A first-draft, local workflow controller for applying proportional engineering discipline to AI coding tasks.

## Status

This repository is an architectural and functional draft. The TypeScript CLI now installs dependencies, type checks, builds to `dist/`, passes the Vitest suite, and has a first complete persisted sequential workflow for Claude Code. Parallel agents, isolated worktrees, OpenCode, and autonomous commit execution remain future work.

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
npm pack
npm install /path/to/leanrigor-0.1.0-draft.tgz

# Initialise a repository with Claude Code plugin assets
npx leanrigor init --adapter claude --root /path/to/repository

# Check everything is current
npx leanrigor doctor --adapter claude --root /path/to/repository

# Triage a request
npx leanrigor triage "Fix the assignment regression" --provider deterministic --root /path/to/repository

# Start the persisted sequential workflow
npx leanrigor flow start "Fix the assignment regression" --provider deterministic --root /path/to/repository
npx leanrigor flow status <workflow-id> --root /path/to/repository
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

- Triage has a deterministic fallback; model-backed triage is available through the Claude adapter when configured.
- The first complete workflow is sequential. It does not autonomously spawn coding agents.
- File leases are in-memory in the core draft.
- Worktree isolation is documented but not implemented.
- Commit planning is intentionally conservative and requires human review.

## Triage and review defaults

The Claude adapter uses the configured `small` tier—the provider-resolved `haiku` alias by default—for bounded task triage. Triage output is schema validated and then subjected to deterministic repository policy. Fast mode requires positive low-risk evidence; high-risk triggers escalate to Rigorous.

A lightweight preflight runs for every task. Standard, Rigorous, and multi-agent implementations receive automatic integrated review; Fast mode receives a final diff sanity check.

## Sequential flow

`leanrigor flow start "<request>"` creates a repository-local workflow under
`.leanrigor/workflows/`, persists triage, asks at most one blocking
clarification, gates Standard/Rigorous approach approval, requires plan
approval for every mode, unlocks one phase at a time, records validation
evidence, requires a final integrated review, and generates a commit proposal
without committing.

## Model-backed triage

`leanrigor triage` now uses the configured Claude small-model profile by default, validates the returned `TriageOutput`, applies deterministic safety policy, retries malformed output once, and falls back to local deterministic triage.

```bash
leanrigor triage "Fix the broken assignment API" --provider auto
leanrigor triage "Fix a README typo" --provider deterministic
```
