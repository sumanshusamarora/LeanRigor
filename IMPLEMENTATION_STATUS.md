# Implementation status

## Implemented

- Provisional project identity renamed to **LeanRigor**.
- Portable model tiers: `small`, `medium`, `large`, and `inherit`.
- Claude Code defaults use provider-resolved aliases: `haiku`, `sonnet`, and `opus`.
- OpenCode mappings are intentionally unset until the user configures provider-qualified model IDs.
- Model routing is independent from workflow mode.
- Platform-specific and generic environment-variable overrides.
- File configuration precedence: global, repository, explicit `LEANRIGOR_CONFIG`; model environment variables override file configuration.
- Clear missing-model and Claude invocation errors with corrective commands.
- `leanrigor models` configuration command and `leanrigor doctor` diagnostics.
- Automatic model-backed triage with schema validation, deterministic policy overrides, one retry, and deterministic fallback.
- Fast/Standard/Rigorous workflow assessment, introspection rules, review levels, execution graph, file ownership, and commit planning primitives.
- Production TypeScript compilation is separated from test type checking: `npm run build` emits only `src/**/*.ts` to `dist/`, while `npm run typecheck` also checks `tests/**/*.ts` without emitting them.
- The npm binary path is internally consistent: `bin.leanrigor` points to `dist/cli/index.js`, the built CLI entry includes a Node shebang, and package metadata includes `main`, `exports`, `files`, `prepack`, `engines`, description, and MIT licence metadata.
- `leanrigor init` creates LeanRigor configuration and Claude Code scaffold files without silently overwriting existing files.
- Regression tests cover package binary metadata, repeat-safe Claude adapter installation, model-tier defaults/overrides, `inherit` model omission, and malformed model triage fallback.

## Verification commands executed

All commands below were run in this environment on July 23, 2026.

- `npm install` — passed; dependencies installed and audited with no vulnerabilities. npm printed a non-fatal warning about an unknown `http-proxy` env config.
- `npm run typecheck` — passed.
- `npm test` — passed; 8 test files and 33 tests passed.
- `npm run build` — passed.
- `npm run lint` — passed with the repository ESLint flat config.
- `npm pack` — passed and produced `leanrigor-0.1.0-draft.tgz`.
- Clean temporary install of the generated tarball — passed.
- Packed-install `leanrigor --help` — passed.
- Packed-install `leanrigor init --root <temporary-repository>` — passed.
- Repeated packed-install `leanrigor init --root <temporary-repository>` — passed and remained deterministic.
- Packed-install `leanrigor doctor --root <temporary-repository>` — passed.
- Packed-install `leanrigor triage "Fix a README typo" --provider deterministic --root <temporary-repository>` — passed.

## Known remaining limitations

- OpenCode support remains a roadmap item; no OpenCode adapter or orchestration feature was added in this work.
- Parallel execution interfaces and policy primitives exist, but LeanRigor does not autonomously spawn coding agents.
- File leases remain in-memory in the core draft.
- Worktree isolation is documented but not implemented.
- Commit planning remains conservative and requires human review.
- Claude Code integration creates local command/agent scaffolding, but production-grade harness execution depends on the user's local Claude Code installation.

## Next implementation step

Add the OpenCode adapter and interactive model discovery/setup in a future task. It should obtain the models visible to the user's OpenCode installation, let the user assign Small/Medium/Large tiers, verify the selected identifiers, and refuse to enable model-backed execution when required mappings are unavailable.
