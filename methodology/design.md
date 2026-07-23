<!-- generated_by: leanrigor | methodology_asset: shared -->
# Design Methodology

Use design guidance when the task changes architecture, boundaries, contracts,
data flow, persistence, production behavior, or user-visible behavior with
meaningful trade-offs.

## Design Principles

- Fit the existing architecture before adding a new abstraction.
- Keep ownership and responsibility clear.
- Define explicit interfaces and contracts.
- Preserve backward compatibility where consumers depend on it, or version the
  change deliberately.
- Prefer simple designs over speculative extensibility.
- Separate policy from mechanism when it reduces coupling or clarifies safety.
- Add an abstraction only when it removes real complexity, reduces meaningful
  duplication, or establishes a necessary boundary.

## Design-Heavy Work Should Record

- context and current behavior;
- constraints and non-goals;
- chosen design;
- alternatives considered and why they were not chosen;
- trade-offs;
- failure modes;
- observability;
- migration or rollout path;
- test strategy.

## Proportionality

Fast mode does not need a design document for typo fixes, local copy changes,
or obvious one-file corrections. Standard mode should record the design in the
approach or plan when behavior spans boundaries. Rigorous mode should make the
high-risk boundary explicit before implementation.
