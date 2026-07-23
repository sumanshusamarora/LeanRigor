# LeanRigor

LeanRigor is a workflow controller for AI coding sessions. It helps an agent
choose the right amount of planning, validation, review, and model capability
for a task instead of applying the same ceremony to every change.

The first complete workflow targets Claude Code. It is sequential, persisted,
approval-gated, and repository-local: LeanRigor records state under
`.leanrigor/`, asks at most one blocking clarification, guides phased execution,
requires validation evidence and final review, and proposes commits without
committing or pushing.
Standard and Rigorous workflows can use LeanRigor-owned Git worktrees: each
leased phase works in an isolated worktree, approved phase changes transfer
through internal LeanRigor commits, and combined validation runs in a dedicated
integration worktree before final review.
Each workflow phase is a small functional outcome with acceptance criteria,
expected write areas, and validation expectations. A phase only unlocks
dependents after an evidence-based completion gate passes.
Shared engineering methodology lives under `methodology/` and is applied
proportionally by Fast, Standard, and Rigorous mode overlays.

## Status

This repository is an architectural and functional draft. The TypeScript CLI
installs, type checks, builds, packs, and passes the Vitest suite. Native Claude
Code marketplace packaging is implemented and locally validated. Git worktree
isolation is implemented for phase and integration workspaces. Parallel agents,
OpenCode, Codex, Cursor, Copilot, and Antigravity adapters remain future work.

## Install

### Claude Code Marketplace

Recommended for Claude Code:

```text
/plugin marketplace add sumanshusamarora/LeanRigor
/plugin install leanrigor@leanrigor
```

Marketplace installation is global to Claude Code. LeanRigor's commands, agent,
hook, and bundled runtime are installed in Claude's plugin cache and invoked
through `${CLAUDE_PLUGIN_ROOT}`. Repository-specific state stays local:

```text
.leanrigor/config.json
.leanrigor/workflows/
```

Marketplace mode does not create a repository-local `.claude/` directory.

Current Claude Code marketplace installs expose plugin commands with a plugin
namespace. Use:

```text
/leanrigor:start Fix the typo in README.md
/leanrigor:plan
/leanrigor:status
/leanrigor:review
/leanrigor:commit
```

Claude Code namespaces marketplace plugin commands as `/plugin-name:command`.
LeanRigor therefore uses concise command names such as `/leanrigor:start` and
`/leanrigor:plan`.

After upgrading the plugin, restart or reload Claude Code if autocomplete still
shows older command names.

### Npm And Project-Local Claude Assets

Use this fallback when Claude Code marketplace installation is unavailable or
when you explicitly want repository-local `.claude/` assets:

```bash
npm install -g leanrigor
leanrigor init --adapter claude --root /path/to/repository
leanrigor doctor --adapter claude --root /path/to/repository
```

Project-local installation creates LeanRigor-owned files under `.claude/` and
exposes unqualified Claude slash commands such as `/leanrigor`.

### From Source

For local development or a pre-publish install:

```bash
npm install
npm run build
npm pack
npm install -g ./leanrigor-$(node -p "require('./package.json').version").tgz
```

You can also run the CLI directly from the repository:

```bash
npx leanrigor --help
npx leanrigor flow start "Fix a README typo" --provider deterministic --root /path/to/repository
```

## Supported Platforms

| Platform | Status | Notes |
|---|---|---|
| Claude Code | Supported | Native marketplace plugin plus npm/project-local fallback. |
| LeanRigor CLI | Supported | Works anywhere Node.js 20+ can run; workflow state is repository-local. |
| GitHub Copilot | Coming soon | No Copilot adapter is implemented yet. |
| Cursor | Coming soon | Planned adapter surface; not implemented in this draft. |
| Google Antigravity | Coming soon | Planned adapter surface; not implemented in this draft. |
| OpenAI Codex | Coming soon | Listed in the backlog; no Codex adapter is present. |
| OpenCode | Coming soon | Listed in the backlog; no OpenCode adapter is present. |

## Workflow

For Claude Code, `/leanrigor:start` is the primary entry point:

```text
/leanrigor:start Add a short usage section to README.md
```

Claude presents triage, approach approval when needed, the phased plan, phase
completion gates, final review, and the commit proposal conversationally. Users
normally respond with plain language such as `Approve`, `Revise the plan to
separate the migration`, `Continue`, or `Show status`. Claude invokes
LeanRigor CLI transitions internally and only shows shell commands for
troubleshooting or when explicitly requested.

Manual CLI use remains available. `leanrigor flow start "<request>"` creates a
workflow under `.leanrigor/workflows/` and persists the original request,
repository root, triage result, mode, risk, complexity, assumptions, and
timestamps.

The lifecycle is:

```text
created -> triaging -> awaiting_clarification? -> awaiting_approach_approval?
-> planning -> awaiting_plan_approval -> executing -> validating -> reviewing
-> awaiting_commit_approval -> completed
```

`blocked` and `cancelled` are explicit terminal or recovery states.

Mode differences are observable:

| Mode | Intended use | Approval and validation |
|---|---|---|
| Fast | Obvious low-risk changes | May skip a separate approach gate; compact plan, targeted validation, diff sanity review. |
| Standard | Normal implementation work | Approach recommendation when meaningful, phased plan, explicit plan approval, targeted validation, integrated review. |
| Rigorous | High-risk, broad, or policy-triggered work | Explicit approach gate, stronger validation expectations, deeper integrated review, stricter repair/replan handling. |

Mandatory safety triggers can escalate mode and cannot be bypassed by asking for
less rigor.

The methodology adds directive engineering standards for planning, design,
implementation, debugging, testing, review, evidence, scope control, security,
migrations, APIs/contracts, and production-impacting changes. Claude loads the
core methodology plus the selected mode overlay, then only the specific
methodology files relevant to the current step.

During execution, LeanRigor derives ready phases from an explicit dependency
DAG. The default remains sequential: `execution.maxParallelPhases` is `1`, and
LeanRigor does not spawn parallel agents. Internally, a ready phase is leased to
the current owner before work starts, then it must run or explicitly skip its
declared validation and submit structured completion evidence. The
deterministic gate then returns `completed`, `needs_repair`, `needs_review`,
`needs_replan`, or `blocked`. Failed validation blocks progression, unexpected
scope deviations are recorded and escalated when material, and repair attempts
are bounded by mode. The final integrated review still runs after all per-phase
gates pass.

Workflow mutations use atomic revisioned persistence and persistent workflow
locks. Phase leases, ownership metadata, stale-lease recovery, Git worktree
isolation, and conflict-aware ready scheduling make the engine parallel-ready,
but higher parallelism currently only changes scheduling recommendations; it
does not launch agents.

## Git Workspaces

`leanrigor flow workspace-init <workflow-id>` creates one integration worktree
outside the source tree, by default under:

```text
<repository-parent>/.leanrigor-worktrees/<repository-name>/<workflow-id>/
```

`leanrigor flow workspace-create-phase <workflow-id> <phase-id> --owner <id>`
creates one phase worktree for the active lease owner. Claude must edit only
inside the returned phase workspace. Before editing, Claude verifies that `pwd`
and the Git root match the active workspace returned by LeanRigor.

Branch names are deterministic and sanitized:

```text
leanrigor/<workflow-short-id>/integration
leanrigor/<workflow-short-id>/<phase-id>
```

LeanRigor rejects branch/path collisions unless persisted ownership metadata
proves the branch or worktree is LeanRigor-owned. The user branch, user index,
unstaged files, untracked files, stash, and current checkout are not modified by
phase or integration worktree operations.

Approved phase changes are transferred by internal LeanRigor commits created on
LeanRigor-owned phase branches after the phase completion gate passes. These
commits are not pushed and are not the final user commit. The final commit
proposal remains separate and human-approved. Integration cherry-picks internal
phase commits into the LeanRigor integration worktree; textual conflicts are
persisted and left for explicit repair rather than resolved with ours/theirs.

Active workflow selection is conservative: one active workflow is resumed, no
workflow starts only when a request is supplied, and multiple active workflows
are shown as a short selection list. Completed and cancelled workflows are not
selected by default.

## Principles

- Cheap automatic triage by default.
- Fast, Standard, and Rigorous workflows.
- Capability-based model routing instead of vendor coupling.
- Blocking questions only, one at a time.
- Sequential execution by default, with a parallel-ready phase DAG and leases.
- Small cohesive phase sizing by functional outcome and dependency boundary.
- Per-phase completion gates with criterion evidence and deterministic policy.
- Targeted validation with persisted evidence.
- Final integrated review before commit planning.
- Commit preparation without automatic commit or push.
- Shared methodology source with mode overlays rather than duplicated long
  command prompts.

## Documentation

- [Product rationale](PRODUCT.md)
- [Architecture](ARCHITECTURE.md)
- [Workflow](docs/workflow.md)
- [Engineering methodology](docs/methodology.md)
- [Claude Code adapter](docs/claude-code.md)
- [Claude marketplace plugin](docs/claude-marketplace.md)
- [Setup](docs/setup.md)
- [Configuration reference](docs/configuration.md)
- [Model routing](docs/model-routing.md)
- [OpenCode roadmap](docs/opencode-roadmap.md)

## LeanRigor And Superpowers

Superpowers offers a comprehensive, strongly guided engineering methodology for
coding agents. LeanRigor shares its emphasis on planning, testing,
verification, and review, while exploring a different trade-off: applying
different levels of ceremony and model capability according to task risk and
complexity.

The comparison below is based only on verified primary-source documentation in
the current Superpowers repository.

| Area | Superpowers | LeanRigor |
|---|---|---|
| Workflow philosophy | Complete software development methodology with automatic skill use and a basic flow from brainstorming through branch finishing. | Proportional methodology with deterministic gates and Fast/Standard/Rigorous depth selected by triage and policy. |
| Planning | Brainstorming/design approval, then detailed bite-sized implementation plans. | Inspected plans with acceptance criteria and validation, scaled by mode; Fast remains compact. |
| Testing | RED-GREEN-REFACTOR TDD is documented for features, bugs, refactors, and behavior changes. | Proportional testing: sanity for Fast, targeted/unit/integration defaults for Standard, broader/risk-specific checks for Rigorous. |
| Debugging | Systematic root-cause process before fixes. | Reproduce, observe, narrow, hypothesize, test, root-cause, minimal fix, regression coverage, with depth by mode. |
| Review | Task and final code review are part of documented execution flows. | Sanity, integrated, deep, and specialist review levels feed LeanRigor completion gates. |
| Worktrees | Documented worktree skill detects/creates isolated workspaces. | Not implemented in this iteration; worktree isolation remains backlog. |
| Subagents | Documented subagent-driven development dispatches implementers and reviewers. | Not implemented in this iteration; scheduling is parallel-ready but execution remains sequential unless driven manually. |
| Adaptive mode selection | The README documents a strong default workflow; no claim is made here about risk-based mode selection. | Built-in adaptive mode selection with deterministic escalation for high-risk triggers. |
| Model-tier routing | Subagent documentation advises choosing models by role and task complexity. | Portable small/medium/large routing is built into configuration and workflow stages. |
| Completion evidence | Verification-before-completion requires fresh evidence before success claims. | Completion gates persist criterion evidence, validation records, scope deviations, risks, and final review. |

Primary sources:
[Superpowers README](https://github.com/obra/superpowers),
[brainstorming](https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md),
[writing-plans](https://github.com/obra/superpowers/blob/main/skills/writing-plans/SKILL.md),
[test-driven-development](https://github.com/obra/superpowers/blob/main/skills/test-driven-development/SKILL.md),
[systematic-debugging](https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md),
[verification-before-completion](https://github.com/obra/superpowers/blob/main/skills/verification-before-completion/SKILL.md),
[requesting-code-review](https://github.com/obra/superpowers/blob/main/skills/requesting-code-review/SKILL.md),
[using-git-worktrees](https://github.com/obra/superpowers/blob/main/skills/using-git-worktrees/SKILL.md),
and
[subagent-driven-development](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md).

## Deliberate Limitations

- Current Claude Code marketplace commands are namespaced by plugin name.
- Triage has deterministic fallback; model-backed triage is available through
  the Claude adapter when configured.
- The current workflow is parallel-ready but does not autonomously spawn coding
  agents.
- Durable workflow locks and phase leases exist; worktree isolation and merge
  orchestration do not.
- Worktree isolation is documented but not implemented.
- Commit planning is intentionally conservative and requires human review.

## Backlog

1. Worktree isolation and integration workspace
2. Parallel phase agent orchestration
3. Integrated merge/conflict repair workflow
4. Optional CodeGraph inspection provider
5. OpenCode adapter
6. Codex adapter

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for
development setup, branch conventions, and pull request guidelines.

## License

LeanRigor is released under the [MIT License](LICENSE).
