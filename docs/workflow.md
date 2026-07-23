# Workflow

`/flow <request>` performs adaptive triage, bounded inspection, clarification, planning, execution, validation, review, and commit preparation.

`/flow-plan <request>` stops after the execution graph.

`/flow-status` reports persisted workflow state.

`/flow-commit` proposes cohesive commits and commands but does not commit without confirmation.

The CLI currently provides equivalent setup, triage, status, and doctor primitives:

```bash
leanrigor setup
leanrigor triage "Fix the assignment regression"
leanrigor status
leanrigor doctor
```

## Triage output rules

Triage produces schema-validated JSON rather than prose. It separates implementation complexity from workflow risk, chooses the lowest safe mode, requires positive evidence for Fast, and requires an explicit trigger for Rigorous. Repository policy is applied after the model recommendation and may override it.

The output is deliberately bounded: one blocking question, up to five inspection objectives, three escalation reasons, and three assumptions. The triage agent never edits files or creates the execution plan.

## Introspection and review

Every task receives a cheap preflight by default. Deeper reflection is triggered by scope expansion, architecture changes, repeated failed repairs, integration conflicts, or a manual request.

Fast tasks receive a diff sanity check. Standard tasks receive one integrated review. Rigorous tasks receive deep review, and multi-agent work always receives at least an integrated review.
