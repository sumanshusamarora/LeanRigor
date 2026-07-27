import type { PhaseExecutionInput } from "./types.js";

export function phaseWorkerPrompt(input: PhaseExecutionInput): string {
  const controls = input.workerControls ?? defaultWorkerControls(input.selectedMode);
  return [
    "LeanRigor bounded phase worker",
    `Workflow: ${input.workflowId} revision ${input.workflowRevision}`,
    `Phase: ${input.phaseId} | Mode: ${input.selectedMode} | Tier: ${input.modelTier}`,
    `Workspace: ${input.workspacePath}`,
    "",
    "Objective:",
    input.objective,
    "",
    "Acceptance criteria:",
    ...input.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "Likely files and scope:",
    `- Read: ${input.allowedReadAreas.join(", ") || "(none declared)"}`,
    `- Write: ${input.allowedWriteAreas.join(", ") || "(none declared)"}`,
    `- Dependencies: ${input.dependencies.join(", ") || "(none)"}`,
    input.codeIntelligence ? `- Code intelligence: CodeGraph ${input.codeIntelligence.codegraph}${input.codeIntelligence.note ? ` (${input.codeIntelligence.note})` : ""}` : undefined,
    "",
    "Validation commands:",
    ...input.validationExpectations.map((command) => `- ${command}`),
    "",
    "Constraints:",
    ...input.safetyInstructions.map((instruction) => `- ${instruction}`),
    `- Allowed write scope is limited to the assigned workspace and declared write areas.`,
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
    `- Discovery turns before implementation is expected: ${controls.maxDiscoveryTurns}`,
    `- Reserve at least ${controls.reservedValidationTurns} turn(s) for validation and ${controls.reservedFinalResultTurns} turn(s) for final structured output.`,
    `- Warn and summarize instead of repeatedly reading the same file more than ${controls.repeatedReadWarningThreshold} time(s).`,
    `- Keep individual large tool outputs below about ${controls.largeToolOutputBytes} bytes when possible.`,
    "- If progress is partial near the limit, preserve the worktree state and return a failed or blocked structured result with exact evidence.",
    "",
    "Return only the JSON object required by the supplied json-schema. Include concise validation evidence and changed files; do not include hidden reasoning."
  ].filter((line): line is string => line !== undefined).join("\n");
}

function defaultWorkerControls(mode: PhaseExecutionInput["selectedMode"]): NonNullable<PhaseExecutionInput["workerControls"]> {
  if (mode === "fast") return { maxDiscoveryTurns: 1, reservedValidationTurns: 1, reservedFinalResultTurns: 1, repeatedReadWarningThreshold: 2, largeToolOutputBytes: 32768 };
  if (mode === "rigorous") return { maxDiscoveryTurns: 4, reservedValidationTurns: 2, reservedFinalResultTurns: 1, repeatedReadWarningThreshold: 2, largeToolOutputBytes: 32768 };
  return { maxDiscoveryTurns: 2, reservedValidationTurns: 1, reservedFinalResultTurns: 1, repeatedReadWarningThreshold: 2, largeToolOutputBytes: 32768 };
}
