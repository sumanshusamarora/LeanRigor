# Engineering Methodology

LeanRigor now has a shared methodology layer at `methodology/`. The workflow
engine decides how much process is required; the methodology tells Claude how
to engineer well inside that process.

## Structure

```text
methodology/
  core.md
  planning.md
  design.md
  implementation.md
  debugging.md
  testing.md
  review.md
  evidence.md
  safeguards.md
  modes/
    fast.md
    standard.md
    rigorous.md
```

`core.md` and the selected mode overlay are always loaded after the mode is
known. The other files are loaded only when their domain is relevant.

## Mode Differences

| Mode | Methodology intent |
|---|---|
| Fast | Brief inspection, smallest change, one clear criterion, targeted validation, diff sanity. |
| Standard | Inspected approach, cohesive plan, contract/consumer awareness, targeted tests, integrated review. |
| Rigorous | Explicit assumptions, alternatives where meaningful, isolated risk boundaries, safeguards, stronger evidence, deep or specialist review. |

Fast remains lightweight. It should not create design documents or unnecessary
alternatives for typo-level work. Rigorous adds safety depth for high-risk
boundaries; it is not a license for vague or sprawling plans.

## Skill Activation

- Planning methodology: approach generation, plan creation, and plan revision.
- Design methodology: architecture, ownership, interfaces, persistence, or
  user-visible behavior with trade-offs.
- Implementation methodology: before editing implementation files.
- Debugging methodology: bugs, failures, flaky behavior, and repeated repairs.
- Testing methodology: validation strategy and evidence recording.
- Review methodology: phase review and final integrated review.
- Evidence methodology: completion gate submission and final claims.
- Safeguards methodology: security, migration, data, API, privacy, production,
  infrastructure, concurrency, or destructive-operation triggers.

Commands should not load every methodology file by default. Load the smallest
set that matches the current mode and task.

## Deterministic Versus Prompt Enforcement

Deterministic engine owns:

- workflow states and transitions;
- approach and plan approval gates;
- validation records and exit codes;
- evidence presence;
- scope-deviation triggers;
- repair budgets;
- mandatory risk escalation;
- no automatic commit, push, or deployment policy.

Methodology guides:

- semantic planning quality;
- design judgment;
- debugging discipline;
- test selection;
- review depth;
- evidence quality;
- risk interpretation.

Completion gates remain the state authority. Methodology improves the content
Claude submits to those gates.

## Known Limits

- Methodology is prompt guidance, not a formal proof system.
- LeanRigor does not provide a complete security audit by itself.
- Real Claude behavior must still be smoke-tested after prompt changes.
- Parallel agent dispatch, worktrees, OpenCode, Codex, and CodeGraph remain
  backlog items, not part of this iteration. Workflow locks, phase leases, and
  conflict-aware scheduling are implemented as the concurrency foundation.
