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
- State acceptance requirements so their verification is observable. If an
  approved requirement is intentionally high-level, the later Phase Execution
  Brief may attach bounded verification evidence without changing that
  requirement.
- Keep phase count proportional to mode and risk.
- Treat the approved effective constraint set as authoritative. Do not
  reintroduce removed triage assumptions, and do not add work that contradicts
  an explicit user override.

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
- Include compatibility and likely failure modes unless the approved effective
  constraint set explicitly says backward compatibility is not required.
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
- If deterministic plan validation reports a constraint contradiction, repair
  only the named invalid fields while preserving valid phase content. If the
  contradiction cannot be repaired, stop before approval.

## Progressive Phase Elaboration

Workflow Plan approval does not authorize implementation. Before each phase is
approved, run only the bounded, read-only inspection allowed by the persisted
phase-brief request. Prefer approved paths, repository metadata, named issue
paths, nearby tests, and justified direct imports. Record facts and provenance,
not hidden reasoning or full provider transcripts.

The Phase Execution Brief must add inspected current behavior, a concrete
deliverable, actionable steps, exact files and symbols where supported,
separate read/write boundaries, obligations, validation, assumptions,
exclusions, risks, prior-phase context, and structured changes from the
approved Workflow Plan. Do not pass WorkflowPhase prose off as this artifact.

Deterministic quality diagnostics own eligibility. A planning provider may
repair only deficient fields within the configured attempt budget. If
inspection is unavailable, scope is unsafe, or repair remains shallow, keep the
phase blocked at preflight. Revision feedback creates a new brief revision and
supersedes the prior approval decision.

The exact approved brief is authoritative at dispatch. Dependency completion
alone is not dispatch readiness. The shared guard must also confirm current
provenance, exact approval, resolved material drift, prepared workspace
evidence, ownership safety, and the absence of a conflicting lease. Provider
input and results repeat the workflow, brief, workspace, base-commit, and
constraint identities. Any mismatch, unexpected write boundary, or material
discovery returns to review or replanning instead of being accepted as
completion.
