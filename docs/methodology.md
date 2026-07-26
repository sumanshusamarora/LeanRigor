# Engineering methodology

LeanRigor has a shared, adapter-neutral methodology layer under `methodology/`.

The deterministic workflow engine decides **what is required** and **whether the evidence passes**. The methodology guides a coding agent or execution worker on **how to engineer well inside those requirements**.

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

`core.md` and the selected mode overlay are loaded after the final mode is known. Other methodology files are loaded only when their domain is relevant to the current step.

## Mode differences

| Mode | Methodology intent |
|---|---|
| Fast | Brief inspection, smallest cohesive change, compact criteria, targeted validation, diff sanity. |
| Standard | Inspected approach, cohesive plan, contract/consumer awareness, targeted tests, integrated review. |
| Rigorous | Explicit assumptions, alternatives where meaningful, isolated risk boundaries, safeguards, stronger evidence, broader validation, and deep or specialist review where triggered. |

Fast is not permission to skip engineering discipline. It is permission to keep the discipline compact when positive evidence shows the work is bounded and low risk.

Rigorous adds safety depth for explicit risk boundaries. It is not permission to create vague, sprawling plans or unnecessary abstractions.

## Methodology activation

- **Planning** — approach generation, phase DAG creation, plan inspection, and revision.
- **Design** — architecture, ownership, interfaces, persistence, public behaviour, or meaningful trade-offs.
- **Implementation** — before editing implementation files in an assigned workspace.
- **Debugging** — bugs, failures, flaky behaviour, repeated repairs, or uncertain root cause.
- **Testing** — validation strategy, risk-specific checks, and evidence recording.
- **Review** — per-phase review where required and final integrated review.
- **Evidence** — completion-gate submission, validation claims, and final summaries.
- **Safeguards** — security, migration, data, API, privacy, production, infrastructure, concurrency, destructive-operation, or other high-risk triggers.

Commands and providers should load the smallest methodology set that matches the current mode and task. A Fast typo fix should not load design or migration guidance. A Rigorous public-contract migration should load the relevant safeguards and deeper validation guidance.

## Deterministic versus prompt enforcement

Deterministic code owns:

- workflow states and transitions;
- final mode and mandatory risk escalation;
- approach and plan approval gates;
- revision checks, leases, dependency status, and workspace identity;
- validation records and exit codes;
- evidence presence and required criterion status;
- scope and sensitive-path triggers;
- repair budgets;
- integration order, combined-validation identity, and final eligibility;
- no automatic final commit, push, deployment, or destructive production write.

Methodology guides:

- semantic planning quality;
- design judgement;
- debugging discipline;
- implementation quality;
- test selection;
- review depth;
- evidence quality;
- risk interpretation.

Completion gates remain the state authority. Methodology improves the content submitted to those gates but cannot override a deterministic blocker.

## Relationship to execution providers

Methodology is not tied to Claude Code. An execution provider may launch Claude CLI, a future native subagent, another coding agent, or a deterministic test worker. The provider should receive only the methodology relevant to the assigned phase and must return structured results rather than hidden reasoning.

Provider process success is not completion. LeanRigor still validates the lease, workspace, evidence, validation, scope, and completion policy.

## Evidence standard

Completion evidence should be concise and inspectable:

- the claim or acceptance criterion;
- status such as `met`, `not_met`, `uncertain`, or `not_applicable`;
- concrete evidence;
- validation command and result;
- scope deviations, assumptions, and remaining risks.

Evidence must not contain hidden chain of thought or verbose self-reflection.

## Known limits

- Methodology is prompt guidance, not a formal proof system.
- LeanRigor does not provide a complete security audit by itself.
- Live provider behaviour still requires smoke testing after material prompt, model, provider, or platform changes.
- Provider-specific tool permissions and sandbox behaviour remain external dependencies.
- Claude CLI execution is currently a prototype; native Claude subagent orchestration and additional coding-agent adapters remain roadmap items.
- Semantic merge/conflict repair is not implemented. Textual conflicts are preserved for explicit repair.
