import type { LeanRigorConfig, ModelTier } from "../config/schema.js";
import type { StructuredDecisionProvider } from "./structured-decision.js";
import type { ValidationCommandAssessment } from "./validation-policy.js";

const ADVISORY_TIER: ModelTier = "small";
const MAX_COMMANDS = 12;

export type SupplementalValidationRecommendation = "likely-equivalent" | "supplemental" | "review-recommended";

export interface SupplementalValidationAdvice {
  command: string;
  recommendation: SupplementalValidationRecommendation;
  rationale: string;
}

export interface SupplementalValidationAdvisoryRecord {
  status: "available" | "unavailable" | "invalid";
  provider?: string;
  model?: string;
  tier: ModelTier;
  warnings: string[];
  advice: SupplementalValidationAdvice[];
  failureReason?: string;
}

export async function adviseSupplementalValidation(args: {
  provider: StructuredDecisionProvider;
  root: string;
  config: LeanRigorConfig;
  approvedCommands: readonly string[];
  supplemental: readonly ValidationCommandAssessment[];
}): Promise<SupplementalValidationAdvisoryRecord> {
  const supplemental = args.supplemental.slice(0, MAX_COMMANDS);
  if (supplemental.length === 0) {
    return { status: "available", tier: ADVISORY_TIER, warnings: [], advice: [] };
  }
  try {
    const result = await args.provider.decide<unknown>({
      root: args.root,
      prompt: advisoryPrompt(args.approvedCommands, supplemental),
      schema: advisorySchema(),
      tier: ADVISORY_TIER,
      config: args.config,
      stage: "execution-validation-advisory",
      maxTurns: 1,
      effort: "low",
      tools: "none"
    });
    const advice = parseAdvice(result.value, supplemental.map((entry) => entry.command));
    if (!advice) {
      return {
        status: "invalid",
        provider: result.provider,
        model: result.model,
        tier: result.tier,
        warnings: result.warnings,
        advice: [],
        failureReason: "The advisory provider returned an invalid or incomplete structured response."
      };
    }
    return {
      status: "available",
      provider: result.provider,
      model: result.model,
      tier: result.tier,
      warnings: result.warnings,
      advice
    };
  } catch (error) {
    return {
      status: "unavailable",
      tier: ADVISORY_TIER,
      warnings: [],
      advice: [],
      failureReason: safeFailure(error)
    };
  }
}

function advisoryPrompt(approvedCommands: readonly string[], supplemental: readonly ValidationCommandAssessment[]): string {
  return [
    "You are a post-execution validation-evidence advisor for a software workflow.",
    "This is advisory only. You MUST NOT authorize command execution, waive a required command, or decide whether the workflow may complete.",
    "Definitions:",
    "- Required validation is a command explicitly approved in the phase brief. It remains mandatory even if another command appears equivalent.",
    "- Supplemental validation is an extra command reported after execution. It is recorded as additional evidence only and never satisfies a required command.",
    "- Commands may belong to any programming language, package manager, test runner, compiler, linter, or build system. Do not assume JavaScript, TypeScript, or a particular toolchain.",
    "- Judge only the relationship between the reported command and the approved validation evidence. Do not infer that a command was actually executed, safe, read-only, or authorized.",
    "For each supplemental command, choose exactly one recommendation:",
    "- likely-equivalent: it appears to check the same concern as an approved command, but still does not replace it.",
    "- supplemental: it is useful additional validation with a distinct or narrower/broader purpose.",
    "- review-recommended: its purpose or relationship to the approved evidence is ambiguous.",
    "Keep each rationale concise, factual, and language-neutral. Return advice only for the supplied supplemental commands.",
    "",
    `Approved required commands: ${JSON.stringify(approvedCommands)}`,
    `Supplemental commands: ${JSON.stringify(supplemental.map((entry) => entry.command))}`
  ].join("\n");
}

function advisorySchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["advice"],
    properties: {
      advice: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["command", "recommendation", "rationale"],
          properties: {
            command: { type: "string" },
            recommendation: { type: "string", enum: ["likely-equivalent", "supplemental", "review-recommended"] },
            rationale: { type: "string", maxLength: 360 }
          }
        }
      }
    }
  };
}

function parseAdvice(value: unknown, commands: string[]): SupplementalValidationAdvice[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = (value as { advice?: unknown }).advice;
  if (!Array.isArray(raw)) return undefined;
  const expected = new Set(commands);
  const byCommand = new Map<string, SupplementalValidationAdvice>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const candidate = entry as { command?: unknown; recommendation?: unknown; rationale?: unknown };
    if (typeof candidate.command !== "string" || !expected.has(candidate.command)) return undefined;
    if (candidate.recommendation !== "likely-equivalent" && candidate.recommendation !== "supplemental" && candidate.recommendation !== "review-recommended") return undefined;
    if (typeof candidate.rationale !== "string" || !candidate.rationale.trim()) return undefined;
    byCommand.set(candidate.command, {
      command: candidate.command,
      recommendation: candidate.recommendation,
      rationale: candidate.rationale.trim().slice(0, 360)
    });
  }
  return commands.every((command) => byCommand.has(command)) ? commands.map((command) => byCommand.get(command)!) : undefined;
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/g, "[url]").replace(/\s+/g, " ").slice(0, 240);
}
