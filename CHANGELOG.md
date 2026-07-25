# Changelog

All notable changes to LeanRigor are documented in this file.

The project follows [Semantic Versioning](https://semver.org/) for public releases. During early development, `-dev.N` versions identify synchronised marketplace and package snapshots that may not be published to npm.

## Unreleased

### Changed

- Redesigned the README as a concise product and onboarding page with a clearer Fast/Standard/Rigorous explanation, quick-start path, architecture visual, honest early-stage status, and contribution invitation.
- Moved the Superpowers comparison near the top and clarified LeanRigor's proportional-rigor and deterministic-control distinction without presenting the projects as universal replacements for one another.
- Documented the founder's observed 5–20× overhead on some small comprehensive-workflow tasks as personal experience rather than a controlled benchmark.
- Refreshed product, architecture, methodology, Claude Code, marketplace, setup, configuration, implementation-status, and release documentation against current `main` behaviour.

### Fixed

- Removed stale claims that Git worktrees, provider-driven execution, configuration layers, and execution coordination were still entirely future work.
- Removed public npm installation instructions that implied the private package was already published.
- Corrected command inventories to include `/leanrigor:init`.
- Updated release/version documentation for the current `-dev.N` development version scheme.
- Updated the package-content CI expectation to include the `init` command.

## 0.3.1-dev.2

### Added

- Auto-bootstrap on first use: LeanRigor marketplace commands repair missing repository assets before normal operation.
- Scope-aware user preferences, committed repository policy, local configuration, provenance, and policy-constraint reporting.
- `/leanrigor:init` and deterministic `init-report` configuration diagnostics.
- Content-equality adoption for safe recovery of matching manually copied assets.
- Non-destructive shared `.claude/settings.json` hook merging and removal.
- Marketplace version and `.leanrigor/.gitignore` reporting coverage.
- Development version synchronization, version checks, and safe marketplace refresh tooling.

### Changed

- `protect-git.sh` is installed before its hook entry to avoid stale-hook bootstrap failures.
- Marketplace and project-local bootstrap share the same deterministic orchestration path.
- Doctor and init reports distinguish marketplace and package versions, runtime source, configuration layers, and managed-asset state.
- Plugin and package versions are synchronised from `package.json`.
- The current generated asset version is `5`.

### Fixed

- Marketplace users no longer need a separate project-local init step after plugin installation.
- Shared settings preserve unrelated user hooks and configuration.
- Uninstall no longer leaves a LeanRigor hook pointing to a missing script.
- Marketplace plugin version reporting reads the installed plugin manifest before package fallback.
- Gitignore status is rendered without duplicated path prefixes.

## 0.2.0-draft

Development draft containing adaptive workflow modes, persisted workflow state, completion gates, methodology assets, Claude Code packaging, Git worktree isolation, concurrency controls, and provider-neutral execution foundations.

This version was not published as a stable public release.
