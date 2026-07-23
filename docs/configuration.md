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

## Execution And Concurrency

- `execution.maxParallelPhases`: default `1`. Values above `1` affect ready
  phase scheduling recommendations only; LeanRigor does not spawn agents yet.
- `execution.workflowLockTimeoutSeconds`: default `30`. Short-lived persistent
  lock timeout for state mutations.
- `execution.phaseLeaseTimeoutSeconds`: default `900`. Durable phase lease
  timeout for future long-running owners.
- `execution.writeReadConflictsBlock`: default `true`. Treat write/read path
  overlap as a blocking scheduling conflict.
- `execution.sensitivePaths`: additional repository-relative path patterns that
  should conflict broadly during scheduling.

Built-in sensitive paths include package manifests and lockfiles,
`tsconfig*.json`, `.git/**`, `.github/**`, `migrations/**`, `schema/**`, and
`infra/**`.

## Methodology Relationship

Configuration and deterministic policy decide what is required. The shared
methodology under `methodology/` guides how Claude plans, implements, tests,
reviews, and records evidence for those requirements.
