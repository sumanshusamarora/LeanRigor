# LeanRigor

LeanRigor is an adaptive engineering workflow for AI coding agents. It applies
more planning, validation, review, and execution control when a task is risky,
while keeping clearly bounded, low-risk work lightweight.

Instead of forcing every change through the same ceremony, LeanRigor separates
**task complexity** from **workflow risk** and selects one of three modes:

- **Fast** for clearly bounded, low-risk changes.
- **Standard** for normal implementation work.
- **Rigorous** for migrations, security, public contracts, production
  infrastructure, concurrency, data integrity, destructive operations, and
  other high-blast-radius work.

The first supported coding-agent integration is Claude Code. LeanRigor can be
installed as a native Claude Code marketplace plugin or used through its npm
CLI and project-local Claude assets.

> LeanRigor is the workflow and policy control plane. It decides planning,
> approvals, dispatch eligibility, evidence requirements, completion gates,
> integration policy, final validation, and review. Execution providers launch
> workers and return structured results.

## Why LeanRigor?

AI coding agents are often used in one of two ways:

1. move quickly with limited planning and inconsistent validation; or
2. apply a comprehensive workflow to every task, regardless of size or risk.

LeanRigor explores a different trade-off: **use the minimum justified rigor,
then enforce the selected workflow with evidence rather than confidence**.

## Quick start

### Claude Code marketplace

```text
/plugin marketplace add sumanshusamarora/LeanRigor
/plugin install leanrigor@leanrigor
```

Then, from a repository:

```text
/leanrigor:start Add an optional API field and update its consumer
```

Claude presents triage, approvals, the plan, phase progress, validation,
integrated review, and a commit proposal conversationally. Marketplace mode does
not create a repository-local `.claude/` directory. LeanRigor lazily creates
`.leanrigor/` with a protective `.gitignore` on first use — no explicit init is
required after plugin installation.

Available marketplace commands:

```text
/leanrigor:start
/leanrigor:init
/leanrigor:plan
/leanrigor:status
/leanrigor:review
/leanrigor:commit
```

Claude Code namespaces marketplace plugin commands as `/plugin-name:command`.
LeanRigor therefore uses concise command names such as `/leanrigor:start` and
`/leanrigor:plan`. After upgrading the plugin, restart or reload Claude Code if
autocomplete still shows older command names.

### npm and project-local Claude assets

The npm package is not yet published as a stable public release. Use this
fallback when Claude Code marketplace installation is unavailable or when you
explicitly want repository-local `.claude/` assets:

```bash
npm install -g leanrigor
leanrigor init --adapter claude --root /path/to/repository
leanrigor doctor --adapter claude --root /path/to/repository
```

## Configuration

LeanRigor uses a layered configuration hierarchy with deterministic precedence:

| File | Location | Scope | Committed? |
|---|---|---|---|
| User preferences | `~/.config/leanrigor/config.json` | Personal defaults across repos | No |
| Repository policy | `leanrigor.config.json` | Team safety policy, min tiers | Yes |
| Local config | `.leanrigor/config.json` | Private overrides, concrete models | No |
| Runtime state | `.leanrigor/workflows/` | Workflow persistence | No |

**Precedence** (highest to lowest): CLI flags → environment variables → local
config → repo policy → user config → adapter defaults → built-in defaults.

**Safety constraints**: Repository policy minimums and maximums cannot be
weakened by personal preferences. For example, if the repo policy requires
`large` tier for reviews, user config cannot downgrade it.

**Portable model tiers**: Repository policy specifies portable capability tiers
(`small`, `medium`, `large`, `inherit`) — not concrete model names. Each
contributor resolves these to their own models via user config, local config, or
environment variables like `ANTHROPIC_DEFAULT_HAIKU_MODEL`.

**Claude adapter**: Derives defaults from `ANTHROPIC_DEFAULT_HAIKU_MODEL` /
`ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` environment
variables, falling back to Claude aliases `haiku` / `sonnet` / `opus`. The
`inherit` tier omits `--model`.

Inspect effective configuration:

```bash
leanrigor config show
leanrigor config show --json
leanrigor config get execution.maxParallelPhases
leanrigor config set execution.maxParallelPhases 4 --scope local
```

### From Source

For local development or a pre-publish install:

```bash
npm install
npm run build
npm pack
npm install -g ./leanrigor-$(node -p "require('./package.json').version").tgz

leanrigor init --adapter claude --root /path/to/repository
leanrigor doctor --adapter claude --root /path/to/repository
```

Node.js 20 or later is required.

Project-local installation explicitly sets
`.claude/leanrigor/protect-git.sh` to mode `0755` on clean install, repeat-safe
repair, and `--force-owned-files` repair. `leanrigor doctor --adapter claude`
reports whether the hook is current and executable, non-executable, missing, or
modified.

## Verified capabilities

### Adaptive workflow and policy

- Fast, Standard, and Rigorous workflow modes.
- Complexity and risk assessed separately.
- Deterministic policy escalation for explicit high-risk triggers.
- Portable model tiers: `small`, `medium`, `large`, and `inherit`.
- At most one blocking clarification at a time.
- Explicit approach and plan approval where required.
- Small, cohesive phases with dependencies, acceptance criteria, expected write
  areas, and validation expectations.
- Shared adaptive engineering methodology for planning, design,
  implementation, debugging, testing, review, evidence, and safeguards.

### Evidence and completion control

- Per-phase completion gates with structured criterion evidence.
- Deterministic enforcement of missing evidence, failed validation, scope
  deviations, repair budgets, dependency status, and sensitive-path triggers.
- Bounded repair, review, replan, and blocked outcomes.
- Final integrated review remains required after local phase completion.
- Commit proposals are prepared without automatically creating the final user
  commit.

### Persistence, concurrency, and workspaces

- Repository-local, versioned workflow state under `.leanrigor/`.
- Atomic workflow persistence, monotonic revisions, revision conflicts, and
  persistent workflow locks.
- Explicit phase DAGs, ready-phase scheduling, durable leases, ownership
  metadata, heartbeats, expiry, and stale-lease recovery.
- Conflict-aware scheduling based on declared read/write ownership.
- Dedicated LeanRigor integration worktree and isolated phase worktrees.
- Internal mechanical phase commits on LeanRigor-owned branches after a phase
  gate passes.
- Controlled integration ordering and persisted textual conflict state.
- Combined validation tied to the current integration head.
- The user's original branch, index, unstaged files, untracked files, stash, and
  checkout are not modified by workspace operations.

### Execution providers

- Provider-neutral `ExecutionCoordinator` and `ExecutionProvider` boundary.
- Deterministic scripted provider and disposable real-Git integration harness.
- Persisted execution records, polling, cancellation, timeout, heartbeat, and
  recovery behaviour.
- Claude CLI provider prototype for headless execution.
- Persisted coordinator progression from provider result collection through
  phase gate, internal transfer commit, integration, combined validation, and
  final integrated review.
- A successful provider process exit alone does not mark a phase complete;
  structured evidence and the deterministic completion gate remain required.

### Claude Code integration

- Native marketplace commands:
  - `/leanrigor:start`
  - `/leanrigor:plan`
  - `/leanrigor:status`
  - `/leanrigor:review`
  - `/leanrigor:commit`
- Project-local fallback installed with `leanrigor init --adapter claude`.
- Git-protection hook blocks automatic `git commit`, `git push`, and
  `git reset --hard` in the project-local integration.
- Project-local and marketplace hooks are invoked through `sh` for reliable
  execution while preserving the executable-bit health check.
- `leanrigor doctor` checks installation health, hook permissions, and model
  configuration.

## Safety guarantees

LeanRigor is deliberately conservative around user-controlled and production
operations. It does not automatically:

- create the final user commit;
- push to a remote;
- deploy;
- perform destructive production writes;
- resolve integration conflicts by choosing `ours` or `theirs`;
- persist hidden chain of thought.

Internal mechanical commits may be created only on LeanRigor-owned phase and
integration branches to support controlled transfer and validation. They are
not the final user commit and are never pushed automatically.

## How the workflow progresses

```text
request
→ triage and deterministic policy
→ clarification when blocking
→ approach approval when required
→ phased plan and plan approval
→ coordinator or manual phase execution
→ targeted validation and completion gate
→ internal phase integration
→ combined validation on the current integration head
→ persisted final integrated review
→ human-approved commit proposal
```

In coordinator mode, `flow execute-next` and `flow execution-poll` dispatch and
monitor the configured provider. Claude does not implement the phase directly
in the user's original working tree. Manual mode remains an explicit fallback
when no execution provider is configured and still requires assigned workspace
use and persisted completion evidence.

Dependent phases unlock only after their prerequisite completion gates pass.
Claude must report the persisted state and blocker rather than narrating a
workflow as complete when a required transition has not occurred.

## Current limitations

- Claude Code is the only supported coding-agent integration today.
- The Claude CLI execution provider is a prototype. The repository includes
  `scripts/smoke-claude-cli-execution.sh` for manual end-to-end verification
  against an authenticated local Claude CLI; this smoke is not run in ordinary
  CI.
- Native Claude subagent orchestration is not yet integrated.
- Scheduling is parallel-ready, but autonomous multi-agent dispatch is not yet
  presented as a stable user-facing capability.
- Textual integration conflicts are detected and preserved for repair; semantic
  conflict repair is not implemented.
- OpenCode, Codex, Cursor, Copilot, and other adapters remain roadmap items.
- The npm package remains a pre-release draft and is not yet published as a
  stable public package.

## LeanRigor and Superpowers

[Superpowers](https://github.com/obra/superpowers) provides a comprehensive,
strongly guided engineering methodology for coding agents. LeanRigor shares its
emphasis on planning, testing, verification, and review, while exploring a
different product choice: proportional ceremony and model capability selected
from task complexity and explicit risk.

| Area | Superpowers | LeanRigor |
|---|---|---|
| Workflow philosophy | Comprehensive methodology and automatic skill use. | Adaptive Fast, Standard, and Rigorous workflows with deterministic escalation. |
| Planning | Detailed brainstorming and implementation planning workflow. | Plans and approval depth scale with risk; Fast remains compact. |
| Testing and review | Strong testing, debugging, verification, and review skills. | Proportional methodology plus persisted per-phase evidence and deterministic completion gates. |
| Workspaces | Includes worktree-oriented workflow guidance. | Implements LeanRigor-owned phase and integration worktrees coupled to leases, evidence, and integration gates. |
| Model routing | Model guidance may vary by role and task. | Portable capability tiers are part of workflow configuration. |
| Execution control | Methodology-focused agent workflow. | Policy control plane with provider-neutral execution contracts and resumable audit state. |

This comparison is intended to explain the different design emphasis, not to
claim that one approach replaces the other.

## Documentation

- [Product rationale](PRODUCT.md)
- [Architecture](ARCHITECTURE.md)
- [Workflow](docs/workflow.md)
- [Engineering methodology](docs/methodology.md)
- [Claude Code adapter](docs/claude-code.md)
- [Claude marketplace plugin](docs/claude-marketplace.md)
- [Setup](docs/setup.md)
- [Configuration](docs/configuration.md)
- [Contributor architecture](docs/contributor-architecture.md)
- [Security policy](SECURITY.md)
- [Support policy](SUPPORT.md)
- [Governance](GOVERNANCE.md)
- [Release process](RELEASING.md)
- [Changelog](CHANGELOG.md)

## Roadmap

Roadmap items are tracked through GitHub issues rather than presented as
available features. Near-term themes include:

- native Claude phase-worker orchestration;
- integrated semantic conflict repair;
- build-versus-reuse review for generic workspace and execution mechanics;
- additional provider and coding-agent adapters;
- cross-platform CI and release automation.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the
[contributor architecture guide](docs/contributor-architecture.md).

Use GitHub issue forms for bugs, feature proposals, documentation problems, and
provider or workspace requests. Security vulnerabilities should follow
[SECURITY.md](SECURITY.md) rather than being reported publicly.

## License

LeanRigor is released under the [MIT License](LICENSE).
