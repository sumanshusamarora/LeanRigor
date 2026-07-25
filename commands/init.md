---
description: Inspect and update LeanRigor configuration for this repository.
argument-hint: "[configuration action]"
---

# /leanrigor:init

Use `plugin-skills/sequential-workflow` as the workflow UX contract.

Invoke the plugin-owned runtime internally through
`${CLAUDE_PLUGIN_ROOT}/bin/leanrigor`.

Behaviour:

1. Run `leanrigor init-report` internally to produce the deterministic
   configuration report. The runtime automatically bootstraps missing
   project assets before generating the report — no separate init step
   is needed.
2. Display the returned report **verbatim inside one plain-text fenced code
   block**. Do not convert it into Markdown tables, bullets, HTML entities,
   summaries, or a redesigned layout.
3. **Invariant: Never reconstruct configuration diagnostics from memory or
   prose.** Preserve exact provenance, paths, statuses, warnings, spacing,
   and schema-valid commands returned by the runtime.
4. After the verbatim report, briefly offer to help with configuration changes.
5. If `$ARGUMENTS` requests a change, translate it into the appropriate
   `leanrigor config set` or `leanrigor config unset` command with the correct
   `--scope` option.
6. Never silently rewrite all config. Prefer explicit, scoped mutations.
7. For repository policy changes, confirm with the user before writing because
   changes affect all contributors.
8. **In marketplace mode, never suggest the manual init command.**
   The runtime handles bootstrapping automatically. Only mention explicit
   initialization in npm/global install mode or when explicitly asked.

## Scope guidance

| User wants to... | Scope |
|---|---|
| Set personal model preference across all repos | `--scope user` |
| Change project safety policy for all contributors | `--scope repo` |
| Set local model override for this repo only | `--scope local` |
| Change personal execution preferences | `--scope user` |
| Require minimum review level for the team | `--scope repo` |

$ARGUMENTS
