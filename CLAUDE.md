# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```bash
npm install                    # Install dependencies (Node.js >=20 required)
npm run build                  # Compile TypeScript, copy plugin assets, bundle CLI runtime
npm test                       # Run Vitest suite (vitest run)
npm run test:watch             # Run Vitest in watch mode
npm run typecheck              # Type-check src + tests without emitting
npm run lint                   # ESLint across the project
npm run check                  # Type-check then run tests
npm run validate:claude-plugin # Validate marketplace plugin manifests
npm run build:claude-plugin    # Bundle CLI into runtime/leanrigor-cli.js (included in build)
```

Run the CLI from source: `npx leanrigor --help` or `npx leanrigor flow start "request" --provider deterministic --root /path/to/repo`.

Run a single test file: `npx vitest run tests/flow.test.ts`.

## Architecture

LeanRigor is a **workflow controller for AI coding sessions** — it helps an agent calibrate how much planning, validation, and review a task needs instead of applying the same ceremony to every change. It ships primarily as a Claude Code marketplace plugin, with a TypeScript CLI at its core.

### Three layers

1. **Workflow specification** — `methodology/` (adapter-agnostic engineering guidance), `commands/`, `agents/`, `plugin-skills/`, `internal-skills/`
2. **Orchestration core** (`src/core/`) — workflow state machine, triage, DAG scheduling, phase leases, completion gates, validation, Git workspace isolation, commit planning
3. **Harness adapters** (`src/adapters/`) — Claude Code first; `src/adapters/types.ts` defines the adapter interface

The core never selects vendor-specific model names. It routes by **capability profiles**: `small`, `medium`, `large`, `inherit`. Adapters resolve these to actual models.

### Source layout (`src/`)

| Directory | Purpose |
|---|---|
| `src/cli/index.ts` | Commander.js CLI entry point; all `leanrigor flow *` commands |
| `src/core/flow.ts` | Central orchestration — creates/transitions workflows through the full lifecycle |
| `src/core/workflow.ts` | Low-level workflow persistence helpers |
| `src/core/workflow-store.ts` | Atomic revisioned writes with persistent locks |
| `src/core/triage-runner.ts` | Model-backed triage with schema validation, retry, deterministic fallback |
| `src/core/triage-schema.ts` | Zod schema for `TriageOutput` — the fixed contract the triage agent must return |
| `src/core/types.ts` | All domain types: workflow states, phase states, triage output, completion gates |
| `src/core/execution/` | Execution coordinator, scripted provider (tests/deterministic), Claude CLI provider (prototype) |
| `src/core/execution-graph.ts` | Phase DAG — dependency ordering, readiness, ownership conflict detection |
| `src/core/git-workspace.ts` | Git worktree isolation for phase and integration workspaces |
| `src/core/ownership.ts` | File ownership tracking and path-conflict detection |
| `src/core/commit-planner.ts` | Commit proposal generation (never auto-commits or pushes) |
| `src/core/review-policy.ts` | Review level rules (sanity/integrated/deep/specialist) by mode |
| `src/core/ux.ts` | Claude UX helpers — active workflow selection, next-gate summaries |
| `src/core/assessment.ts` | Mode/routing assessment from risk and complexity |
| `src/config/` | Configuration loading, defaults, Zod schema, model tier resolution |
| `src/adapters/claude/adapter.ts` | Claude Code adapter — install/uninstall/doctor for `.claude/` assets |
| `src/adapters/claude/triage-provider.ts` | Claude CLI invocation for model-backed triage |

### Key types (from `src/core/types.ts`)

- `WorkflowMode`: `"fast" | "standard" | "rigorous"`
- `WorkflowLifecycleState`: `created → triaging → awaiting_clarification? → awaiting_approach_approval? → planning → awaiting_plan_approval → executing → validating → reviewing → awaiting_commit_approval → completed` (plus `blocked` and `cancelled` escape states)
- `PhaseStatus`: `planned → ready → leased → running → completion_pending → completed` (plus repair/review/replan/blocked/cancelled)
- `CompletionGateDecision`: `completed | needs_repair | needs_review | needs_replan | blocked`
- `ModelProfile`: `"small" | "medium" | "large" | "inherit"`

### Marketplace plugin structure

The Claude Code marketplace plugin (`/plugin marketplace add sumanshusamarora/LeanRigor`) exposes:
- **Slash commands**: `/leanrigor:start`, `/leanrigor:plan`, `/leanrigor:status`, `/leanrigor:review`, `/leanrigor:commit`
- **Agent**: `leanrigor-triage` (read-only, small model)
- **Hook**: `protect-git.sh` — blocks automatic `git commit`, `git push`, `git reset --hard`
- **Bundled runtime**: `runtime/leanrigor-cli.js` (esbuild-bundled CLI)

Plugin source assets live in `src/adapters/claude/plugin/`. The build step (`npm run build`) copies them to `dist/adapters/claude/plugin/`; `build:claude-plugin` bundles the CLI runtime. Marketplace mode keeps state in `.leanrigor/` and never creates repository-local `.claude/` directories.

### Workflow persistence

Workflows are stored at `.leanrigor/workflows/<id>.json`. Every state change: acquires a persistent lock → reloads → verifies optional expected revision → applies one transition → increments revision → persists by temp-file write + atomic rename. The schema is versioned and validated on every read/write.

### Git workspace isolation

For Standard and Rigorous workflows, LeanRigor creates isolated Git worktrees outside the source tree:
```
<repo-parent>/.leanrigor-worktrees/<repo-name>/<workflow-id>/
```
Each workflow gets one integration worktree; each leased phase gets one phase worktree. Approved changes are transferred via internal LeanRigor commits (not pushed, never the final user commit). Integration cherry-picks phase commits; textual conflicts are persisted for explicit repair.

## Conventions

- **Strict TypeScript** with ESM modules (`"type": "module"` in package.json)
- **Zod** for all schema validation (triage output, config, workflow state)
- **Commander.js** for CLI subcommand structure
- **Vitest** for tests; test files in `tests/` mirror `src/` structure
- **Atomic writes** for all persisted state — temp file, fsync, rename
- **ESLint** with typescript-eslint and recommended rules; `dist/`, `runtime/`, `node_modules/` ignored
- Commits use conventional style (`feat:`, `fix:`, `chore:`) per CONTRIBUTING.md
- PRs target `main`; keep changes focused on a single concern
- The methodology under `methodology/` is **adapter-agnostic** — new adapters follow the pattern in `src/adapters/claude/`
- `npm run build` compiles only `src/**/*.ts` (not tests); `npm run typecheck` checks both

## Important Constraints

- **Never commit or push automatically** — the `protect-git.sh` hook enforces this; commit proposals are always human-reviewed
- Execution is **sequential by default** (`execution.maxParallelPhases` is `1`); the engine is parallel-ready but does not autonomously spawn agents
- The Claude CLI execution provider is a **prototype**; run `scripts/smoke-claude-cli-execution.sh` manually to verify it (not in CI)
- LeanRigor-owned branches follow the naming pattern `leanrigor/<short-id>/...` and must not be conflated with user branches
- The triage agent is **read-only** and bounded to at most two calls (initial + one context enrichment); if still uncertain, the safer mode wins
- Portable model tiers (`small`/`medium`/`large`/`inherit`) are resolved by the adapter, not hardcoded — Claude adapter defaults: small → haiku, medium → sonnet, large → opus
- If you are asked to perform a PR - use skill `.skills/pr-review` to run a PR review and provide feedback. This is a specialized skill for reviewing code changes in pull requests.
