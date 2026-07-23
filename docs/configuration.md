# Configuration Reference

Configuration lives in `.leanrigor/config.json`. This document summarizes the
settings most relevant to methodology and safety. The schema source of truth is
`config.schema.json`.

## Workflow

- `workflow.defaultMode`: `adaptive`, `fast`, `standard`, or `rigorous`.
  `adaptive` lets triage and deterministic policy select mode.
- `workflow.allowUserOverride`: allows user-requested mode changes when they do
  not bypass mandatory safety escalation.
- `workflow.automaticTriage`: enables model-backed triage with deterministic
  fallback.

## Review And Testing

- `review.fast`: default `sanity`.
- `review.standard`: default `integrated`.
- `review.rigorous`: default `deep`.
- `review.highRiskPaths`: default `deep`; may be `specialist`.
- `testing.bugFixes`: default `regression-required`.
- `testing.publicApi`: default `contract-required`.

## Completion Gate

- `completionGate.requireEvidence`: default `true`.
- `completionGate.requireValidation`: default `true`.
- `completionGate.allowSkippedValidation.fast`: default `true`.
- `completionGate.allowSkippedValidation.standard`: default `false`.
- `completionGate.allowSkippedValidation.rigorous`: default `false`.
- `completionGate.maxRepairAttempts`: mode-specific bounded repair budget.

## Risk

- `risk.rigorousPaths`: paths that should escalate review or mode when touched.
- `risk.protectedPaths`: paths such as `.git/**`, `.env`, and `secrets/**`.

## Methodology Relationship

Configuration and deterministic policy decide what is required. The shared
methodology under `methodology/` guides how Claude plans, implements, tests,
reviews, and records evidence for those requirements.
