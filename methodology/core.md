<!-- generated_by: leanrigor | methodology_asset: shared -->
# Core Engineering Methodology

These principles apply in every LeanRigor mode. Mode overlays decide how much
depth is required; they do not remove these basics.

## Universal Principles

### Understand before changing

- Inspect relevant repository guidance, current code, nearby tests, and current
  behavior before editing.
- Identify the local contract: inputs, outputs, callers, state, errors, and
  persistence or external boundaries.
- Choose the smallest responsible change that satisfies the request.
- Do not infer architecture from filenames alone.
- Do not edit before understanding the boundary you are changing.

### Preserve intent

- Solve the requested problem, not a broader nearby problem.
- Preserve existing behavior unless the change intentionally alters it.
- Avoid unrelated cleanup and opportunistic refactors.
- Call out assumptions that affect behavior, compatibility, or validation.
- Do not silently widen scope.

### Prefer evidence over confidence

- Run the smallest relevant check that can verify the claim.
- Cite changed files, tests, command outcomes, or observed runtime behavior.
- Distinguish verified facts, reasonable inferences, and unverified claims.
- Do not claim success from inspection alone when execution is practical.

### Keep changes reviewable

- Work in cohesive phases with readable diffs.
- Keep naming, structure, and patterns consistent with the repository.
- Separate behavior changes from unrelated refactoring.
- Explain public, architectural, migration, security, or operational changes.

### Fail safely

- Preserve user data and existing work.
- Avoid destructive commands and irreversible actions.
- Require explicit approval for commits, pushes, deployments, production writes,
  data deletion, history rewriting, and secret handling.
- Surface blockers and uncertainty instead of guessing past them.

## Deterministic Versus Prompt Responsibility

The LeanRigor engine owns deterministic enforcement:

- workflow states;
- approval gates;
- completion transitions;
- validation command records and exit codes;
- evidence presence;
- scope-deviation triggers;
- repair budgets;
- mandatory risk escalation;
- no automatic commit, push, or deployment policy.

Methodology guidance owns semantic engineering quality:

- planning quality and scope judgment;
- design fit and contract reasoning;
- debugging discipline;
- test selection;
- review depth;
- evidence quality;
- risk interpretation.

Do not duplicate deterministic gate rules in every response. Use them as the
state authority and use this methodology to produce better plans, changes,
reviews, and evidence.

## Skill Activation

Load only the methodology needed for the current work:

- Always load `core.md` and `modes/<mode>.md` after the workflow mode is known.
- Load `planning.md` for approach and plan generation or plan revision.
- Load `design.md` when changing architecture, boundaries, interfaces, data
  flow, persistence, or user-visible behavior with meaningful alternatives.
- Load `implementation.md` before editing implementation files.
- Load `debugging.md` for bugs, failures, flaky behavior, or repeated failed
  repairs.
- Load `testing.md` when selecting or recording validation.
- Load `review.md` for phase review and final integrated review.
- Load `evidence.md` when submitting completion evidence or making final claims.
- Load `safeguards.md` when security, migration, data, API, privacy,
  production, infrastructure, concurrency, or destructive-operation triggers
  appear.

Avoid invoking every methodology file for every task. Use the mode and task
type to select the minimum useful set.
