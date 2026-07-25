# Product rationale

## Why this exists

AI coding workflows often sit at one of two extremes:

- move quickly with limited planning and inconsistent validation; or
- apply a comprehensive engineering process to every task, regardless of size or risk.

Strong methodology can materially improve agent output. In the founder's own use of comprehensive coding-agent workflows, however, small tasks sometimes took roughly **5–20× longer than working with the agent directly**. That figure is a personal observation, not a controlled benchmark.

LeanRigor exists to preserve engineering discipline without turning the discipline itself into unnecessary ceremony.

## Product thesis

> **Rigor should be selected from task complexity and workflow risk, not imposed as a universal ritual.**

Task complexity and workflow risk are separate dimensions:

- a difficult read-only investigation may be complex but low risk;
- a small authentication, migration, or public-contract change may be simple but high risk.

LeanRigor therefore uses three workflow modes:

| Mode | Product intent |
|---|---|
| Fast | Keep clearly bounded, demonstrably low-risk work lightweight. |
| Standard | Apply normal planning, approval, validation, and integrated review. |
| Rigorous | Isolate and govern explicit risks such as security, migrations, production infrastructure, public contracts, data integrity, concurrency, destructive operations, and high blast radius. |

Fast requires positive evidence that less ceremony is safe. Rigorous is triggered by explicit risk policy and cannot be bypassed by model confidence or a request to move faster.

## What LeanRigor is

LeanRigor is the workflow and policy control plane for coding agents.

It owns:

- triage, complexity, risk, and final mode selection;
- planning and phase DAG generation;
- approvals and dispatch eligibility;
- ownership and conflict policy;
- evidence requirements and deterministic completion gates;
- integration ordering and combined validation;
- final review, resumability, and audit state.

Execution providers own provider-specific worker launch, process lifecycle, status, cancellation, and structured results.

Provider output is evidence, not authority. A provider may report success, but LeanRigor decides whether the phase is accepted, repaired, reviewed, replanned, or blocked.

## What LeanRigor is not

LeanRigor is not:

- a new coding model;
- an IDE;
- a replacement for Claude Code, Codex, Copilot, OpenCode, or other execution environments;
- a guarantee that generated code is correct or secure;
- a reason to rebuild generic process, workspace, or provider infrastructure when a stable reusable boundary already exists.

Its purpose is to govern engineering workflow around those systems.

## Product principles

- Prefer evidence over confidence.
- Deterministic policy has final authority over prompt or model recommendations.
- Apply the minimum justified rigor, not the minimum possible rigor.
- Ask only blocking questions, one at a time.
- Keep phases small and cohesive by functional outcome and dependency boundary.
- Validate according to blast radius and persist concise evidence.
- Preserve user control over the final commit, push, deployment, and destructive operations.
- Keep model routing portable through `small`, `medium`, `large`, and `inherit` capability tiers.
- Protect backward compatibility unless a migration is explicitly planned.
- Prefer focused iterations over speculative abstractions and large rewrites.
- Keep LeanRigor-specific governance separate from provider execution and generic Git mechanics.
- Do not persist hidden chain of thought.

## Current scope

Implemented and verified foundations include:

- Fast, Standard, and Rigorous adaptive workflow selection;
- model-backed triage with deterministic escalation and fallback;
- persisted workflow state, approvals, phase DAGs, leases, and recovery;
- evidence-based completion gates and bounded repair/review/replan outcomes;
- isolated phase and integration Git worktrees;
- controlled internal transfer commits and combined validation;
- provider-neutral execution coordinator and scripted provider test harness;
- a Claude CLI provider prototype;
- native Claude Code marketplace packaging and project-local fallback assets.

Claude Code is the first supported coding-agent integration. Native Claude subagent orchestration, semantic conflict repair, additional coding-agent adapters, and stable public npm distribution remain future work or experimental paths.

## Product success

Near-term product success is not only GitHub stars. Useful signals include:

- successful installation and first workflow completion;
- users returning for additional workflows;
- correct Fast/Standard/Rigorous classification on real tasks;
- evidence that LeanRigor catches failures or avoids unnecessary process;
- external contributions, provider adapters, and workflow benchmarks;
- teams asking for reusable repository policy and governance controls.

The project should earn adoption through demonstrable workflow quality, proportionality, and safety—not through claims unsupported by code, tests, or reproducible evidence.
