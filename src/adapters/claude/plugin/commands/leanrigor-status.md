<!-- generated_by: leanrigor | asset_version: 2 -->
# /leanrigor-status

Report the current LeanRigor workflow state.

## Behaviour

Run `leanrigor flow status` and present a structured report covering:

- **Mode**: Fast / Standard / Rigorous
- **State**: current lifecycle state
- **Request**: original task summary
- **Triage**: assessment scores, confidence, and any override reasons
- **Clarification**: open blocking questions and recorded decisions
- **Plan**: sequential phase progress
- **Current phase**: objective and completion-gate status
- **Criteria**: met, not met, uncertain, and not applicable counts
- **Validation**: phase and final validation status
- **Repair attempts**: current attempts against the configured budget
- **Scope deviations**: unexpected changed files, dependencies, migrations,
  public contracts, configuration, or sensitive areas
- **Review**: passed, needs repair, needs replan, or blocked
- **Blockers**: items requiring user input before proceeding
- **Next commands**: valid `leanrigor flow` commands from state
