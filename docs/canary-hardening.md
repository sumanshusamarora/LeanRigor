# Canary workflow hardening

LeanRigor uses difficult repository requests as vertical-slice canaries, not as
task-specific specifications. A canary is valid only when the generic workflow
handles enrichment, triage, approvals, planning, phase briefs, workspace
preparation, provider execution, completion gates, integration, next-phase
progression, final validation, final review, and explicit completion.

## Clean-run loop

```text
start from a new workflow
-> capture each artifact and transition
-> evaluate quality and liveness
-> stop at the first blocking or misleading defect
-> name the violated generic invariant
-> make the smallest generic correction
-> add focused regression coverage
-> restart from a new workflow
```

Do not validate a correction by editing persisted workflow state or continuing
from a corrupted run. Do not add issue wording, entity names, phase numbers, or
file-specific acceptance criteria to production logic.

## Artifact review

Review the enriched request, triage reasoning, Workflow Plan, phase DAG, each
Phase Execution Brief, acceptance and test obligations, validation commands,
recovery attempts, provider input and result, completion gate, integration,
next-phase brief, and final summary. Check correctness, specificity,
traceability, actionability, dependency validity, evidence sufficiency,
duplication, liveness, and whether an artifact creates a later deadlock.

The machine-readable report for each clean run records:

- workflow and repository revisions;
- artifact revisions and structured quality results;
- complete phase graph and approvals;
- recovery attempts and provider executions;
- validation and integration evidence;
- transitions, requested user decisions, first blocker, and final status.

The report never contains hidden reasoning.

## Verification claims

An installed deterministic scripted-provider canary verifies LeanRigor's
orchestration, persistence, approvals, gates, validation, integration, and
completion behavior reproducibly. It does not establish equivalent live-model
implementation quality. Live-provider evidence must be reported separately.

A hardening pass also runs a small bounded scenario to detect unnecessary
escalation and an unrelated high-risk persistence or public-contract scenario
to detect canary-specific logic. Capability claims require two independent
clean successful canary runs after the final workflow correction.
