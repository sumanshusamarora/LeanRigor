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
leanrigor init --root /path/to/repository
leanrigor doctor --root /path/to/repository
leanrigor triage "Fix a README typo" --provider deterministic --root /path/to/repository
```

`leanrigor init` creates `.leanrigor/config.json` plus Claude Code command and triage-agent scaffolding under `.claude/`. The setup flow detects top-level repository guidance files such as `AGENTS.md`, `CLAUDE.md`, and `CONTRIBUTING.md`, then records references to them in LeanRigor configuration rather than duplicating their contents.

`leanrigor init` is repeat-safe: if `.leanrigor/config.json` or Claude Code command files already exist, LeanRigor preserves the existing files instead of silently overwriting user changes.

Configuration lives in `.leanrigor/config.json`. The `$schema` field points at `../node_modules/leanrigor/config.schema.json` for editor validation when LeanRigor is installed in the target repository. A generated standalone schema is included in this package at `config.schema.json`.

Use `leanrigor doctor` to display the active triage profile, resolved Claude model aliases or custom identifiers, and adapter installation state.
