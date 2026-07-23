# Architecture

## Layering

The project is split into three layers:

1. **Workflow specification** — skills, policies, prompts, and schemas.
2. **Orchestration core** — workflow state, assessment, DAG scheduling, file ownership, validation, Git and commit planning.
3. **Harness adapters** — Claude Code first; OpenCode later.

The core never selects vendor-specific model names. It selects capability profiles:

- `small`
- `medium`
- `large`
- `inherit`

Adapters resolve these profiles to actual models.

## Model routing

Automatic triage is enabled by default. For Claude Code, the default `small` profile resolves to `haiku`. The triage agent is isolated and read-only; it does not replace the model selected for the main session.

Default stage routing:

| Stage | Profile |
|---|---|
| Triage | small |
| Narrow repository inspection | small |
| Blocking-question identification | small |
| Fast implementation | inherit |
| Standard planning | medium |
| Standard implementation | medium |
| Rigorous planning | large |
| Rigorous implementation | large |
| Integrated review | medium |
| High-risk review | large |
| Commit planning | small |

Task complexity does not directly determine workflow rigor. A small authentication change may be rigorous; a difficult read-only investigation may remain standard.

## Configuration hierarchy

Configuration precedence is intended to be:

1. Built-in defaults.
2. User-global configuration.
3. Repository `.leanrigor/config.json`.
4. Session or command override.

The first draft implements repository configuration and an environment-variable override path. Global configuration and full merge semantics are planned.

Repository configuration should primarily hold team policy. Personal model/provider choices should eventually live in global user configuration.

## Bounded triage

The classifier receives the request, risk policy, repository metadata, changed files, detected instruction documents, and narrow search results where required. It must not scan the entire repository.

The default budget is two triage calls:

1. Initial classification.
2. One context-enrichment call if required.

If uncertainty remains, the safer adjacent workflow mode is selected.

## Workflow modes

- **Fast** — inspect, implement, targeted validation, diff review, commit proposal.
- **Standard** — blocking clarification, recommendation, concise plan, implementation, targeted/package validation, integrated review.
- **Rigorous** — explicit invariants, architecture review, required tests, largeer isolation, broad validation, high-risk review.


## Triage contract and policy enforcement

The small-model triage agent returns a fixed, schema-validated `TriageOutput`. It recommends but does not execute. Complexity and risk are independent dimensions. Fast mode requires positive evidence of low risk; Rigorous mode requires an explicit high-risk trigger. The orchestrator applies deterministic repository policy after model output and retains both `modelRecommendation` and `finalMode` with an override reason.

Triage output is bounded to one summary, one blocking question, five inspection targets, three escalation reasons, and three assumptions. Inspection requests describe objectives rather than hallucinated filenames. Invalid model output is retried once and then falls back safely.

## Introspection and review policy

A cheap structured preflight is enabled by default for every task. Deep reflection is triggered by material scope expansion, architectural change, repeated failed repairs, integration conflicts, or explicit user request. Reflections are decision records, not exposed chain-of-thought.

Default review policy:

- Fast: final diff sanity check.
- Standard: one integrated review.
- Rigorous: deep review, with specialist review where configured.
- Multi-agent: at least integrated review.

Users may request additional review manually, but configured mandatory safety checks survive a lower-review override.

## Execution graph and ownership

Each task declares read sets, write sets, dependencies, validation commands, and status. Parallel tasks must have disjoint write sets. The first draft provides shared-worktree file leases; isolated worktrees are the intended next isolation strategy.

## Safety boundaries

The framework prepares but does not automatically execute commits. Pushes, deployments, production writes, destructive commands, secret handling, and history rewriting require explicit external approval and adapter enforcement.

## Model-backed triage runtime

The CLI triage path now uses the following sequence:

1. Resolve the configured `routing.triage` capability profile through the active adapter.
2. Invoke the Claude CLI in bounded non-interactive mode (`--max-turns 1`) with write and shell tools disabled.
3. Parse either direct JSON or the Claude JSON result envelope.
4. Validate the result against `TriageOutput`.
5. Apply deterministic repository-policy overrides.
6. Retry once when output is malformed or schema-invalid.
7. Fall back to the local deterministic classifier when both attempts fail or automatic triage is disabled.

The model recommendation is never the final safety authority. The persisted workflow records the provider, resolved model, number of attempts, fallback source, and warnings for auditability.
