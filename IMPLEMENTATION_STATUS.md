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
- `leanrigor models` configuration command and `leanrigor doctor --adapter claude` diagnostics.
- Automatic model-backed triage with schema validation, deterministic policy overrides, one retry, and deterministic fallback.
- Fast/Standard/Rigorous workflow assessment, introspection rules, review levels, execution graph, file ownership, and commit planning primitives.
- Production TypeScript compilation is separated from test type checking: `npm run build` emits only `src/**/*.ts` to `dist/`, while `npm run typecheck` also checks `tests/**/*.ts` without emitting them.
- The npm binary path is internally consistent: `bin.leanrigor` points to `dist/cli/index.js`, the built CLI entry includes a Node shebang, and package metadata includes `main`, `exports`, `files`, `prepack`, `engines`, description, and MIT licence metadata.
- `leanrigor init --adapter claude` installs a formally structured, versioned Claude Code plugin:
  - Five `/leanrigor-*` commands covering the full workflow, plan, status, review, and commit phases.
  - `leanrigor-triage` subagent with read-only tools, configurable model, and self-contained `TriageOutput` contract.
  - `protect-git.sh` hook script blocking automatic `git commit`, `git push`, and `git reset --hard`.
  - `settings.json` configuring the `PreToolUse` hook.
  - All assets tagged with `generated_by: leanrigor | asset_version: 1` for ownership detection.
- Install is repeat-safe: files already matching the packaged version are reported as "already current" without writes.
- Conflict detection: user-created files and user-modified LeanRigor-owned files are skipped and reported.
- `--force-owned-files` flag restores LeanRigor-owned files without touching user files.
- `leanrigor uninstall --adapter claude` removes only LeanRigor-owned unmodified files; user-modified and unrelated files are preserved.
- Enhanced `leanrigor doctor --adapter claude` reports CLI version, Claude CLI availability, model tier resolution, per-asset status, and overall health.
- Plugin source of truth lives in `src/adapters/claude/plugin/`; build step copies assets alongside compiled TypeScript.
- Plugin assets are included in `npm pack` via `dist/` and verified present in the tarball.
- Regression tests cover: clean install, repeat-safe install, conflict detection, force-replace, uninstall, doctor output, asset structure, model tier substitution, and JSON validity.

## Verification commands executed

All commands below were run in this environment on July 23, 2026.

- `npm install` — passed.
- `npm run typecheck` — passed.
- `npm test` — passed; 9 test files and 61 tests passed.
- `npm run build` — passed; plugin assets copied to `dist/adapters/claude/plugin/`.
- `npm run lint` — passed.
- `npm pack` — passed; tarball contains all 8 plugin assets.
- Clean temporary install of the generated tarball — passed.
- Packed-install `leanrigor --help` — passed.
- Packed-install `leanrigor init --adapter claude --root <temporary-repository>` — passed; 8 assets installed.
- Packed-install `leanrigor doctor --adapter claude --root <temporary-repository>` — passed; "Status: current".
- Repeated `leanrigor init --adapter claude` — passed; all 8 assets reported "already current".
- Modified one generated asset; repeated init — passed; modified file correctly skipped.
- Added unrelated `.claude` file; ran `leanrigor uninstall --adapter claude` — passed; unrelated file preserved, modified owned file preserved, unmodified owned files removed.
- Packed-install `leanrigor triage "Fix a README typo" --provider deterministic --root <temporary-repository>` — passed.

## Known remaining limitations

- OpenCode support remains a roadmap item; no OpenCode adapter was added.
- Parallel execution interfaces and policy primitives exist, but LeanRigor does not autonomously spawn coding agents.
- File leases remain in-memory in the core draft.
- Worktree isolation is documented but not implemented.
- Commit planning remains conservative and requires human review.
- Hook execution behaviour was not tested; Claude Code is not installed in this environment.
  Hook format follows Claude Code `settings.json` `PreToolUse` conventions.
- The `skills/` directory is included in the npm package for reference but is not currently installed to the target repository by `leanrigor init`.

## Next implementation step

Add the OpenCode adapter and interactive model discovery/setup in a future task.

