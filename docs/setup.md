# Setup and configuration

LeanRigor is currently a private, locally installable TypeScript CLI package. Verified setup from this repository is:

```bash
npm install
npm run build
npm pack
```

The generated tarball can be installed into a clean temporary project, after which the `leanrigor` binary is available from npm's `.bin` directory or through `npx leanrigor`.

## CLI commands

```bash
leanrigor --help

# Initialise a repository (creates config + installs Claude plugin assets)
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
```

## Initialisation

`leanrigor init --adapter claude` creates `.leanrigor/config.json` and installs
the Claude Code plugin assets under `.claude/`. The setup flow detects top-level
repository guidance files such as `AGENTS.md`, `CLAUDE.md`, and
`CONTRIBUTING.md`, then records references to them in LeanRigor configuration.

### Installed assets

```
.leanrigor/config.json
.claude/commands/leanrigor.md
.claude/commands/leanrigor-plan.md
.claude/commands/leanrigor-status.md
.claude/commands/leanrigor-review.md
.claude/commands/leanrigor-commit.md
.claude/agents/leanrigor-triage.md
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

## Diagnostics

`leanrigor doctor --adapter claude` reports:

- LeanRigor CLI version
- Claude CLI availability on PATH
- Resolved Claude model for each tier (small / medium / large)
- Each installed asset's status (current / missing / modified / conflict)

Example output:

```
LeanRigor CLI: 0.1.0-draft
Platform: Claude Code
Claude assets available: 1
Claude CLI: not found on PATH

Model tier resolution:
  small: haiku (source: config, Claude alias)
  medium: sonnet (source: config, Claude alias)
  large: opus (source: config, Claude alias)

Claude assets installed: 8/8
Status: current
```

