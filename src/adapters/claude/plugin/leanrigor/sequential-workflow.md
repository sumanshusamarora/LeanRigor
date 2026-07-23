<!-- generated_by: leanrigor | asset_version: 2 -->
# LeanRigor Sequential Workflow

Use `leanrigor flow` as the persisted source of truth. Claude Code performs repository inspection, edits, validation commands, and review in the active coding session; LeanRigor records state, gates, phase evidence, review outcome, and commit proposals.

Lifecycle:

`created -> triaging -> awaiting_clarification? -> awaiting_approach_approval? -> planning -> awaiting_plan_approval -> executing -> validating -> reviewing -> awaiting_commit_approval -> completed`

`blocked` and `cancelled` are explicit escape states.

During `executing`, each phase must pass:

`active -> targeted validation -> completion gate -> completed | needs_repair | needs_review | needs_replan | blocked`

Rules:

- Ask at most one blocking clarification question, exactly as persisted.
- Never plan or edit past an approval gate.
- Execute one active phase at a time. Phases are small functional outcomes with one objective, a deliverable, criteria, bounded expected areas, validation expectations, and meaningful dependencies.
- Run declared validation or explicitly record skipped validation with a reason.
- Submit structured criterion evidence, changed files, validation, assumptions, risks, and scope deviations with `flow phase-complete`.
- Follow the returned gate decision. Do not mark a phase done because Claude says it is done, and do not unlock the next phase yourself.
- Fast may skip the separate approach gate only when LeanRigor marks it unnecessary.
- Standard and Rigorous require approach and plan approval.
- Final integrated review is required before commit proposal.
- Use `leanrigor flow record-review` with `passed`, `needs_repair`, `needs_replan`, or `blocked`.
- Never run `git commit`, `git push`, amend, rebase, or deploy automatically.
