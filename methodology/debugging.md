<!-- generated_by: leanrigor | methodology_asset: shared -->
# Debugging Methodology

Use this for bugs, test failures, flaky behavior, production symptoms, build
failures, failed repairs, and unexpected behavior.

## Sequence

```text
reproduce
-> observe
-> narrow
-> form hypotheses
-> test the cheapest discriminating hypothesis
-> identify root cause
-> implement minimal fix
-> add regression coverage
-> verify no adjacent regression
```

## Rules

- Gather evidence from logs, tests, traces, runtime behavior, or code paths.
- Distinguish symptom from root cause.
- Do not make speculative multi-fix changes.
- Do not perform broad refactors before the root cause is established.
- Record what was ruled out when it affects the next decision.
- If repeated fixes fail, stop and replan instead of stacking another guess.

## Mode Behavior

Fast:

- Reproduce or inspect the exact failure.
- Make the smallest targeted fix.
- Run the smallest relevant check.

Standard:

- State the current hypothesis.
- Add or update focused regression coverage where practical.
- Verify the root cause path and representative adjacent behavior.

Rigorous:

- Perform deeper causal analysis.
- Check concurrency, idempotency, state, data integrity, operational, and
  security interactions when relevant.
- Require stronger regression and failure-path evidence before completion.
