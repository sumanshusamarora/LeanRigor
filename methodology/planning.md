<!-- generated_by: leanrigor | methodology_asset: shared -->
# Planning Methodology

A LeanRigor plan is an inspected, reviewable route to the requested outcome.
It is not a speculative file list or a ceremonial document.

## Required Plan Qualities

Include, scaled to mode:

- desired outcome;
- current behavior based on inspection;
- proposed approach;
- meaningful alternatives only when a real design choice exists;
- affected boundaries and contracts;
- acceptance criteria;
- validation strategy;
- risks and rollback considerations when relevant.

## Planner Rules

- Inspect repository guidance, relevant code paths, callers, and nearby tests
  before proposing changes.
- Distinguish facts from assumptions.
- Identify contract boundaries: public APIs, shared schemas, persistence,
  CLI/user interfaces, config, jobs, queues, and integrations.
- Avoid fake precision: do not invent files, line numbers, or call paths before
  inspecting them.
- Avoid vague phases such as "implement feature" or "update tests".
- Do not include implementation details that inspection has not supported.
- Keep phase count proportional to mode and risk.

## Mode Expectations

Fast:

- Brief inspection.
- One concise approach.
- One phase when the work is truly local.
- One direct acceptance criterion.
- Targeted validation.

Standard:

- Inspect relevant call paths and consumers.
- Identify integration boundaries.
- Split materially distinct implementation, consumer, coverage, and
  documentation outcomes.
- Include compatibility and likely failure modes.
- Include targeted tests or package/module checks.

Rigorous:

- Compare viable approaches when the choice is consequential.
- Identify migration, security, compatibility, operational, data integrity, and
  rollback concerns.
- Isolate high-risk boundaries into separate phases.
- State explicit assumptions and unknowns.
- Include deployment and recovery considerations when applicable.

## Plan Output Discipline

- Acceptance criteria must be inspectable.
- Validation commands must be runnable or explicitly explain why not.
- Public contract, migration, production, and security changes must be visible
  in the plan, not hidden inside generic implementation phases.
- If an approved assumption fails during execution, record the scope change and
  use `needs_replan` rather than continuing on an invalid plan.
