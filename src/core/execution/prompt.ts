import type { PhaseExecutionInput } from "./types.js";

export function phaseWorkerPrompt(input: PhaseExecutionInput): string {
  const controls = input.workerControls ?? defaultWorkerControls(input.selectedMode);
  return [
    "LeanRigor bounded phase worker",
    `Workflow: ${input.workflowId} revision ${input.workflowRevision}`,
    `Phase: ${input.phaseId} | Approved brief revision: ${input.briefRevision} | Mode: ${input.selectedMode} | Tier: ${input.modelTier}`,
    `Workspace: ${input.workspacePath}`,
    "",
    "This is the approved Phase Execution Brief.",
    "Do not expand scope beyond the approved boundaries.",
    "If implementation reveals material scope, risk, dependency, or architecture changes, stop and return needs_replan.",
    "",
    "Objective:",
    input.objective,
    "",
    "Concrete deliverable:",
    input.deliverable,
    "",
    "Current behaviour:",
    input.currentBehaviour ?? "(No additional current-behaviour note.)",
    "",
    "Implementation approach:",
    input.implementationApproach,
    "",
    "Acceptance criteria:",
    ...input.acceptanceCriteria.map((criterion, index) => `- [${input.acceptanceCriterionIds?.[index] ?? `${input.phaseId}:criterion-${index + 1}`}] ${criterion}`),
    "For every criterionEvidence item, return the exact bracketed criterionId. Criterion display text is not an identifier.",
    "",
    "Approved files, symbols, and scope:",
    `- Read: ${input.allowedReadAreas.join(", ") || "(none declared)"}`,
    `- Write: ${input.allowedWriteAreas.join(", ") || "(none declared)"}`,
    `- Relevant files: ${input.relevantFiles.join(", ") || "(none)"}`,
    `- Relevant symbols: ${input.relevantSymbols.join(", ") || "(none)"}`,
    `- Dependencies: ${input.dependencies.join(", ") || "(none)"}`,
    `- Inspection provenance: ${input.inspectionProvenance.source}${input.inspectionProvenance.provider ? ` via ${input.inspectionProvenance.provider}` : ""}`,
    input.codeIntelligence ? `- Code intelligence: CodeGraph ${input.codeIntelligence.codegraph}${input.codeIntelligence.note ? ` (${input.codeIntelligence.note})` : ""}` : undefined,
    "",
    "Validation commands:",
    ...input.validationExpectations.map((command) => `- ${command}`),
    "",
    "Test obligations:",
    ...input.testObligations.map((obligation) => `- ${obligation}`),
    "",
    "Assumptions:",
    ...input.assumptions.map((assumption) => `- ${assumption}`),
    "Exclusions:",
    ...input.exclusions.map((exclusion) => `- ${exclusion}`),
    "Risks:",
    ...input.risks.map((risk) => `- ${risk}`),
    "",
    "Workspace preparation:",
    input.workspacePreparation?.worktreePath ? `- Worktree path: ${input.workspacePreparation.worktreePath}` : undefined,
    input.workspacePreparation?.repositoryIdentity ? `- Repository identity: ${input.workspacePreparation.repositoryIdentity}` : undefined,
    input.workspacePreparation?.basis?.branch || input.workspacePreparation?.basis?.commit ? `- Basis: ${[input.workspacePreparation.basis.branch, input.workspacePreparation.basis.commit].filter(Boolean).join(" @ ")}` : undefined,
    `- Prepared: ${input.workspacePreparation && ["available", "prepared"].includes(input.workspacePreparation.status) ? "yes" : "no"}`,
    input.workspacePreparation ? `- Package manager: ${input.workspacePreparation.packageManager ?? "unknown"}` : "- Package manager: unknown",
    input.workspacePreparation ? `- Dependencies: ${input.workspacePreparation.dependencies}` : "- Dependencies: unknown",
    input.workspacePreparation ? `- Validation commands available: ${input.workspacePreparation.validationCommandsAvailable === false ? "no" : "yes"}` : "- Validation commands available: unknown",
    input.workspacePreparation?.bootstrapCommand ? `- Bootstrap command: ${input.workspacePreparation.bootstrapCommand}` : "- Bootstrap command: none",
    input.workspacePreparation ? `- Bootstrap result: ${input.workspacePreparation.status}` : "- Bootstrap result: unknown",
    input.workspacePreparation && ["available", "prepared"].includes(input.workspacePreparation.status)
      ? "- Workspace status: prepared. Do not install dependencies unless LeanRigor explicitly marks preparation incomplete."
      : undefined,
    input.workspacePreparation && !["available", "prepared"].includes(input.workspacePreparation.status)
      ? "- Dependencies are unavailable. Do not run install commands; return blocked status with this preparation result."
      : undefined,
    "",
    "Constraints:",
    ...input.approvedConstraints.map((constraint) => `- Approved constraint: ${constraint}`),
    ...input.safetyInstructions.map((instruction) => `- ${instruction}`),
    `- Allowed write scope is limited to the assigned workspace and declared write areas.`,
    "- Do not modify files outside the approved write areas to make a validation, release, version, or packaging check pass. Report an unmet or deferred check instead.",
    `- Do not commit, push, merge, deploy, or modify files outside the assigned workspace.`,
    "",
    input.resume ? [
      "Resume/checkpoint:",
      `- Mode: ${input.resume.mode}`,
      `- Attempt: ${input.resume.attempt}`,
      `- Prior failure: ${input.resume.failureReason}`,
      "- Continue from the existing workspace state; do not repeat broad repository discovery."
    ].join("\n") : undefined,
    input.previousCheckpoint?.dirty ? [
      "Existing worktree changes:",
      `- Changed: ${input.previousCheckpoint.changedFiles.join(", ") || "(none)"}`,
      `- Deleted: ${input.previousCheckpoint.deletedFiles.join(", ") || "(none)"}`,
      `- Untracked: ${input.previousCheckpoint.untrackedFiles.join(", ") || "(none)"}`,
      input.previousCheckpoint.diffSummary.text ? `- Bounded diff summary:\n${input.previousCheckpoint.diffSummary.text}` : undefined
    ].filter(Boolean).join("\n") : undefined,
    "",
    "Execution budget:",
    input.turnBudget ? `- Maximum provider turns for this invocation: ${input.turnBudget.effectiveTurnLimit}.` : undefined,
    `- Discovery turns before implementation is expected: ${controls.maxDiscoveryTurns}`,
    `- Reserve at least ${controls.reservedValidationTurns} turn(s) for validation and ${controls.reservedFinalResultTurns} turn(s) for final structured output.`,
    `- Warn and summarize instead of repeatedly reading the same file more than ${controls.repeatedReadWarningThreshold} time(s).`,
    `- Keep individual large tool outputs below about ${controls.largeToolOutputBytes} bytes when possible.`,
    "- If progress is partial near the limit, preserve the worktree state and return a failed or blocked structured result with exact evidence.",
    "",
    "Return only the JSON object required by the supplied json-schema. Include concise validation evidence and changed files; do not include hidden reasoning.",
    `Return executionIdentity exactly as supplied: ${JSON.stringify(input.executionIdentity)}`
  ].filter((line): line is string => line !== undefined).join("\n");
}

function defaultWorkerControls(mode: PhaseExecutionInput["selectedMode"]): NonNullable<PhaseExecutionInput["workerControls"]> {
  if (mode === "fast") return { maxDiscoveryTurns: 1, reservedValidationTurns: 1, reservedFinalResultTurns: 1, repeatedReadWarningThreshold: 2, largeToolOutputBytes: 32768 };
  if (mode === "rigorous") return { maxDiscoveryTurns: 4, reservedValidationTurns: 2, reservedFinalResultTurns: 1, repeatedReadWarningThreshold: 2, largeToolOutputBytes: 32768 };
  return { maxDiscoveryTurns: 2, reservedValidationTurns: 1, reservedFinalResultTurns: 1, repeatedReadWarningThreshold: 2, largeToolOutputBytes: 32768 };
}
