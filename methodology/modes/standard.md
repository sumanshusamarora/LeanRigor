<!-- generated_by: leanrigor | methodology_asset: shared -->
# Standard Mode Overlay

Principle: Use disciplined engineering defaults for behavioral or cross-file
changes.

Minimum method:

- Inspect relevant call paths, current behavior, callers, consumers, and nearby
  tests.
- Present a cohesive plan with explicit acceptance criteria.
- Identify changed boundaries and compatibility expectations.
- Consider error and representative edge paths.
- Implement in small cohesive phases.
- Run targeted tests and package/module validation where available.
- Perform integrated review against the original request, contracts, tests,
  documentation, and scope.
- Complete with evidence, verification status, and remaining uncertainty.

Standard avoids heavy ceremony, but it should not skip planning, regression
thinking, or integrated review for behavior changes.
