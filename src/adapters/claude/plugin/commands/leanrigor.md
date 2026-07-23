<!-- generated_by: leanrigor | asset_version: 1 -->
# /leanrigor

Orchestrate the LeanRigor adaptive engineering workflow for a coding request.

## Purpose

Triage the request, clarify any blocking ambiguity, recommend a proportional
workflow approach, produce a concise execution plan, and obtain explicit user
approval before implementing anything.

## Behaviour

1. Run `leanrigor triage "$ARGUMENTS" --provider auto` to classify the request.
2. Read the triage result from `.leanrigor/workflow.json`.
3. If clarification is required, ask the **single** blocking question returned by
   triage and record the answer before continuing.
4. Report the recommended approach (Fast / Standard / Rigorous) with a brief
   rationale.
5. Produce a concise, proportional execution plan: objectives, affected files,
   validation steps, and review level.
6. **Stop. Present the plan and wait for explicit user approval before writing
   any implementation code.**

## What this command must not do automatically

- Modify or create implementation files before the plan is approved
- Run `git commit` or `git push` under any circumstances
- Spawn additional sub-agents automatically in this workflow
- Modify files outside the declared task scope

## After approval

Implement the approved plan following the LeanRigor review and validation
policy for the selected mode, then use `/leanrigor-commit` to propose commits.

$ARGUMENTS
