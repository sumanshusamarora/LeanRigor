<!-- generated_by: leanrigor | methodology_asset: shared -->
# Evidence Methodology

Completion claims must be backed by concrete evidence.

## Strong Evidence

- Passing command with exit code.
- Focused regression test.
- Direct diff inspection.
- Workspace identity and diff identity for LeanRigor phase worktrees.
- Observed runtime behavior.
- Schema or contract validation.
- Reproducible before/after result.

## Weak Evidence

- "Looks correct".
- Model confidence.
- Code existence without execution.
- An unrelated broad test suite.
- Assumptions presented as facts.

## Completion Claim Shape

Keep completion output concise, but include:

```text
claim
evidence
verification status
remaining uncertainty
```

## Rules

- Do not claim a command passed unless it was run and returned a passing exit
  status.
- Do not claim a behavior is fixed unless the original symptom or a focused
  regression was verified.
- If a check was skipped, state why, what manual evidence exists, and what risk
  remains.
- Distinguish verified, inferred, and unverified statements.
- For workspace-backed phases, include the phase workspace path, base commit,
  changed files, untracked files, diff hash, and internal transfer commit
  recorded by LeanRigor. Do not treat phase-level validation as proof that the
  combined integration worktree passes.
