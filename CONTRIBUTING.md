# Contributing to LeanRigor

Thank you for your interest in contributing! LeanRigor is an open-source workflow
controller for AI coding sessions. Contributions of all kinds are welcome: bug
reports, feature ideas, documentation improvements, and code changes.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)
- [Project Structure](#project-structure)

## Code of Conduct

Be respectful and constructive. Harassment, personal attacks, and discriminatory
language are not tolerated. Treat every contributor as a peer.

## Getting Started

1. Fork the repository on GitHub.
2. Clone your fork locally:
   ```bash
   git clone https://github.com/<your-username>/LeanRigor.git
   cd LeanRigor
   ```
3. Add the upstream remote so you can pull future changes:
   ```bash
   git remote add upstream https://github.com/sumanshusamarora/LeanRigor.git
   ```

## Development Setup

**Prerequisites:** Node.js 20 or later, npm.

```bash
# Install dependencies
npm install

# Type-check the project
npm run typecheck

# Run the test suite
npm test

# Run the linter
npm run lint

# Build the project
npm run build

# Validate the Claude plugin manifest
npm run validate:claude-plugin
```

You can also run the CLI directly from the repository without a global install:

```bash
npx leanrigor --help
npx leanrigor flow start "Fix a README typo" --provider deterministic --root /path/to/repository
```

## Making Changes

1. Create a focused branch from `main`:
   ```bash
   git checkout -b fix/my-descriptive-change
   ```
2. Make the smallest change that addresses the issue or feature.
3. Add or update tests to cover your change.
4. Ensure all checks pass locally before opening a PR:
   ```bash
   npm run typecheck
   npm test
   npm run lint
   npm run build
   npm run validate:claude-plugin
   ```
5. Keep commits atomic and use a clear, present-tense commit message
   (e.g., `fix: handle missing config file gracefully`).

## Pull Request Guidelines

- Open PRs against the `main` branch.
- Describe **what** changed and **why** in the PR body.
- Reference any related issues with `Closes #<issue>` or `Fixes #<issue>`.
- Keep each PR focused on a single concern; separate unrelated changes into
  separate PRs.
- All CI checks must pass before a PR can be merged.
- A maintainer will review your PR; please respond to review feedback promptly.

## Reporting Bugs

Open an issue and include:

- A clear title and description of the problem.
- Steps to reproduce the issue reliably.
- Expected vs. actual behaviour.
- Your Node.js version, OS, and LeanRigor version (`leanrigor --version`).
- Any relevant log output or error messages.

## Suggesting Features

Open an issue describing:

- The problem or use case you want addressed.
- Your proposed solution or approach (if you have one).
- Any alternatives you considered.

Feature requests are evaluated against the project's design goals: proportional
ceremony, portable model routing, and minimal automation ceremony for low-risk
changes.

## Project Structure

```
src/          TypeScript source (CLI, adapters, engine, runtime)
commands/     Claude Code slash-command markdown files
agents/       Claude agent CLAUDE.md files
hooks/        Claude hook scripts
plugin-skills/ Reusable skill documentation for the plugin
methodology/  Shared engineering methodology used by all workflow modes
runtime/      Runtime helpers loaded by the Claude adapter
docs/         User-facing documentation
tests/        Vitest test suite
scripts/      Build and validation helpers
```

Shared methodology under `methodology/` is intentionally adapter-agnostic.
When adding a new adapter, follow the pattern in `src/adapters/claude/`.
