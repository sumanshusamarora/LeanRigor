# Changelog

All notable changes to LeanRigor will be documented in this file.

The project follows [Semantic Versioning](https://semver.org/) once public releases begin. Until then, entries may describe unreleased development milestones.

## Unreleased

### Added

- Open-source community health files.
- Structured GitHub issue forms and pull-request template.
- Contributor architecture and release guidance.

### Changed

- README reorganised around verified capabilities, current limitations, safety guarantees, and roadmap themes.

### Fixed

- Removed contradictory README claims about worktree and integration support.

## 0.3.1-draft

### Added

- Auto-bootstrap on first use: any LeanRigor command transparently repairs
  missing project assets when running from the Claude marketplace plugin.
- `ensureBootstrapped()` orchestrator in `src/core/bootstrap.ts` — shared
  bootstrap path for marketplace, CLI, doctor, and workflow start.
- `BootstrapReport` and `bootstrap()` method on `ClaudeAdapter` with ordered
  installation (protect-git.sh before settings.json).
- Content-equality adoption: manually copied plugin assets with matching
  content are safely adopted by writing the ownership token.
- `settings-merger.ts` for safe, non-destructive merge of LeanRigor hook
  entries into shared `.claude/settings.json`.
- New settings states: `shared_missing_leanrigor_entries`,
  `shared_conflicting_leanrigor_entries`, `shared_malformed`, `shared_unwritable`.
- `adoptable` asset status for content-equal non-owned files.
- Bootstrap health section in doctor output.
- `--no-bootstrap` flag on `init-report` for skip-bootstrap inspection.
- Comprehensive tests for settings merger, bootstrap behaviour, and
  marketplace plugin runtime compatibility.

### Changed

- **Breaking:** `protect-git.sh` now installs first in the asset manifest to
  prevent the stale-hook catch-22 (hook configured before script exists).
- `inspectAssets()` uses the settings-merger for `.claude/settings.json`
  state detection instead of simple conflict classification.
- `.claude/settings.json` is no longer classified as a generic asset
  conflict — it is handled as shared configuration.
- `uninstall()` uses `removeLeanRigorHooks()` for settings instead of
  deleting the file.
- `flow start` and `init-report` commands run bootstrap before their
  primary operation.
- `init/setup` delegates to `ensureBootstrapped`.
- Doctor report suppresses "run leanrigor init" messages when running from
  the marketplace plugin.
- `init-report` shows bootstrap repair summary at the top of output.
- Plugin command prompts updated for auto-bootstrap behaviour.
- All versions bumped to 0.3.1-draft (package.json, plugin.json,
  marketplace.json, CLI version).
- Asset version bumped to 5.

### Fixed

- Marketplace plugin users no longer need to run a separate `leanrigor
  init --adapter claude` after plugin installation.
- Stale hook catch-22: `protect-git.sh` is now created before its hook
  entry is added to shared settings.
- Manually copied `protect-git.sh` no longer shows as a conflict — it is
  detected as adoptable and repaired automatically.
- Shared settings preserve unrelated user hooks and configuration.
- Uninstall no longer leaves a stale blocking hook pointing to a missing script.

## 0.2.0-draft

Development draft containing adaptive workflow modes, persistent workflow state, completion gates, methodology assets, Claude Code packaging, worktree isolation, concurrency controls, and provider-neutral execution foundations.

This version was not published as a stable public release.
