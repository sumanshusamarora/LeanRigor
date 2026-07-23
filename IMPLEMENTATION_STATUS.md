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
- Tests for model tier defaults, environment precedence, inherit behaviour, and missing OpenCode mappings.

## Verification

The following repository-level checks pass in this environment:

- JSON parsing for `config.schema.json` and the repository policy template.
- `git diff --check`.
- Search for obsolete `agent-flow`, `modelProfiles`, `balanced`, and `strong` naming.

Dependency installation repeatedly timed out, so the TypeScript compiler and Vitest suite could not be executed here. Run locally:

```bash
npm install
npm run check
```

## Next implementation step

Add the OpenCode adapter and interactive model discovery/setup. It should obtain the models visible to the user's OpenCode installation, let the user assign Small/Medium/Large tiers, verify the selected identifiers, and refuse to enable model-backed execution when required mappings are unavailable.
