<!-- generated_by: leanrigor | asset_version: 1 -->
# /leanrigor-status

Report the current LeanRigor workflow state.

## Behaviour

Run `leanrigor status` and present a structured report covering:

- **Mode**: Fast / Standard / Rigorous
- **Phase**: current workflow phase
- **Request**: original task summary
- **Triage**: assessment scores, confidence, and any override reasons
- **Clarification**: open blocking questions and recorded decisions
- **Plan**: execution graph summary if available
- **Validation**: results from any completed validation steps
- **Blockers**: items requiring user input before proceeding
