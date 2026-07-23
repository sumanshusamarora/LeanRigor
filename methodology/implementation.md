<!-- generated_by: leanrigor | methodology_asset: shared -->
# Implementation Methodology

Implementation should be small, cohesive, and compatible with the repository's
existing style.

## Rules

- Follow repository conventions, naming, formatting, and helper APIs.
- Make the smallest cohesive change that satisfies the approved phase.
- Preserve types, public contracts, and error behavior unless the plan says
  otherwise.
- Validate inputs at trust boundaries.
- Handle errors deliberately; avoid silent failure.
- Do not broadly swallow exceptions.
- Avoid hidden global state and incidental shared mutable state.
- Avoid unnecessary dependencies.
- Keep public behavior explicit.
- Update callers when a contract changes.
- Update docs when behavior visible to users, operators, or integrators changes.

## Comments

Use comments only for non-obvious intent, invariants, trade-offs, or safety
constraints. Do not add comments that merely restate the code.

## Scope Discipline

- Do not opportunistically refactor unrelated code.
- Do not change public contracts without approved plan coverage.
- Do not add dependencies without justification.
- Do not introduce migrations in a non-migration phase.
- Do not modify security or infrastructure boundaries incidentally.
- Record unexpected scope expansion immediately.
