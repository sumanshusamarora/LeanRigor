<!-- generated_by: leanrigor | methodology_asset: shared -->
# Review Methodology

Review depth follows the selected LeanRigor review level and risk triggers.

## Sanity Review

Use for Fast mode and tiny low-risk diffs:

- requested outcome;
- obvious defects;
- accidental changes;
- diff readability;
- targeted validation.

## Integrated Review

Use for Standard mode and cross-file behavior:

- cross-file consistency;
- callers and consumers;
- tests and validation evidence;
- error handling;
- compatibility;
- documentation;
- scope drift.

## Deep Review

Use for Rigorous mode or high-risk changes:

- architecture;
- security;
- migration safety;
- data integrity;
- concurrency;
- operational impact;
- rollback;
- observability.

## Specialist Review Triggers

Escalate review depth or explicitly call out specialist review needs for:

- authentication and authorisation;
- payments and billing;
- secrets and credentials;
- privacy and retention;
- destructive data operations;
- migrations;
- public APIs and shared schemas;
- production infrastructure;
- cryptography;
- concurrency and distributed consistency.

## Review Output

- Findings first, ordered by severity.
- Include file references or concrete evidence.
- Separate required repairs from minor observations.
- If no issues are found, state the test gaps or residual risk.
- Feed the review decision into LeanRigor's existing completion gate or final
  review transition; do not bypass deterministic gates.
