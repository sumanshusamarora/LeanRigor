<!-- generated_by: leanrigor | asset_version: 4 -->
# /leanrigor:init

Inspect and update LeanRigor configuration for this repository.

Read `.claude/leanrigor/sequential-workflow.md` first.

## Behaviour

1. Run `leanrigor doctor --json` and `leanrigor config show --json` internally
   to inspect the current state.
2. Report which configuration files are present:
   - User config (`~/.config/leanrigor/config.json`)
   - Repository policy (`leanrigor.config.json` — may be committed)
   - Local config (`.leanrigor/config.json` — private, never committed)
3. Report `.leanrigor/.gitignore` status.
4. Report resolved model tiers with provenance. Distinguish:
   - portable tier (`small`/`medium`/`large`/`inherit`)
   - adapter alias (Claude: `haiku`/`sonnet`/`opus`)
   - resolved model (the concrete model string)
   - source (where the effective value came from)
5. Report any configuration warnings or constraints.
6. If `$ARGUMENTS` is empty, present the current state and suggest available
   configuration commands.
7. If `$ARGUMENTS` requests a change, translate it into the appropriate
   `leanrigor config set` or `leanrigor config unset` command with the correct
   `--scope` option.
8. Never silently rewrite all config. Prefer explicit, scoped mutations.
9. For repository policy changes, confirm with the user before writing because
   changes affect all contributors.

## Scope guidance

| User wants to... | Scope |
|---|---|
| Set personal model preference across all repos | `--scope user` |
| Change project safety policy for all contributors | `--scope repo` |
| Set local model override for this repo only | `--scope local` |
| Change personal execution preferences | `--scope user` |
| Require minimum review level for the team | `--scope repo` |

$ARGUMENTS
