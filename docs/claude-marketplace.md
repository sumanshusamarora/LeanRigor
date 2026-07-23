# Claude Marketplace Plugin

LeanRigor's recommended Claude Code installation path is the native plugin
marketplace:

```text
/plugin marketplace add sumanshusamarora/LeanRigor
/plugin install leanrigor@leanrigor
```

The marketplace file is `.claude-plugin/marketplace.json`; the plugin manifest
is `.claude-plugin/plugin.json`.

## Verified Conventions

Current Claude Code documentation says:

- `.claude-plugin/marketplace.json` at the repository root defines a marketplace
  with `name`, `owner`, and `plugins`.
- `.claude-plugin/plugin.json` defines plugin metadata and component paths.
- Plugin components live at plugin-root paths, not inside `.claude-plugin/`.
- Marketplace-installed plugins are copied into Claude's plugin cache and cannot
  depend on paths outside the plugin root.
- `${CLAUDE_PLUGIN_ROOT}` resolves to the installed plugin directory.
- `bin/` executables are added to the Bash tool `PATH` while the plugin is
  enabled.
- Hook commands may reference `${CLAUDE_PLUGIN_ROOT}`.
- User-scope plugin installation is global across projects by default.
- Root `commands/` and `skills/` entries are user-facing. LeanRigor therefore
  keeps internal workflow reference skills under `internal-skills/`.

## Runtime Strategy

LeanRigor bundles the compiled CLI and dependencies into:

```text
runtime/leanrigor-cli.js
```

Claude commands invoke:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/leanrigor" flow ...
```

The launcher:

- resolves `${CLAUDE_PLUGIN_ROOT}`;
- checks that Node is available;
- invokes the bundled runtime;
- preserves arguments and exit codes;
- works with paths containing spaces;
- never loads code from the target repository.

Node.js 20 or newer is required.

Current Claude Code marketplace installs expose plugin slash commands with the
plugin namespace:

```text
/leanrigor:start
/leanrigor:plan
/leanrigor:status
/leanrigor:review
/leanrigor:commit
```

Claude Code namespaces marketplace plugin commands as `/plugin-name:command`.
LeanRigor therefore keeps the command segment concise. The primary entry point
is `/leanrigor:start`.

The npm/project-local fallback still exposes unqualified commands such as
`/leanrigor` because it installs command files into the target repository's
`.claude/commands/` directory.

## Global Versus Local State

Marketplace mode:

```text
Global plugin:
  commands
  agents
  plugin skill
  hook
  bundled runtime

Per repository:
  .leanrigor/config.json
  .leanrigor/workflows/
```

Marketplace mode does not create `.claude/` in the target repository.

Manual/project-local fallback:

```bash
npm install -g leanrigor
leanrigor init --adapter claude
```

This fallback installs `.claude/` assets into a specific repository and remains
supported for users who cannot use Claude's plugin marketplace.

## First Use

On first `/leanrigor:start` use in a repository, the bundled runtime
creates `.leanrigor/config.json` if it is missing, records safe defaults, and
detects top-level `AGENTS.md`, `CLAUDE.md`, and `CONTRIBUTING.md` references.
Workflow files are created under `.leanrigor/workflows/` as needed.

## Validation

Run:

```bash
npm run build
npm run validate:claude-plugin
```

The validator checks manifests, referenced assets, command and agent
frontmatter, hook paths, executable bits, bundled runtime presence, path
containment, version consistency, and runs `claude plugin validate . --strict`
when the Claude CLI is available.

## Release Procedure

Update the package version once in `package.json`, then run:

```bash
npm run build
npm run validate:claude-plugin
npm test
npm pack
```

Keep `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, and
`runtime/leanrigor-cli.js` in sync with that version before publishing a
marketplace release. Do not publish from a tree where `npm run
validate:claude-plugin` fails.

## Limitations

- After marketplace updates, Claude Code may need a plugin refresh, reinstall,
  or restart before autocomplete drops older command names.
- Current Claude Code marketplace commands are plugin-namespaced. Use
  `/leanrigor:start`; use the npm/project-local fallback for unqualified
  `/leanrigor`.
- The plugin requires Node on PATH.
- The plugin remains sequential; parallel agents, worktrees, OpenCode, Codex,
  and CodeGraph are future work.
- Per-phase completion gates are implemented in the bundled runtime and exposed
  through `flow phase-complete`, `flow phase-status`, and `flow repair`.
