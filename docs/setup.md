# Setup and configuration

LeanRigor is currently a private, locally installable TypeScript CLI package. Verified setup from this repository is:

```bash
npm install
npm run build
npm pack
```

The generated tarball can be installed into a clean temporary project, after which the `leanrigor` binary is available from npm's `.bin` directory or through `npx leanrigor`.

## Claude Code Marketplace Installation

Recommended:

```text
/plugin marketplace add sumanshusamarora/LeanRigor
/plugin install leanrigor@leanrigor
```

This installs LeanRigor globally in Claude Code. Current marketplace installs
expose namespaced commands such as `/leanrigor:start` and
`/leanrigor:status`. On first use in a repository, LeanRigor creates
`.leanrigor/config.json` and later `.leanrigor/workflows/`; it does not create
`.claude/`.

## CLI commands

```bash
leanrigor --help

# Fallback: initialise a repository (creates config + installs local Claude assets)
leanrigor init --adapter claude --root /path/to/repository

# Re-run after updating leanrigor to upgrade assets
leanrigor init --adapter claude --root /path/to/repository

# Force-replace LeanRigor-owned files that have been user-modified
leanrigor init --adapter claude --force-owned-files --root /path/to/repository

# Check status of installed assets and model tier resolution
leanrigor doctor --adapter claude --root /path/to/repository

# Remove all LeanRigor-owned unmodified files
leanrigor uninstall --adapter claude --root /path/to/repository

# Also remove .leanrigor/config.json
leanrigor uninstall --adapter claude --remove-config --root /path/to/repository

# Triage a request using the deterministic classifier
leanrigor triage "Fix a README typo" --provider deterministic --root /path/to/repository

# Triage using the configured small model (auto falls back to deterministic)
leanrigor triage "Fix the assignment regression" --provider auto --root /path/to/repository

# Start and resume the persisted sequential workflow
leanrigor flow start "Fix the assignment regression" --provider auto --root /path/to/repository
leanrigor flow active --json --root /path/to/repository
leanrigor flow next <workflow-id> --json --root /path/to/repository
leanrigor flow status <workflow-id> --root /path/to/repository
leanrigor flow resume <workflow-id> --root /path/to/repository
```

In Claude Code, prefer `/leanrigor:start` for normal workflow use. Claude
invokes LeanRigor transitions internally and renders human-readable gates, so
users should not need to copy-paste shell commands unless troubleshooting or
manually operating the CLI.

## Initialisation

`leanrigor init --adapter claude` creates `.leanrigor/config.json` and installs
the Claude Code plugin assets under `.claude/`. The setup flow detects top-level
repository guidance files such as `AGENTS.md`, `CLAUDE.md`, and
`CONTRIBUTING.md`, then records references to them in LeanRigor configuration.

Marketplace users do not need this command. Use it only for the npm/manual
fallback or when you want repository-local unqualified commands such as
`/leanrigor`.

### Installed assets

```
.leanrigor/config.json
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

### Conflict handling

`leanrigor init` is repeat-safe and non-destructive:

- Files that do not exist are created.
- Files already matching the packaged version are reported as "already current".
- User-created files without LeanRigor ownership metadata are skipped.
- LeanRigor-owned files that have been locally modified are skipped and reported.

Use `--force-owned-files` to restore LeanRigor-owned files to the packaged
version. Non-owned files are never overwritten, even with `--force-owned-files`.

## Configuration

Configuration lives in `.leanrigor/config.json`. The `$schema` field points at
`../node_modules/leanrigor/config.schema.json` for editor validation when
LeanRigor is installed in the target repository.

Use `leanrigor models` to configure portable model tiers:

```bash
leanrigor models --claude-small claude-haiku-4-5 --root /path/to/repository
```

Phase sizing and completion-gate defaults are configurable while preserving
backward-compatible behavior:

```json
{
  "completionGate": {
    "enabled": true,
    "requireEvidence": true,
    "requireValidation": true,
    "allowSkippedValidation": {
      "fast": true,
      "standard": false,
      "rigorous": false
    },
    "maxRepairAttempts": {
      "fast": 1,
      "standard": 2,
      "rigorous": 2
    }
  },
  "taskSizing": {
    "maxPrimaryObjectives": 1,
    "preferredWriteFiles": 5,
    "reviewSplitThresholdFiles": 8,
    "requireSplitWhen": [
      "multiple architectural boundaries",
      "independent backend and frontend outcomes",
      "database migration plus application behaviour",
      "public contract plus consumer updates",
      "implementation mixed with unrelated refactoring"
    ]
  }
}
```

These are heuristics, not mechanical file-count limits.

Methodology files are not configured individually. They are packaged under
`methodology/` and copied into `.claude/leanrigor/methodology/` for
project-local installs. Mode and risk policy select which guidance applies.

## Diagnostics

`leanrigor doctor --adapter claude` reports:

- LeanRigor CLI version
- Claude CLI availability on PATH
- Resolved Claude model for each tier (small / medium / large)
- Each installed asset's status (current / missing / modified / conflict)

Example output:

```
LeanRigor CLI: 0.2.0-draft
Platform: Claude Code
Claude assets available: 2
Claude CLI: not found on PATH

Model tier resolution:
  small: haiku (source: config, Claude alias)
  medium: sonnet (source: config, Claude alias)
  large: opus (source: config, Claude alias)

Claude assets installed: 21/21
Status: current
```

## Troubleshooting workflow commands

If a Claude command cannot invoke LeanRigor automatically, it should show:

```text
I could not run the LeanRigor transition automatically.

You can retry, or run:
<exact command>

Error:
<concise error>
```

For manual diagnosis:

```bash
leanrigor flow active --json --root /path/to/repository
leanrigor flow next <workflow-id> --json --root /path/to/repository
leanrigor flow ready <workflow-id> --json --root /path/to/repository
leanrigor flow workspace-status <workflow-id> --json --root /path/to/repository
leanrigor flow integration-status <workflow-id> --json --root /path/to/repository
leanrigor flow events <workflow-id> --json --root /path/to/repository
leanrigor flow status <workflow-id> --json --root /path/to/repository
```

`active` excludes completed and cancelled workflows by default. When multiple
active workflows exist, choose by workflow ID instead of starting another
workflow accidentally.

Revision conflicts mean another process updated the workflow between read and
write. Reread status/next, then decide the next transition from the latest
state. Lease commands are intended for troubleshooting or adapter internals;
normal Claude usage should not display them unless a transition fails.

## Workspace troubleshooting

Git workspace setup writes worktrees outside the repository by default:

```text
<repository-parent>/.leanrigor-worktrees/<repository-name>/<workflow-id>/
```

Use:

```bash
leanrigor flow git-preflight --json --root /path/to/repository
leanrigor flow workspace-status <workflow-id> --json --root /path/to/repository
leanrigor flow workspace-recover <workflow-id> --json --root /path/to/repository
leanrigor flow workspace-cleanup <workflow-id> --mode safe --json --root /path/to/repository
```

Dirty original worktrees are allowed, but uncommitted user changes are outside
the frozen LeanRigor base commit. LeanRigor does not stash or copy them. If a
task depends on those uncommitted changes, stop and ask for an explicit decision
before continuing.

Cleanup verifies LeanRigor ownership metadata before deleting anything. Safe
cleanup refuses dirty, conflicted, unintegrated, or ownership-uncertain
worktrees and preserves the integration workspace by default. No remote branch
is deleted.
