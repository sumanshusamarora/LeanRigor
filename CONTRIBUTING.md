# Contributing to LeanRigor

Thank you for your interest in contributing. LeanRigor is an open-source workflow and policy controller for AI coding sessions. Contributions are welcome across code, tests, documentation, examples, provider integrations, and issue triage.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before contributing

Please read:

- [README](README.md) for verified capabilities and current limitations;
- [Contributor architecture](docs/contributor-architecture.md) for ownership boundaries and invariants;
- [Governance](GOVERNANCE.md) for decision-making expectations;
- [Security policy](SECURITY.md) before reporting vulnerabilities;
- [Support policy](SUPPORT.md) for where to ask questions.

LeanRigor is the workflow and policy control plane. Before proposing new infrastructure, check whether a stable native API, CLI, SDK, or library already solves the execution or workspace mechanics.

## Getting started

1. Fork the repository.
2. Clone your fork:

   ```bash
   git clone https://github.com/<your-username>/LeanRigor.git
   cd LeanRigor
   ```

3. Add the upstream remote:

   ```bash
   git remote add upstream https://github.com/sumanshusamarora/LeanRigor.git
   ```

## Development setup

Prerequisites: Node.js 20 or later, npm, and Git.

```bash
npm install
npm run typecheck
npm test
npm run lint
npm run build
npm run validate:claude-plugin
```

Run the CLI directly from the repository:

```bash
npx leanrigor --help
npx leanrigor flow start "Fix a README typo" --provider deterministic --root /path/to/repository
```

## Choosing work

Use the structured GitHub issue forms for:

- bugs;
- feature proposals;
- documentation problems;
- provider, execution, workspace, and integration issues.

Good first issues should be bounded, have clear acceptance criteria, and avoid changing workflow-state or safety architecture without maintainer guidance.

For substantial features or architectural changes, open an issue before implementation. Describe the user problem, relevant ownership boundary, alternatives considered, compatibility concerns, and validation strategy.

## Making changes

1. Create a focused branch from current `main`:

   ```bash
   git checkout main
   git pull --ff-only upstream main
   git checkout -b fix/my-descriptive-change
   ```

2. Make the smallest cohesive change that solves the issue.
3. Add or update tests.
4. Update user-facing documentation and the README feature inventory when capability changes.
5. Keep planned or unverified functionality under Roadmap or Current Limitations.
6. Run the full local verification set:

   ```bash
   npm run typecheck
   npm test
   npm run lint
   npm run build
   npm run validate:claude-plugin
   git diff --check
   ```

7. Use clear, present-tense commit messages, for example:

   ```text
   fix: handle missing config file gracefully
   ```

## Architecture and safety expectations

Contributions must preserve these invariants:

- deterministic policy overrides optimistic model output;
- phases do not complete without evidence and the completion gate;
- failed validation blocks dependent phases;
- the user's original working tree remains safe;
- internal mechanical commits are limited to LeanRigor-owned branches;
- no final user commit, push, deploy, or destructive production write is automatic;
- hidden chain of thought is never persisted.

Changes to workflow states, persistence, leases, workspaces, integration, public contracts, or provider boundaries require migration or compatibility analysis and deterministic regression tests.

## Pull requests

Open pull requests against `main` and use the repository template.

A good pull request:

- explains the problem and why the change belongs in LeanRigor;
- stays focused on one concern;
- links related issues using `Closes #<issue>` or `Fixes #<issue>`;
- distinguishes deterministic responsibilities from prompt-owned behaviour;
- documents safety, compatibility, and migration implications;
- lists tests and smoke scenarios with results;
- updates documentation and feature inventory where needed;
- states remaining limitations and unverified behaviour honestly.

All required CI checks must pass before merge. The maintainer currently uses a maintainer-led review model and may ask for design changes even when implementation tests pass.

## Reporting bugs

Use the bug issue form and include:

- LeanRigor version or commit;
- installation type;
- Node.js, Git, operating-system, and coding-agent versions;
- the smallest reliable reproduction;
- expected and actual behaviour;
- sanitised logs or workflow status;
- whether coordinator mode, worktrees, or a live provider were involved.

Never post credentials, private repository contents, customer data, or sensitive provider transcripts.

## Suggesting features

Lead with the user problem rather than an implementation preference. Explain the current workaround, proposed behaviour, relevant architectural layer, alternatives considered, and risk or compatibility implications.

A similar user-facing tool does not automatically provide a reusable implementation boundary. Where proposing reuse, identify the stable API, CLI, SDK, or library surface.

## Project structure

```text
src/            TypeScript source for CLI, core workflow, adapters, and execution
commands/       Claude Code slash-command markdown files
agents/         Claude agent definitions
hooks/          Claude hook scripts
plugin-skills/  Reusable plugin skill documentation
methodology/    Shared adaptive engineering methodology
runtime/        Bundled runtime helpers
internal-skills/ Internal workflow skills not exposed as commands
templates/      Packaged templates
docs/           User and contributor documentation
tests/          Vitest and disposable Git integration tests
scripts/        Build, validation, and smoke helpers
```

Shared methodology under `methodology/` is adapter-neutral. New adapters should preserve the core policy boundary rather than duplicate workflow logic.

## Releases

Maintainers should follow [RELEASING.md](RELEASING.md). Contributors should not change package versions or publish artifacts unless the issue explicitly covers release preparation.
