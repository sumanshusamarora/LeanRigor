<!-- generated_by: leanrigor | asset_version: 1 -->
# /leanrigor-review

Review the current implementation diff using the LeanRigor review policy.

## Behaviour

1. Read `.leanrigor/workflow.json` to determine the current workflow mode and
   the required review level (sanity / integrated / deep).
2. Inspect the diff:
   - Staged changes: `git diff --cached`
   - Unstaged changes: `git diff`
3. Apply the review level determined by the workflow mode:
   - **Fast** → sanity check: scan for obvious errors, secrets, scope drift
   - **Standard** → integrated review: logic, tests, contract compliance
   - **Rigorous** → deep review: architecture, security, edge cases, invariants
4. Report findings clearly: what looks correct, what needs attention, and any
   blocking issues before commit preparation.

## Constraints

- Do not commit or push
- Do not modify implementation files during review
- Report findings; do not silently auto-fix issues found during review
