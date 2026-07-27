# Claude Code adapter

Claude Code is LeanRigor's first supported coding-agent integration.

LeanRigor provides two installation paths:

1. **Native Claude Code marketplace plugin** — recommended for users.
2. **Project-local fallback assets** — intended for development, pre-release testing, or repositories that explicitly need local `.claude/` assets.

## Marketplace installation

```text
/plugin marketplace add sumanshusamarora/LeanRigor
/plugin install leanrigor@leanrigor
```

The marketplace plugin is installed globally in Claude Code. It invokes the bundled LeanRigor runtime through `${CLAUDE_PLUGIN_ROOT}` while repository-specific workflow state remains under `.leanrigor/`.

Marketplace mode does not install LeanRigor command files into the target repository's `.claude/` directory.

Available marketplace commands:

```text
/leanrigor:start
/leanrigor:init
/leanrigor:plan
/leanrigor:status
/leanrigor:review
/leanrigor:commit
```

Claude Code namespaces marketplace commands as `/plugin-name:command`. LeanRigor therefore uses concise command segments such as `start`, `plan`, and `status`.

### First use

From a repository:

```text
/leanrigor:start Add an optional API field and update its consumer
```

LeanRigor bootstraps repository-local state under `.leanrigor/`, including a protective `.gitignore`, then starts or resumes the persisted workflow. Users normally respond with plain language such as:

```text
Approve
Revise the plan to separate the migration
Continue
Repair it
Show status
Cancel
```

Claude invokes LeanRigor transitions internally. Raw CLI commands should appear only for troubleshooting, advanced/manual operation, or explicit user request.

## Command behaviour

### `/leanrigor:start`

Primary conversational workflow entry point. It:

1. discovers and resumes an active workflow or starts one from the supplied request;
2. presents triage, final mode, risk, assumptions, and one blocking clarification when required;
3. presents a post-triage approach gate for Standard and Rigorous work with
   approve, revise, view-details, and cancel actions, and states that no
   implementation has started;
4. creates and presents the phased plan for explicit approval;
5. advances provider-driven coordinator execution or the approved manual fallback;
6. reports persisted phase-gate outcomes rather than model confidence;
7. advances through integration, combined validation, and final integrated review;
8. presents a commit proposal without creating the final commit or pushing.

### `/leanrigor:init`

Shows installation mode, plugin/package version, runtime source, configuration layers, model-tier resolution, execution settings, bootstrap health, managed-asset status, and corrective commands.

Use it after installation, after a marketplace refresh, or when configuration appears stale.

### `/leanrigor:plan`

Shows or advances the current approach and plan. It can accept revision feedback but does not bypass approval gates or implement work.

### `/leanrigor:status`

Reports the persisted workflow state, selected mode, current phase, provider status, completion gate, integration status, validation status, pending user decision, blocker, and next safe action.

### `/leanrigor:review`

Handles phase-completion review outcomes and final integrated review. It records review state rather than creating a second independent review workflow.

### `/leanrigor:commit`

Shows the persisted commit proposal grouped by message, files, and rationale. It clearly states that no final commit or push has occurred.

## Execution paths

LeanRigor separates governance from worker execution.

### Coordinator mode

The `ExecutionCoordinator`:

- derives scheduler-approved phases;
- acquires leases and creates assigned phase worktrees;
- dispatches through an `ExecutionProvider`;
- persists execution handles, provider-session provenance, status, heartbeat,
  timeout, and cancellation state;
- preserves bounded partial-diff checkpoints on provider failure without
  accepting, committing, merging, or integrating the work;
- collects structured results;
- submits validation and completion evidence;
- invokes deterministic completion gates;
- creates internal transfer commits only after a gate passes;
- integrates accepted phases and runs combined validation;
- advances to final integrated review.

Provider process success alone does not complete a phase.

Current providers:

- `scripted` — deterministic provider used for automated disposable-Git testing.
- `claude-cli` — bounded external Claude CLI worker for authenticated live
  smoke testing; native Claude subagents are not implemented in this provider.
- `claude-cli` — prototype provider that runs authenticated Claude Code CLI print mode inside the assigned phase worktree.

### Manual fallback

When coordinator execution is unavailable or explicitly disabled, the active Claude session may implement a phase only inside the LeanRigor-assigned phase workspace. It must run or explicitly skip declared validation and submit persisted completion evidence.

Manual mode does not allow editing in the user's original working tree when Git workspaces are enabled.

## Git workspaces

LeanRigor uses:

- one integration worktree per workflow;
- one isolated phase worktree per active leased phase;
- LeanRigor-owned internal branches and mechanical transfer commits;
- controlled cherry-pick integration in dependency order;
- combined validation tied to the current integration head.

The user's original branch, index, unstaged files, untracked files, stash, and checkout are not modified by workspace operations.

Textual conflicts are detected and persisted for explicit repair. LeanRigor never resolves them by automatically choosing `ours` or `theirs`.

## Marketplace plugin assets

| Path | Purpose |
|---|---|
| `.claude-plugin/marketplace.json` | Marketplace catalogue |
| `.claude-plugin/plugin.json` | Plugin manifest and component list |
| `commands/` | Namespaced marketplace commands |
| `agents/leanrigor-triage.md` | Read-only triage agent |
| `plugin-skills/sequential-workflow/` | Shared workflow instruction |
| `methodology/` | Adapter-neutral engineering methodology and mode overlays |
| `hooks/hooks.json` | Claude plugin hook configuration |
| `hooks/protect-git.sh` | Git safety hook |
| `bin/leanrigor` | Plugin launcher |
| `runtime/leanrigor-cli.js` | Bundled runtime |

The current plugin manifest exposes `start`, `init`, `plan`, `status`, `review`, and `commit`.

## Project-local fallback

The npm package is private and not published as a stable public package. For development or pre-release testing, build and install from source:

```bash
npm install
npm run build
npm pack
npm install -g ./leanrigor-$(node -p "require('./package.json').version").tgz

leanrigor init --adapter claude --root /path/to/repository
leanrigor doctor --adapter claude --root /path/to/repository
```

Project-local initialisation installs LeanRigor-owned assets such as:

```text
.claude/commands/leanrigor.md
.claude/commands/leanrigor-plan.md
.claude/commands/leanrigor-status.md
.claude/commands/leanrigor-review.md
.claude/commands/leanrigor-commit.md
.claude/agents/leanrigor-triage.md
.claude/leanrigor/sequential-workflow.md
.claude/leanrigor/methodology/
.claude/leanrigor/protect-git.sh
.claude/settings.json
```

These expose unqualified project-local commands such as `/leanrigor` and `/leanrigor-status`.

### Safe installation and upgrades

Managed assets use LeanRigor ownership metadata with the current asset version. Installation is repeat-safe:

- missing assets are created;
- exact current assets are left unchanged;
- content-equal adoptable assets may be adopted safely;
- user-created files are not overwritten;
- modified LeanRigor-owned files are reported and preserved;
- `--force-owned-files` restores only LeanRigor-owned files;
- shared `.claude/settings.json` entries are merged without deleting unrelated settings or hooks.

Uninstall removes only LeanRigor-owned, unmodified assets and LeanRigor-specific settings entries.

## Triage agent

`leanrigor-triage`:

- uses the configured `small` capability tier;
- has read-only inspection tools;
- returns one schema-constrained `TriageOutput`;
- recommends but does not execute;
- never has final safety authority.

The runtime validates the output, retries malformed output once, applies deterministic policy, and falls back to deterministic local triage when necessary.

## Git protection hook

The hook blocks Claude-controlled attempts to run:

- `git commit`;
- `git push`;
- `git reset --hard`.

Internal mechanical commits are created by LeanRigor's deterministic Git integration on LeanRigor-owned branches, not by the coding agent through ordinary shell commands.

The hook intentionally fails open on input it cannot parse so malformed hook input does not block unrelated legitimate tool use. Deterministic workflow policy still controls final commit and integration eligibility.

## Diagnostics

Run:

```bash
leanrigor doctor --adapter claude --root /path/to/repository
```

Diagnostics include:

- installation mode and runtime source;
- Git commit, package version, plugin version, and asset version;
- installed marketplace commit/version where available;
- Claude CLI availability;
- effective configuration and model-tier resolution;
- bootstrap and managed-asset health;
- Git hook contents and executable state;
- shadowing risk from stale project-local fallback assets.

## Live-provider smoke test

From a source checkout with an authenticated Claude CLI:

```bash
scripts/smoke-claude-cli-execution.sh
```

The smoke script creates a disposable repository, prepares LeanRigor assets, verifies the hook and diagnostics, runs coordinator execution through the `claude-cli` provider, polls persisted state through completion and integration, records final review, confirms a commit proposal exists, and confirms no final user commit or push occurred. Provider-session IDs appear in diagnostics separately from the LeanRigor workflow ID.

This live-provider smoke is not run in ordinary CI.

## Troubleshooting

When an internal transition fails, Claude should show a concise error and the exact recovery command rather than pretending the workflow advanced.

Useful commands include:

```bash
leanrigor flow active --json --root /path/to/repository
leanrigor flow next <workflow-id> --json --root /path/to/repository
leanrigor flow execution-status <workflow-id> --json --root /path/to/repository
leanrigor flow execution-poll <workflow-id> --provider claude-cli --json --root /path/to/repository
leanrigor flow workspace-status <workflow-id> --json --root /path/to/repository
leanrigor flow integration-status <workflow-id> --json --root /path/to/repository
leanrigor flow status <workflow-id> --json --root /path/to/repository
```

After upgrading or refreshing the marketplace plugin, restart or reload Claude Code when autocomplete still shows old command names.

## Current limitations

- Claude Code is the only supported coding-agent integration.
- The Claude CLI provider is a prototype and requires live local authentication.
- Native Claude subagent orchestration is not integrated.
- Higher parallelism is supported by the coordinator contract but is not yet promoted as a stable autonomous multi-agent user experience.
- Marketplace hook behaviour may vary with Claude Code runtime versions and still requires live platform smoke testing after material changes.
- Semantic conflict repair is not implemented.
