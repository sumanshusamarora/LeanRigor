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

## Claude Code plugin installation boundary

The Claude adapter ships two integrations.

Marketplace plugin:

```
Repository root
  ├── .claude-plugin/     ← marketplace.json and plugin.json
  ├── commands/           ← global /leanrigor commands
  ├── agents/             ← triage agent
  ├── plugin-skills/      ← shared workflow skill
  ├── hooks/              ← hooks.json and protect-git.sh
  ├── bin/                ← launcher added to Bash PATH
  └── runtime/            ← bundled CLI runtime
```

Project-local fallback:

```
npm package (dist/adapters/claude/plugin/)
  ├── commands/          ← installed to .claude/commands/
  ├── agents/            ← installed to .claude/agents/
  ├── hooks/             ← installed to .claude/leanrigor/
  └── leanrigor/          ← shared command reference

Target repository (.claude/)
  ├── commands/          ← five /leanrigor-* commands
  ├── agents/            ← leanrigor-triage subagent
  ├── leanrigor/         ← protect-git.sh and sequential-workflow.md
  └── settings.json      ← hooks configuration
```

Asset source of truth: `src/adapters/claude/plugin/`. The build step copies
non-TypeScript assets alongside compiled output so they are accessible at
runtime via `import.meta.url`.

Every installed file is tagged with `generated_by: leanrigor | asset_version: N`
so the installer can safely detect ownership, report conflicts, and determine
whether a file has been user-modified before removing it during uninstall.

Marketplace mode does not copy `.claude/` into target repositories. It keeps
state in `.leanrigor/` and executes the bundled runtime through
`${CLAUDE_PLUGIN_ROOT}`.

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
- **Rigorous** — explicit approach gate, risk boundary confirmation, stronger validation, deep or specialist review when triggered.


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

## Persisted sequential flow

The `leanrigor flow` command group is the first complete end-to-end workflow for
Claude Code. It stores each workflow at `.leanrigor/workflows/<id>.json` using a
versioned schema. Writes are atomic and guarded by an optimistic revision check.

The persisted lifecycle is:

`created -> triaging -> awaiting_clarification? -> awaiting_approach_approval? -> planning -> awaiting_plan_approval -> executing -> validating -> reviewing -> awaiting_commit_approval -> completed`

`blocked` and `cancelled` are explicit escape states.

The CLI/state contract is deliberately narrow: LeanRigor records the original
request, repository root, triage result, approach recommendation, phase plan,
approvals, phase timestamps, changed files, commands run, validation evidence,
integrated review result, repair attempts, blockers, and commit proposal.
Claude Code performs the actual edits and command execution in the active
session, then records concise evidence back into state.

This implementation is sequential only. It does not add parallel agents,
worktrees, OpenCode, Codex, CodeGraph, or per-phase completion hooks.

## Safety boundaries

The framework prepares but does not automatically execute commits. Pushes, deployments, production writes, destructive commands, secret handling, and history rewriting require explicit external approval and adapter enforcement.

## Backlog

1. Small, cohesive task-phase sizing
2. Evidence-based per-phase completion gate
3. Optional CodeGraph inspection provider
4. Persistent file leases
5. Parallel agents and worktrees
6. OpenCode adapter
7. Codex adapter

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
