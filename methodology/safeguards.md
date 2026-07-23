<!-- generated_by: leanrigor | methodology_asset: shared -->
# Safeguards Methodology

Load this file when security, privacy, migration, public contract, data
integrity, production, infrastructure, concurrency, or destructive-operation
risks appear.

## Scope Control

- Do not opportunistically refactor unrelated code.
- Do not change public contracts without approved plan coverage.
- Do not add dependencies without justification.
- Do not introduce migrations in a non-migration phase.
- Do not modify security or infrastructure boundaries incidentally.
- Record unexpected scope expansion immediately.
- Use `needs_replan` when approved assumptions no longer hold.

## Security And Privacy

- Apply least privilege.
- Treat authentication and authorisation as distinct concerns.
- Enforce access control server-side.
- Prefer secure defaults.
- Validate input and encode output at boundaries.
- Do not expose or persist secrets.
- Avoid logging sensitive data.
- Consider dependency and supply-chain risk.
- Consider abuse, rate limits, privacy, retention, and compliance impact.
- Do not present this as a complete security audit unless a real audit was run.

## Migration And Data

- Prefer backward-compatible rollout where practical.
- Use expand/migrate/contract for breaking schema changes.
- Make migrations idempotent where possible.
- Identify transaction boundaries.
- Consider locks, latency, and data volume.
- Include rollback or forward-fix strategy.
- Provide dry-run capability where appropriate.
- Plan monitoring, reconciliation, and verification.
- Avoid destructive migrations without explicit approval.
- In Rigorous mode, separate migration phases from application behavior.

## APIs And Contracts

- Identify consumers.
- Preserve compatibility or version explicitly.
- Validate request and response schemas.
- Keep error behavior stable unless intentionally changed.
- Include migration and deprecation strategy when needed.
- Update generated clients and callers.
- Add contract tests where appropriate.
- Do not hide public contract changes inside implementation phases.

## Production And Operations

- Analyze blast radius.
- Prefer staged rollout.
- Use feature flags where useful.
- Add or verify observability and alerting.
- Define rollback or recovery path.
- Consider capacity and performance impact.
- Isolate failure modes.
- Validate configuration.
- Do not perform unverified production write actions.
- In Rigorous mode, require explicit operational evidence.
