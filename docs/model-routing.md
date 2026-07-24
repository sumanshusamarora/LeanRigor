# Portable model routing

LeanRigor owns four portable model tiers: `small`, `medium`, `large`, and `inherit`.
Workflow stages select a tier; adapters resolve that tier to a harness-specific model identifier.
Workflow modes (`fast`, `standard`, `rigorous`) and model tiers are intentionally separate.

## Claude Code defaults

Claude mappings default to the official aliases:

- `small` → `haiku`
- `medium` → `sonnet`
- `large` → `opus`
- `inherit` → no `--model` argument (harness uses its active/default model)

These are Claude aliases, not pinned version IDs. Claude Code resolves aliases to concrete models through the user's provider, organisation policy, and `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, and `ANTHROPIC_DEFAULT_OPUS_MODEL` settings. When `ANTHROPIC_DEFAULT_*` maps to a non-Anthropic model (e.g., DeepSeek), LeanRigor displays both the alias and the resolved model.

### Terminology

LeanRigor distinguishes four concepts in all output:

| Concept | Example | Description |
|---|---|---|
| Portable tier | `small`, `medium`, `large`, `inherit` | Provider-neutral policy value |
| Adapter alias | `haiku`, `sonnet`, `opus` | Claude-specific resolution key |
| Resolved model | `deepseek-v4-pro[1m]`, `claude-opus-4-1` | Concrete model passed to the CLI |
| Provenance | `ANTHROPIC_DEFAULT_OPUS_MODEL`, `local config` | Source of the effective value |

## OpenCode

LeanRigor does not guess OpenCode model identifiers. Users assign provider-qualified identifiers during setup, for example `anthropic/claude-sonnet-4-5`. Missing mappings produce a clear error rather than silently selecting an unknown model.

## Environment overrides

Platform-specific variables take precedence over generic variables, which take precedence over configuration:

```bash
LEANRIGOR_CLAUDE_MODEL_SMALL=haiku
LEANRIGOR_CLAUDE_MODEL_MEDIUM=sonnet
LEANRIGOR_CLAUDE_MODEL_LARGE=opus

LEANRIGOR_OPENCODE_MODEL_SMALL=provider/model-small
LEANRIGOR_OPENCODE_MODEL_MEDIUM=provider/model-medium
LEANRIGOR_OPENCODE_MODEL_LARGE=provider/model-large
```

Generic alternatives are `LEANRIGOR_MODEL_SMALL`, `LEANRIGOR_MODEL_MEDIUM`, and `LEANRIGOR_MODEL_LARGE`.

## Resolution precedence

1. Platform-specific environment variable
2. Generic environment variable
3. User/repository merged configuration
4. Adapter default

A stage routed to `inherit` omits an explicit model argument and lets the harness use its active/default model.

## Availability failures

Configuration presence can be validated before execution. Actual provider availability may only be known when the harness invokes the model. LeanRigor reports the tier, resolved identifier, and corrective command when invocation fails. It does not silently downgrade high-risk work unless fallback is explicitly approved.
