export type ValidationCommandClassification = "approved" | "supplemental";

export interface ValidationCommandAssessment {
  command: string;
  classification: ValidationCommandClassification;
  reason: string;
}

/**
 * Classifies validation evidence without allowing supplementary checks to
 * replace an approved requirement. This deliberately does not infer command
 * safety from framework, language, or shell spelling: execution authorization
 * belongs to the command runner, not to a post-execution evidence gate.
 */
export function assessValidationCommand(command: string, approvedCommands: readonly string[]): ValidationCommandAssessment {
  const normalised = normaliseValidationCommand(command);
  if (approvedCommands.some((approved) => normaliseValidationCommand(approved) === normalised)) {
    return { command, classification: "approved", reason: "Matches an approved validation command." };
  }
  return { command, classification: "supplemental", reason: "Additional validation evidence; it does not satisfy an approved requirement." };
}

export function supplementalValidationCommands(commands: readonly string[], approvedCommands: readonly string[]): ValidationCommandAssessment[] {
  return commands
    .map((command) => assessValidationCommand(command, approvedCommands))
    .filter((assessment) => assessment.classification === "supplemental");
}

export function missingRequiredValidationCommands(requiredCommands: readonly string[], recordedCommands: readonly string[]): string[] {
  return requiredCommands.filter((required) => !recordedCommands.some((recorded) =>
    assessValidationCommand(recorded, [required]).classification === "approved"));
}

export function normaliseValidationCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}
