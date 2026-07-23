<!-- generated_by: leanrigor | asset_version: 2 -->
# /leanrigor-review

Review the current implementation diff using the LeanRigor review policy.

Read `.claude/leanrigor/sequential-workflow.md` first.

## Behaviour

1. Run `leanrigor flow status` to determine the active workflow, mode, phase
   completion, validation evidence, and required review level.
2. Inspect the diff:
   - Staged changes: `git diff --cached`
   - Unstaged changes: `git diff`
3. Apply the review level determined by the workflow mode:
   - **Fast** → sanity check: scan for obvious errors, secrets, scope drift
   - **Standard** → integrated review: logic, tests, contract compliance
   - **Rigorous** → deep review: architecture, security, edge cases, invariants
4. Record the final integrated review:
   - `passed` when the diff is ready for commit proposal
   - `needs_repair` with the smallest repair scope
   - `needs_replan` when the approved plan no longer fits
   - `blocked` when safe continuation needs external input
5. Run `leanrigor flow record-review <workflow-id> --status <status> --summary "<summary>"`.

## Constraints

- Do not commit or push
- Do not modify implementation files during review
- Do not silently auto-fix findings during review.
