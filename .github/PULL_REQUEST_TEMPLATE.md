## Problem

What problem does this change solve? Link related issues with `Closes #...` where applicable.

## Approach

Describe the chosen approach and important alternatives considered.

## Scope

- In scope:
- Out of scope:

## Architecture and safety

- LeanRigor policy/control-plane impact:
- Execution or workspace-provider impact:
- Deterministic responsibilities:
- Prompt-owned responsibilities:
- Compatibility or migration impact:
- Safety implications:

## Verification

List commands and results.

```text
npm run typecheck
npm test
npm run lint
npm run build
npm run validate:claude-plugin
```

Additional smoke scenarios:

- [ ] Not applicable
- [ ] Packed-install smoke
- [ ] Claude marketplace smoke
- [ ] Disposable Git/worktree smoke
- [ ] Real provider smoke

## Documentation

- [ ] Documentation is unchanged and no update is required
- [ ] User-facing documentation is updated
- [ ] README feature inventory is updated for verified capability
- [ ] Planned functionality remains under Roadmap or Current Limitations
- [ ] Architecture decision record added or updated where appropriate

## Checklist

- [ ] The change is focused and does not contain unrelated refactoring
- [ ] Tests cover the behaviour and relevant failure paths
- [ ] Existing workflow-state compatibility is preserved or migrated
- [ ] No final user commit, push, deploy, or destructive production action is automated
- [ ] No hidden chain of thought is persisted
- [ ] Remaining limitations and unverified behaviour are stated clearly
