<!-- generated_by: leanrigor | methodology_asset: shared -->
# Testing Methodology

Tests should prove behavior and contracts, not implementation trivia.

## Universal Rules

- Test changed behavior, changed contracts, and regressions.
- Prefer deterministic tests.
- Avoid meaningless snapshots.
- Do not claim tests passed unless they were run and the result is known.
- Document skipped checks with the reason and remaining risk.
- When no automated test is practical, explain why, provide manual evidence,
  and mark the residual risk.

## Mode Expectations

Fast:

- Run the smallest relevant automated command.
- Use syntax, type, diff, or focused runtime sanity checks where appropriate.
- A skipped check may be acceptable only with a concrete reason.

Standard:

- Run targeted unit or integration tests for the changed behavior.
- Cover changed error paths and representative edge cases.
- Run package or module validation when available and reasonably scoped.

Rigorous:

- Run broader integration coverage.
- Include migration and compatibility tests when relevant.
- Include security and failure-path tests when relevant.
- Check concurrency, idempotency, or recovery behavior when relevant.
- Verify rollback or forward-fix paths for operational changes when practical.

## Test Selection

- Prefer a focused regression test over an unrelated broad suite.
- Run broader suites when the change affects shared behavior or multiple
  consumers.
- A broad suite is weak evidence if it does not exercise the changed behavior.
