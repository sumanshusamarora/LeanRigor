# Setup and installation

Claude Code marketplace installation is the recommended user path. The npm package is currently private and not published as a stable public package.

## Requirements

- Claude Code for the marketplace integration;
- Node.js 20 or later on `PATH`;
- Git for workspace-backed workflows;
- an authenticated Claude CLI only when using the experimental `claude-cli` execution provider or live smoke script.

## Recommended: Claude Code marketplace

```text
/plugin marketplace add sumanshusamarora/LeanRigor
/plugin install leanrigor@leanrigor
```

Then, from a repository:

```text
/leanrigor:start Fix the assignment regression
```

Available marketplace commands:

```text
/leanrigor:start
/leanrigor:init
/leanrigor:plan
/leanrigor:status
/leanrigor:review
/leanrigor:commit
```

Marketplace installation is global to Claude Code. LeanRigor auto-bootstraps repository-local state under `.leanrigor/` on first use and does not install LeanRigor command files into the target repository's `.claude/` directory.

## Install from source

Use this path for development, pre-release testing, or project-local Claude assets:

```bash
npm install
npm run build
npm pack
npm install -g ./leanrigor-$(node -p "require('./package.json').version").tgz
```

Verify the CLI:

```bash
leanrigor --help
```

### Project-local Claude assets

```bash
leanrigor init --adapter claude --root /path/to/repository
leanrigor doctor --adapter claude --root /path/to/repository
```

Project-local initialisation creates LeanRigor-owned `.claude/` commands, triage agent, methodology references, hook script, and shared settings entries. It also creates repository-local LeanRigor configuration and state directories when required.

Installation is repeat-safe:

- missing assets are created;
- exact current assets remain unchanged;
- content-equal adoptable assets can be adopted safely;
- user-created files are never overwritten;
- modified LeanRigor-owned files are preserved and reported;
- `--force-owned-files` replaces only LeanRigor-owned files;
- LeanRigor hook entries are merged into shared `.claude/settings.json` without deleting unrelated settings.

To restore modified LeanRigor-owned assets:

```bash
leanrigor init --adapter claude --force-owned-files --root /path/to/repository
```

To remove LeanRigor-owned project-local assets:

```bash
leanrigor uninstall --adapter claude --root /path/to/repository
```

Uninstall preserves unrelated files, modified owned files, workflow state unless explicitly requested, and unrelated settings entries.

## First workflow

### Conversational Claude Code path

```text
/leanrigor:start Add an optional API field and update its consumer
```

Claude presents triage, approvals, plan, execution progress, evidence gates, integration, final review, and the commit proposal conversationally.

### Manual CLI path

```bash
leanrigor flow start "Fix the assignment regression" --provider auto --root /path/to/repository
leanrigor flow active --json --root /path/to/repository
leanrigor flow next <workflow-id> --json --root /path/to/repository
leanrigor flow status <workflow-id> --root /path/to/repository
```

Raw workflow commands are intended for advanced use and troubleshooting. Normal Claude Code use should not require users to copy and paste internal transition commands.

## Execution providers

### Deterministic scripted provider

Used by automated tests and disposable real-Git smoke scenarios:

```bash
leanrigor flow execute-next <workflow-id> --provider scripted --json --root /path/to/repository
leanrigor flow execution-poll <workflow-id> --provider scripted --json --root /path/to/repository
```

### Claude CLI provider prototype

Requires a locally authenticated Claude CLI:

```bash
leanrigor flow execute-next <workflow-id> --provider claude-cli --json --root /path/to/repository
leanrigor flow execution-poll <workflow-id> --provider claude-cli --json --root /path/to/repository
```

The provider runs bounded Claude CLI workers, records the Claude session ID
separately from the LeanRigor workflow ID, and preserves partial worktree
changes on recoverable failures without accepting or integrating them.

For the full live smoke scenario:

```bash
scripts/smoke-claude-cli-execution.sh
```

The live-provider smoke is not run in ordinary CI.

## Repository-local files

LeanRigor may create:

```text
leanrigor.config.json       committed repository policy, when a team adds one
.leanrigor/.gitignore       protects private runtime state
.leanrigor/config.json      local private configuration
.leanrigor/workflows/       persisted workflow state and evidence
.leanrigor/executions/      bounded provider execution artifacts
```

Workspace-backed workflows create LeanRigor-owned worktrees outside the source repository by default:

```text
<repository-parent>/.leanrigor-worktrees/<repository-name>/<workflow-id>/
```

The user's original working tree is not stashed, reset, rebased, or modified by workspace operations.

## Configuration summary

| Layer | Location | Purpose |
|---|---|---|
| User preferences | `~/.config/leanrigor/config.json` | Personal defaults and concrete model choices |
| Repository policy | `leanrigor.config.json` | Committed team policy and safety minimums |
| Local overrides | `.leanrigor/config.json` | Private repository-specific settings |
| Runtime state | `.leanrigor/workflows/` | Persisted workflows, evidence, and resumability |

The central resolver applies built-in and adapter defaults, then user preferences, repository policy, and local configuration before re-applying policy constraints. Personal and local settings cannot weaken committed safety minimums or caps. Claude model aliases may also resolve through the standard `ANTHROPIC_DEFAULT_*` environment variables. See [Configuration reference](configuration.md).

## Diagnostics

```bash
leanrigor doctor --adapter claude --root /path/to/repository
```

Diagnostics report:

- installation mode and runtime source;
- Git commit, package version, plugin version, and asset version;
- installed marketplace commit/version when available;
- Claude CLI availability;
- effective model-tier resolution;
- configuration files and provenance;
- bootstrap and managed-asset health;
- hook content and executable state;
- stale project-local assets that may shadow marketplace commands.

Use `/leanrigor:init` for the conversational marketplace view of the same installation and configuration health.

## Workspace troubleshooting

```bash
leanrigor flow git-preflight --json --root /path/to/repository
leanrigor flow workspace-status <workflow-id> --json --root /path/to/repository
leanrigor flow integration-status <workflow-id> --json --root /path/to/repository
leanrigor flow workspace-recover <workflow-id> --json --root /path/to/repository
leanrigor flow workspace-cleanup <workflow-id> --mode safe --json --root /path/to/repository
```

Cleanup verifies LeanRigor ownership metadata. Safe cleanup refuses dirty, conflicted, unintegrated, or ownership-uncertain workspaces and does not delete remote branches.

Dirty original worktrees are allowed, but their uncommitted changes are outside the frozen LeanRigor base commit. When a task depends on those changes, stop and obtain an explicit user decision rather than silently copying or stashing them.

## Developer refresh

From a source checkout:

```bash
npm run hooks:install
npm run version:check
./scripts/dev-refresh-claude-plugin.sh
```

The refresh script targets only LeanRigor-specific cache entries and LeanRigor-owned project-local assets. Use `--dry-run` to preview actions and `--reset-state` only when repository workflow state should also be removed.
