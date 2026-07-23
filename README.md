# LeanRigor

LeanRigor is a workflow controller for AI coding sessions. It helps an agent
choose the right amount of planning, validation, review, and model capability
for a task instead of applying the same ceremony to every change.

The first complete workflow targets Claude Code. It is sequential, persisted,
approval-gated, and repository-local: LeanRigor records state under
`.leanrigor/`, asks at most one blocking clarification, guides phased execution,
requires validation evidence and final review, and proposes commits without
committing or pushing.
Each workflow phase is a small functional outcome with acceptance criteria,
expected write areas, and validation expectations. A phase only unlocks
dependents after an evidence-based completion gate passes.

## Status

This repository is an architectural and functional draft. The TypeScript CLI
installs, type checks, builds, packs, and passes the Vitest suite. Native Claude
Code marketplace packaging is implemented and locally validated. Parallel
agents, worktrees, OpenCode, Codex, Cursor, Copilot, and Antigravity adapters
remain future work.

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
npm install -g ./leanrigor-0.1.0-draft.tgz
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

`leanrigor flow start "<request>"` creates a workflow under
`.leanrigor/workflows/` and persists the original request, repository root,
triage result, mode, risk, complexity, assumptions, and timestamps.

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

During execution, the active phase must run or explicitly skip its declared
validation and submit structured completion evidence. The deterministic gate
then returns `completed`, `needs_repair`, `needs_review`, `needs_replan`, or
`blocked`. Failed validation blocks progression, unexpected scope deviations are
recorded and escalated when material, and repair attempts are bounded by mode.
The final integrated review still runs after all per-phase gates pass.

## Principles

- Cheap automatic triage by default.
- Fast, Standard, and Rigorous workflows.
- Capability-based model routing instead of vendor coupling.
- Blocking questions only, one at a time.
- Sequential phase execution in this iteration.
- Small cohesive phase sizing by functional outcome and dependency boundary.
- Per-phase completion gates with criterion evidence and deterministic policy.
- Targeted validation with persisted evidence.
- Final integrated review before commit planning.
- Commit preparation without automatic commit or push.

## Documentation

- [Product rationale](PRODUCT.md)
- [Architecture](ARCHITECTURE.md)
- [Workflow](docs/workflow.md)
- [Claude Code adapter](docs/claude-code.md)
- [Claude marketplace plugin](docs/claude-marketplace.md)
- [Setup](docs/setup.md)
- [Model routing](docs/model-routing.md)
- [OpenCode roadmap](docs/opencode-roadmap.md)

## LeanRigor And Superpowers

Superpowers provides a comprehensive, strongly guided engineering methodology
for coding agents. LeanRigor is inspired by its emphasis on planning, evidence,
testing, and review, while exploring a different trade-off: selecting workflow
depth and model capability in proportion to task risk and complexity.

The comparison below is based on the current Superpowers README, which describes
brainstorming, git worktrees, bite-sized plans, subagent-driven development,
TDD, code review, and branch finishing.

| Area | Superpowers | LeanRigor |
|---|---|---|
| Installation | Claude official marketplace or Superpowers marketplace. | LeanRigor marketplace, with npm/project-local fallback. |
| Workflow shape | Strong full methodology with brainstorming, worktree, plan, execution, TDD, review, finish. | Adaptive Fast, Standard, or Rigorous workflow selected by triage and policy. |
| Execution model | Supports subagent-driven development and worktrees. | Sequential single-session execution in this iteration. |
| Testing/review | Emphasizes RED-GREEN-REFACTOR, evidence, and code review. | Records proportional validation evidence and final integrated review. |
| Trade-off | Comprehensive discipline by default. | Ceremony and model capability scaled to task risk and complexity. |

Sources: [Superpowers README](https://github.com/obra/superpowers),
[Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference),
and [Claude plugin marketplace docs](https://code.claude.com/docs/en/plugin-marketplaces).

## Deliberate Limitations

- Current Claude Code marketplace commands are namespaced by plugin name.
- Triage has deterministic fallback; model-backed triage is available through
  the Claude adapter when configured.
- The current workflow is sequential and does not autonomously spawn coding
  agents.
- File leases are in-memory in the core draft.
- Worktree isolation is documented but not implemented.
- Commit planning is intentionally conservative and requires human review.
