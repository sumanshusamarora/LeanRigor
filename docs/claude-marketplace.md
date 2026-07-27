# Claude Code marketplace plugin

LeanRigor's recommended user installation path is the native Claude Code marketplace plugin.

```text
/plugin marketplace add sumanshusamarora/LeanRigor
/plugin install leanrigor@leanrigor
```

## What gets installed

The marketplace definition is `.claude-plugin/marketplace.json`; the plugin manifest is `.claude-plugin/plugin.json`.

The current manifest exposes:

```text
/leanrigor:start
/leanrigor:init
/leanrigor:plan
/leanrigor:status
/leanrigor:review
/leanrigor:commit
```

Claude Code namespaces marketplace commands as `/plugin-name:command`, so LeanRigor keeps command segments concise.

Plugin components live at plugin-root paths:

```text
.claude-plugin/   marketplace and plugin manifests
commands/         namespaced slash commands
agents/           read-only triage agent
plugin-skills/    shared workflow instruction
methodology/      adaptive engineering methodology
internal-skills/  internal, non-discovered workflow references
hooks/            plugin hook configuration and Git protection
bin/              launcher
runtime/          bundled CLI runtime
```

## Runtime strategy

LeanRigor bundles the compiled CLI and dependencies into:

```text
runtime/leanrigor-cli.js
```

Commands invoke the launcher through `${CLAUDE_PLUGIN_ROOT}`. The launcher:

- resolves the installed plugin root;
- requires Node.js 20 or later on `PATH`;
- invokes the bundled runtime;
- preserves arguments and exit codes;
- works with paths containing spaces;
- does not load executable code from the target repository.

## Global plugin, repository-local state

Marketplace installation is global to Claude Code. Workflow state remains local to each repository:

```text
.leanrigor/.gitignore
.leanrigor/config.json
.leanrigor/workflows/
.leanrigor/executions/
```

Directories are created only when needed. Marketplace mode does not install LeanRigor command files into the target repository's `.claude/` directory.

On first use, LeanRigor auto-bootstraps its repository-local state and reports installation/configuration health. No separate CLI init command is required for ordinary marketplace use.

## Conversational workflow

`/leanrigor:start` is the primary entry point. It starts or resumes the active workflow, presents mode and risk, asks only blocking clarifications, manages approvals, coordinates execution, reports persisted phase gates, advances through integration and final review, and presents a commit proposal without creating the final commit or pushing.

The other commands inspect or resume the same persisted workflow rather than creating duplicates.

## Validation

From a source checkout:

```bash
npm run build
npm run validate:claude-plugin
```

The validator checks:

- marketplace and plugin manifests;
- component paths and path containment;
- command and agent frontmatter;
- workflow and methodology references;
- hook paths and executable bits;
- bundled runtime presence;
- package, plugin, marketplace, CLI, and build-info version consistency;
- `claude plugin validate . --strict` when Claude CLI is available.

## Native selector smoke

Run this manually from an authenticated interactive Claude Code session after
installing or refreshing the marketplace plugin:

```text
/plugin list
/reload-plugins
```

Confirm `leanrigor@leanrigor` is enabled at the expected version. In a disposable
repository, run:

```text
/leanrigor:init
/leanrigor:start Fix the broken assignment API regression
```

Expected result:

- `/leanrigor:init` reports marketplace mode and current assets.
- The approach gate appears as a native `AskUserQuestion` selector with
  `Approve approach and create plan`, `Revise approach`, `View workflow
  details`, and `Cancel workflow`; Claude does not first print an ordinary
  question such as `Approve or reject this approach?`.
- The summary states that no implementation has started.
- Selecting `View workflow details` renders persisted state without mutating it.
- Selecting `Revise approach` records feedback with `flow revise-approach` and
  returns to the approach gate without planning.
- Selecting `Approve approach and create plan` invokes the internal LeanRigor transition and the plan
  gate appears as a native selector with `Approve`, `Revise`, and `Cancel`.
- Selecting `Cancel workflow` cancels only the disposable workflow.

To smoke active-workflow conflict selection, seed two active workflows in the
same disposable repository with the LeanRigor runtime, then run
`/leanrigor:status`. Expected result: Claude presents a native selector with
one option per workflow, using each option description for ID, request, state,
mode, and updated time. Use numbered text choices only if Claude Code reports
that `AskUserQuestion` is unavailable.

## Developer refresh

Use the safe refresh helper to reinstall the current GitHub `main` plugin without deleting unrelated Claude configuration:

```bash
# Preserve repository .leanrigor state
./scripts/dev-refresh-claude-plugin.sh

# Also reset this repository's LeanRigor runtime state
./scripts/dev-refresh-claude-plugin.sh --reset-state

# Preview actions
./scripts/dev-refresh-claude-plugin.sh --dry-run
```

The script removes only LeanRigor-specific cache entries and LeanRigor-owned project-local fallback assets. It never deletes entire `~/.config`, `~/.claude`, or repository `.claude/` trees.

After refresh, run `/leanrigor:init` inside Claude Code and restart or reload Claude Code if autocomplete still shows an older command surface.

## Versioning and release preparation

The npm package is currently private and pre-release. Package and plugin versions are synchronized from `package.json`.

For development iteration:

```bash
npm run version:dev
```

For explicit synchronization and verification:

```bash
npm run version:sync
npm run version:check
```

Before any marketplace release:

```bash
npm ci
npm run typecheck
npm test
npm run lint
npm run build
npm run validate:claude-plugin
npm pack
```

Do not promote a release when manifests, runtime, documentation, implementation, and verification evidence disagree.

## Project-local fallback

The npm package is not yet published as a stable public package. Development and pre-release users may build from source, install the generated tarball, and run:

```bash
leanrigor init --adapter claude --root /path/to/repository
```

This creates LeanRigor-owned project-local `.claude/` assets and unqualified commands such as `/leanrigor` while preserving unrelated files and shared settings.

## Limitations

- Claude Code may require a plugin refresh, reinstall, or restart after marketplace updates.
- Commands are plugin-namespaced in marketplace mode.
- Node.js 20 or later is required.
- The Claude CLI execution provider is a prototype and live provider smoke testing requires local authentication.
- Native Claude subagent orchestration is not implemented.
- Higher coordinator parallelism is not yet promoted as a stable autonomous multi-agent user experience.
- OpenCode, Codex, and other coding-agent adapters remain roadmap items.
