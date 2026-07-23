# LeanRigor

## Why this exists

AI coding workflows tend to be either fast but under-structured, or highly disciplined but expensive and slow. This project applies the minimum sufficient engineering discipline for each task.

The product goal is to preserve most of the quality benefits of structured AI development while reducing planning overhead, time to first code change, and total token consumption.

## Product thesis

Rigor should be selected based on risk and complexity, not imposed as a universal ritual.

The workflow:

1. Classifies the request using a low-cost model.
2. Inspects only the repository context needed to make a safe decision.
3. Selects Fast, Standard, or Rigorous mode.
4. Asks only blocking questions, one at a time.
5. Creates a proportional execution graph.
6. Parallelises only file-independent work.
7. Validates according to blast radius.
8. Proposes cohesive commits without committing automatically.

## Core principles

- Automatic adaptive triage by default.
- Complexity and workflow rigor are separate dimensions.
- Small models classify and perform narrow discovery.
- Stronger models are reserved for architecture, high-risk implementation, and high-risk review.
- Repository policy and user preferences are configurable.
- No silent commit, push, deployment, destructive migration, or production write.
- The framework itself must not become the ceremony it is designed to remove.

## Initial scope

The first draft provides a TypeScript core, configuration schema, deterministic assessment fallback, execution DAG, file ownership registry, validation and commit-planning primitives, Claude Code scaffolding, setup and doctor commands, tests, and documentation.

OpenCode is an intended adapter, not part of the initial implementation.
