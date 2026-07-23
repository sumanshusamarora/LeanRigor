import type { PhaseExecutionInput } from "./types.js";

export function phaseWorkerPrompt(input: PhaseExecutionInput): string {
  return [
    `LeanRigor phase execution request`,
    ``,
    `Workflow: ${input.workflowId} revision ${input.workflowRevision}`,
    `Phase: ${input.phaseId}`,
    `Mode: ${input.selectedMode}`,
    `Model tier: ${input.modelTier}`,
    ``,
    `Objective:`,
    input.objective,
    ``,
    `Acceptance criteria:`,
    ...input.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    ``,
    `Assigned workspace: ${input.workspacePath}`,
    `Repository root: ${input.repositoryRoot}`,
    `Allowed read areas: ${input.allowedReadAreas.join(", ") || "(none declared)"}`,
    `Allowed write areas: ${input.allowedWriteAreas.join(", ") || "(none declared)"}`,
    `Dependencies: ${input.dependencies.join(", ") || "(none)"}`,
    ``,
    `Validation expectations:`,
    ...input.validationExpectations.map((command) => `- ${command}`),
    ``,
    `Relevant methodology: ${input.methodologyReferences.join(", ") || "(none)"}`,
    `Plan context: ${input.planContext}`,
    ``,
    `Safety instructions:`,
    ...input.safetyInstructions.map((instruction) => `- ${instruction}`),
    `- Do not edit outside the assigned workspace.`,
    `- Do not make a final user commit, push, merge to the user branch, deploy, or bypass LeanRigor gates.`,
    `- Stop and report blocked status rather than bypassing a blocker.`,
    `- Distinguish verified, inferred, and unverified claims in the result summary.`,
    `- Return only structured JSON matching LeanRigor's phase execution result contract.`
  ].join("\n");
}

