# Validate Integration

Review the combined implementation rather than trusting per-agent summaries.

## Always

- inspect the final diff for accidental files, scope drift, debug code, secret exposure, and unvalidated behaviour;
- run the configured validation level;
- record results in workflow state.

## Review by workflow

- Fast: final diff sanity check.
- Standard: one integrated code review.
- Rigorous: deep integrated review; use specialist review for configured high-risk work.
- Multi-agent: at least integrated review regardless of the initial mode.

## Reflection triggers

Create a structured reflection record when:

- scope expands materially;
- an architectural boundary changes;
- the configured repair threshold is reached;
- agents produce incompatible assumptions;
- integration reveals a new risk.

Reflection output must state the trigger, finding, previous mode, recommended mode, and whether replanning is required. Do not emit extended internal monologue.
