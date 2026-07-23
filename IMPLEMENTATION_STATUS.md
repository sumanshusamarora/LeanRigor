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
- Persisted sequential workflow orchestration for Claude Code:
  - `leanrigor flow start`, `answer`, `approve-approach`, `reject-approach`, `approve-plan`, `revise-plan`, `phase-start`, `phase-complete`, `phase-status`, `repair`, `record-validation`, `record-review`, `commit-plan`, `complete`, `active`, `next`, `status`, `list`, `resume`, and `cancel`.
  - Versioned workflow files under `.leanrigor/workflows/<workflow-id>.json`.
  - Explicit lifecycle states from `created` through `awaiting_commit_approval`, plus `completed`, `blocked`, and `cancelled`.
  - Atomic revisioned writes, persistent workflow locks, schema validation on read/write, corrupted-state errors, and structured revision conflicts.
  - Explicit phase DAG states (`planned`, `ready`, `leased`, `running`, `completion_pending`, `completed`, repair/review/replan/block states), durable phase leases, stale lease recovery, ready-phase scheduling, ownership metadata, and conservative path-conflict detection.
  - At most one blocking clarification, mode-specific approach gates, explicit plan approval, small cohesive phase sizing, per-phase completion gates, criterion evidence, default sequential execution, validation evidence, scope deviation escalation, bounded per-phase and integrated repair loops, final integrated review, replan/blocked handling, and commit proposals without commit execution.
  - Claude UX helpers for active workflow selection and next-gate summaries so commands can render conversational status without exposing raw CLI syntax during normal use.
- Native Claude Code marketplace plugin packaging:
  - `.claude-plugin/marketplace.json` for `/plugin marketplace add sumanshusamarora/LeanRigor`.
  - `.claude-plugin/plugin.json` for `/plugin install leanrigor@leanrigor`.
  - Global `/leanrigor:start`, `/leanrigor:plan`, `/leanrigor:status`,
    `/leanrigor:review`, and `/leanrigor:commit` commands, triage agent,
    workflow skill, hook config, plugin launcher, and bundled runtime.
  - Marketplace and project-local command assets now treat `/leanrigor:start`
    as the primary conversational workflow and reserve raw commands for
    troubleshooting/manual use.
  - Shared engineering methodology assets under `methodology/`, referenced by
    marketplace workflow skills and copied into project-local fallback installs.
  - `npm run build:claude-plugin` bundles the CLI and dependencies to `runtime/leanrigor-cli.js`.
  - `npm run validate:claude-plugin` validates manifests, assets, executable bits, path containment, versions, and runs `claude plugin validate . --strict` when available.
- Production TypeScript compilation is separated from test type checking: `npm run build` emits only `src/**/*.ts` to `dist/`, while `npm run typecheck` also checks `tests/**/*.ts` without emitting them.
- The npm binary path is internally consistent: `bin.leanrigor` points to `dist/cli/index.js`, the built CLI entry includes a Node shebang, and package metadata includes `main`, `exports`, `files`, `prepack`, `engines`, description, and MIT licence metadata.
- `leanrigor init --adapter claude` installs formally structured, versioned
  project-local Claude Code assets:
  - Five `/leanrigor-*` commands covering the full workflow, plan, status, review, and commit phases.
  - Shared `.claude/leanrigor/sequential-workflow.md` command reference.
  - Shared methodology copied into `.claude/leanrigor/methodology/`.
  - `leanrigor-triage` subagent with read-only tools, configurable model, and self-contained `TriageOutput` contract.
  - `protect-git.sh` hook script blocking automatic `git commit`, `git push`, and `git reset --hard`.
  - `settings.json` configuring the `PreToolUse` hook.
  - Command/workflow assets tagged with `generated_by: leanrigor | asset_version: 3`; methodology assets carry the same ownership marker.
- Install is repeat-safe: files already matching the packaged version are reported as "already current" without writes.
- Conflict detection: user-created files and user-modified LeanRigor-owned files are skipped and reported.
- `--force-owned-files` flag restores LeanRigor-owned files without touching user files.
- `leanrigor uninstall --adapter claude` removes only LeanRigor-owned unmodified files; user-modified and unrelated files are preserved.
- Enhanced `leanrigor doctor --adapter claude` reports CLI version, Claude CLI availability, model tier resolution, per-asset status, and overall health.
- Plugin command/agent/hook source lives in `src/adapters/claude/plugin/`; shared methodology source lives in `methodology/`.
- Plugin assets are included in `npm pack` via `dist/` and verified present in the tarball.
- Regression tests cover: clean install, repeat-safe install, conflict detection, force-replace, uninstall, doctor output, asset structure, model tier substitution, and JSON validity.

## Verification commands executed

All commands below were run in this environment on July 23, 2026.

- `npm install` — passed.
- `npm run typecheck` — passed.
- `npm test` — passed; 14 test files and 138 tests passed.
- `npm run build` — passed; plugin assets copied to `dist/adapters/claude/plugin/`.
- `npm run validate:claude-plugin` — passed.
- `npm run lint` — passed.
- `npm pack --pack-destination <temporary-directory> --json` — passed; tarball
  contains project-local Claude assets, native marketplace plugin files,
  methodology assets, bundled runtime, and the workflow concurrency modules.
- Clean temporary install of the generated tarball — passed.
- Packed-install `leanrigor --help` — passed.
- Packed-install `leanrigor init --adapter claude --root <temporary-repository>` — passed; 21 assets installed.
- Packed-install `leanrigor doctor --adapter claude --root <temporary-repository>` — passed; "Status: current".
- Packed-install methodology parity check — passed; `.claude/leanrigor/methodology/core.md`
  matched the packaged shared methodology source.
- Repeated `leanrigor init --adapter claude` — passed; all 21 assets reported "already current".
- Modified one generated asset; repeated init — passed; modified file correctly skipped.
- Added unrelated `.claude` file; ran `leanrigor uninstall --adapter claude` — passed; unrelated file preserved, modified owned file preserved, unmodified owned files removed.
- Packed-install `leanrigor triage "Fix a README typo" --provider deterministic --root <temporary-repository>` — passed.
- Deterministic methodology smoke scenarios — passed:
  - Fast `Fix a typo in README` stayed in Fast mode, produced one phase, and
    used targeted validation.
  - Standard `Add a new optional API field and update its frontend consumer`
    produced public-contract, consumer, and regression-coverage phases.
  - Rigorous `Add a database migration affecting authenticated production
    requests` isolated the migration contract and used deep review/large model
    tiers.
  - Debugging `Fix an intermittent duplicate-processing bug` escalated to
    Rigorous because duplicate-processing is treated as a concurrency or
    idempotency risk trigger.
- Packed-tarball smoke test in a clean temporary Git repository — passed:
  - installed LeanRigor,
  - ran `leanrigor init --adapter claude`,
  - started a Fast workflow and progressed it to commit proposal,
  - started a Standard workflow and confirmed plan approval was required,
  - started a Rigorous workflow with an authentication/production/credential trigger,
  - resumed an interrupted workflow,
  - confirmed no Git commit existed,
  - ran `leanrigor doctor --adapter claude`,
  - confirmed unrelated `.claude` files remained untouched.
- Packed-tarball phase-gate smoke test in disposable Git repositories — passed:
  - started a Fast task and verified one concise phase,
  - completed it with structured criterion and validation evidence,
  - confirmed the completion gate passed before commit proposal,
  - started a Standard backend/frontend task and confirmed three cohesive phases,
  - deliberately failed validation in phase 1,
  - confirmed phase 2 stayed locked and phase 1 moved to `needs_repair`,
  - repaired phase 1 and resubmitted passing evidence,
  - confirmed phase 2 unlocked after the gate passed,
  - introduced an unexpected documentation-phase runtime change,
  - confirmed `needs_replan` or `needs_review`,
  - confirmed no automatic commit was created.
- Packed-tarball conversational UX smoke test in disposable Git repositories — passed:
  - verified `flow active --json` returns `none`, `one`, and `multiple`,
  - verified `flow next --json` returns `Approach approval` and `Plan approval`
    labels without raw approval commands,
  - verified approving approach internally advances to persisted plan approval,
  - verified human `flow status` output is concise and command-free,
  - confirmed no automatic commit was created.
- Real Claude Code conversational smoke for this methodology iteration was not
  run: `claude --version` reported `2.1.214 (Claude Code)`, but
  `claude auth status` reported `loggedIn: false`.
- Native Claude Code marketplace smoke from this working tree — partially
  verified in a real Claude Code session:
  - `claude plugin marketplace add ./` — passed.
  - `claude plugin install leanrigor@leanrigor -s user` — passed.
  - The previous marketplace command surface started a Fast workflow in a
    disposable Git repository.
  - The workflow created `.leanrigor/`, did not create `.claude/`, edited a
    small README typo after approval, recorded validation and review evidence,
    generated a commit proposal, and did not commit or push.
  - A status command was available in a second unrelated repository without
    local asset installation.
  - `claude plugin uninstall leanrigor@leanrigor -s user --keep-data` removed
    the commands; reinstall restored them while repository workflow state
    remained intact.
  - The remote GitHub marketplace path has since been made available.
  - Unqualified `/leanrigor` was not exposed by the current marketplace plugin
    runtime; current Claude Code exposes marketplace plugin commands with the
    plugin namespace.
- Marketplace command naming cleanup is implemented and must be verified by the
  next real Claude Code autocomplete smoke:
  - expected commands: `/leanrigor:start`, `/leanrigor:plan`,
    `/leanrigor:status`, `/leanrigor:review`, and `/leanrigor:commit`;
  - old redundant commands such as `/leanrigor:leanrigor` and
    `/leanrigor:leanrigor-status` should not appear;
  - internal workflow skills moved to `internal-skills/` so `triage-task` and
    `prepare-commits` are not exposed as marketplace commands.

## Known remaining limitations

- Current Claude Code marketplace commands are namespaced by plugin name. Use
  `/leanrigor:start` for marketplace installs and the npm/project-local
  fallback for unqualified `/leanrigor`.
- OpenCode support remains a roadmap item; no OpenCode adapter was added.
- Parallel-ready workflow locks, phase leases, DAG scheduling, and ownership conflict checks exist, but this workflow does not autonomously spawn coding agents.
- Worktree isolation is documented but not implemented.
- Commit planning remains conservative and requires human review.
- Hook asset installation and path resolution are tested. Live hook firing in
  Claude Code was not independently triggered during the marketplace smoke.
- Internal workflow skills live under `internal-skills/` so Claude marketplace
  installs do not expose them as user-facing commands.
- Shared methodology lives under `methodology/`, not root `skills/`, so it is
  internal reference material rather than a user-facing slash command surface.

## Next implementation step

Run a real authenticated Claude Code before/after behavior smoke for a Standard
task, then publish/refresh the marketplace plugin from a clean tree after
validation.
