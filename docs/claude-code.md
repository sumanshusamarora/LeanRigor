# Claude Code Adapter

Run `leanrigor setup` in a repository. It creates:

- `.leanrigor/config.json`
- `.claude/commands/flow.md`
- `.claude/commands/flow-plan.md`
- `.claude/commands/flow-status.md`
- `.claude/commands/flow-commit.md`
- `.claude/agents/leanrigor-triage.md`

The triage subagent defaults to the model resolved by the `small` profile, which is `haiku` in the default configuration. Users can change this in `.leanrigor/config.json`.

The adapter must treat triage output as structured advice. Deterministic risk rules may escalate the selected mode.

## Running model-backed triage

After setup, run:

```bash
leanrigor triage "Fix the broken assignment API" --provider auto
```

Provider options:

- `auto`: use the configured Claude triage model and safely fall back to deterministic triage.
- `claude`: currently behaves like `auto`, but explicitly documents the intended harness.
- `deterministic`: do not make a model call.

The Claude invocation is non-interactive, limited to one turn, and disallows Edit, Write, and Bash tools. Invalid output is retried once and then replaced with deterministic triage. The workflow state records which path was used.
