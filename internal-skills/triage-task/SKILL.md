# Triage Task

Use the configured `small` model tier. The adapter resolves this to a concrete model at runtime (for Claude Code, the small tier maps to the `haiku` alias by default).

## Purpose

Classify the request and recommend the next workflow. Do not implement, edit files, run tests, create a detailed plan, launch agents, or commit.

## Required output

Return only JSON matching the `TriageOutput` schema in `src/core/triage-schema.ts`.

The output must contain:

- one-sentence task summary;
- task type;
- separate complexity, ambiguity, blast-radius, architecture, security, data-integrity, and operational assessments;
- model recommendation and final policy-selected mode;
- confidence from 0 to 1;
- sequential or candidate parallelism;
- review and test levels;
- at most one blocking clarification question;
- at most five inspection objectives;
- at most three escalation reasons;
- at most three assumptions;
- explicit constraints.

## Decision rules

1. Select the lowest workflow mode that safely handles the identified risks.
2. Never equate implementation difficulty with workflow rigor.
3. Fast requires positive evidence: low ambiguity, low blast radius, low architectural impact, and no security, data-integrity, operational, migration, or public-contract risk.
4. Rigorous requires an explicit trigger such as authentication, authorisation, credentials, payments, migrations, destructive data work, public API compatibility, production infrastructure, concurrency, privacy, compliance, or broad architectural boundary changes.
5. Bug fixes normally require Standard mode with targeted regression validation.
6. A difficult read-only investigation may remain Standard.
7. Recommend only whether parallelism is a candidate. The execution-graph skill makes the final task split.
8. Request inspection objectives, not invented filenames.
9. Ask only one blocking question, and only when its answer could change scope, architecture, compatibility, safety, mode, or acceptance criteria.
10. Do not produce implementation advice or an execution plan.

## Confidence behaviour

- `0.80–1.00`: proceed to policy overrides.
- `0.55–0.79`: permit one narrow context-enrichment pass.
- Below `0.55`: ask one blocking question or use the safer adjacent mode. Low confidence alone does not justify Rigorous.

## Validation and fallback

The orchestrator validates the response and then applies deterministic repository policy. Invalid output may be retried once with the validation error. A second failure falls back to Standard unless a known high-risk trigger requires Rigorous.
