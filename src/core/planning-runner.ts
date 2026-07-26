import { jsonrepair } from "jsonrepair";
import type { LeanRigorConfig, ModelTier } from "../config/schema.js";
import type { ExecutionPlan, TriageOutput } from "./types.js";
import { type TriageProviderSelection } from "./triage-runner.js";

export interface PlanDiagnostic {
  stage: "syntax" | "schema" | "quality";
  path: Array<string | number>;
  code: string;
  message: string;
}

export interface PlanningProviderResult {
  raw: unknown;
  provider: string;
  model?: string;
  tier?: ModelTier;
  warnings?: string[];
}

export interface PlanningRepairRequest {
  plan: unknown;
  diagnostics: PlanDiagnostic[];
  model?: string;
  tier?: ModelTier;
}

export interface PlanningProviderInput {
  request: string;
  root: string;
  config: LeanRigorConfig;
  triage: TriageOutput;
  deterministicPlan: ExecutionPlan;
  revisionRequests: ExecutionPlan["revisionRequests"];
}

export interface PlanningProvider {
  name: string;
  plan(input: PlanningProviderInput): Promise<PlanningProviderResult>;
  repair?(input: PlanningProviderInput, request: PlanningRepairRequest): Promise<PlanningProviderResult>;
}

export interface PlanningRunResult {
  plan: ExecutionPlan;
  source: "model" | "deterministic-fallback";
  provider: string;
  model?: string;
  attempts: number;
  fallbackReason?: string;
  warnings: string[];
  diagnostics?: PlanDiagnostic[];
  syntaxRepairApplied?: boolean;
  semanticRepairApplied?: boolean;
  approvalBlockedReason?: string;
}

export class PlanningValidationError extends Error {
  constructor(readonly diagnostics: PlanDiagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.stage}:${diagnostic.path.join(".") || "<root>"}:${diagnostic.message}`).join("\n"));
  }
}

export async function runPlanning(args: {
  input: PlanningProviderInput;
  provider?: PlanningProvider;
  providerSelection?: TriageProviderSelection;
  validate: (raw: unknown) => ExecutionPlan;
  normalise?: (raw: unknown, diagnostics: PlanDiagnostic[]) => { raw: unknown; changed: boolean; warnings?: string[] };
}): Promise<PlanningRunResult> {
  const { input, provider } = args;
  const warnings: string[] = [];
  const allDiagnostics: PlanDiagnostic[] = [];
  let syntaxRepairApplied = false;
  let semanticRepairApplied = false;
  let sawQualityRepairablePlan = false;
  let attempts = 0;

  if (!input.config.workflow.automaticTriage || !provider) {
    const fallbackReason = !input.config.workflow.automaticTriage
      ? "automatic model planning is disabled by configuration"
      : args.providerSelection === "deterministic"
        ? "deterministic provider explicitly selected"
        : "no model planning provider was resolved";
    return {
      plan: input.deterministicPlan,
      source: "deterministic-fallback",
      provider: provider?.name ?? "deterministic",
      attempts: 0,
      fallbackReason,
      warnings
    };
  }

  const maxAttempts = Math.min(2, input.config.budgets.triageCalls);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    let result: PlanningProviderResult;
    try {
      result = await provider.plan(input);
    } catch (error) {
      warnings.push(`Planning provider invocation ${attempt} failed: ${messageOf(error)}`);
      continue;
    }

    warnings.push(...(result.warnings ?? []));
    let parsed: ParsedPlanningPayload;
    try {
      parsed = parsePlanningPayload(result.raw);
      syntaxRepairApplied ||= parsed.syntaxRepairApplied;
      if (parsed.syntaxRepairApplied) warnings.push("Planning syntax repair applied once before schema validation.");
    } catch (error) {
      const diagnostics = diagnosticsOf(error, "syntax");
      allDiagnostics.push(...diagnostics);
      warnings.push(`Planning generation attempt ${attempt} produced unparseable JSON: ${messageOf(error)}`);
      continue;
    }

    const validated = validateCandidate(args, parsed.value);
    if (validated.ok) {
      return modelResult(validated.plan, result, attempt, warnings, allDiagnostics, syntaxRepairApplied, semanticRepairApplied);
    }

    allDiagnostics.push(...validated.diagnostics);
    if (validated.diagnostics.some((diagnostic) => diagnostic.stage === "quality")) sawQualityRepairablePlan = true;
    warnings.push(`Planning generation attempt ${attempt} failed validation: ${diagnosticSummary(validated.diagnostics)}`);

    const normalised = args.normalise?.(parsed.value, validated.diagnostics) ?? { raw: parsed.value, changed: false };
    warnings.push(...(normalised.warnings ?? []));
    if (normalised.changed) {
      const normalisedValidation = validateCandidate(args, normalised.raw);
      if (normalisedValidation.ok) {
        semanticRepairApplied = true;
        warnings.push("Planning semantic repair applied with deterministic field normalisation.");
        return modelResult(normalisedValidation.plan, result, attempt, warnings, allDiagnostics, syntaxRepairApplied, semanticRepairApplied);
      }
      allDiagnostics.push(...normalisedValidation.diagnostics);
    }

    if (provider.repair) {
      try {
        const repairResult = await provider.repair(input, {
          plan: normalised.raw,
          diagnostics: validated.diagnostics,
          model: result.model,
          tier: result.tier
        });
        warnings.push(...(repairResult.warnings ?? []));
        const repairedParsed = parsePlanningPayload(repairResult.raw);
        syntaxRepairApplied ||= repairedParsed.syntaxRepairApplied;
        if (repairedParsed.syntaxRepairApplied) warnings.push("Planning syntax repair applied once to semantic repair output.");
        const repairedValidation = validateCandidate(args, repairedParsed.value);
        if (repairedValidation.ok) {
          semanticRepairApplied = true;
          warnings.push("Planning semantic repair applied by the same provider/model.");
          return modelResult(repairedValidation.plan, repairResult, attempt, warnings, allDiagnostics, syntaxRepairApplied, semanticRepairApplied);
        }
        allDiagnostics.push(...repairedValidation.diagnostics);
        warnings.push(`Planning semantic repair output failed validation: ${diagnosticSummary(repairedValidation.diagnostics)}`);
      } catch (error) {
        allDiagnostics.push(...diagnosticsOf(error, "schema"));
        warnings.push(`Planning semantic repair failed: ${messageOf(error)}`);
      }
      if (validated.diagnostics.some((diagnostic) => diagnostic.stage === "quality")) break;
    }
  }

  const fallbackReason = `model planning failed after ${attempts} attempt${attempts === 1 ? "" : "s"}`;
  const approvalBlockedReason = sawQualityRepairablePlan && isGenericFallbackPlan(input.deterministicPlan)
    ? "Deterministic fallback plan is generic while a model-generated plan only needed targeted repair; plan approval is disabled until the plan is revised."
    : undefined;
  warnings.push(approvalBlockedReason ?? "Using deterministic planning fallback after model plan could not be validated.");
  return {
    plan: input.deterministicPlan,
    source: "deterministic-fallback",
    provider: provider.name,
    attempts,
    fallbackReason,
    warnings,
    diagnostics: allDiagnostics,
    syntaxRepairApplied,
    semanticRepairApplied,
    approvalBlockedReason
  };
}

interface ParsedPlanningPayload {
  value: unknown;
  syntaxRepairApplied: boolean;
}

function parsePlanningPayload(raw: unknown): ParsedPlanningPayload {
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (typeof record.result === "string") return parsePlanningText(record.result);
    if (typeof record.content === "string") return parsePlanningText(record.content);
    return { value: raw, syntaxRepairApplied: false };
  }
  if (typeof raw === "string") return parsePlanningText(raw);
  throw new PlanningValidationError([{ stage: "syntax", path: [], code: "unsupported_payload", message: "Planning provider returned neither JSON nor text." }]);
}

function parsePlanningText(text: string): ParsedPlanningPayload {
  const candidate = extractJsonCandidate(text);
  try {
    return { value: JSON.parse(candidate), syntaxRepairApplied: false };
  } catch (firstError) {
    let repaired: string;
    try {
      repaired = jsonrepair(candidate);
    } catch {
      throw new PlanningValidationError([{ stage: "syntax", path: [], code: "invalid_json", message: messageOf(firstError) }]);
    }
    try {
      return { value: JSON.parse(repaired), syntaxRepairApplied: true };
    } catch (secondError) {
      throw new PlanningValidationError([{ stage: "syntax", path: [], code: "jsonrepair_failed", message: messageOf(secondError) }]);
    }
  }
}

function extractJsonCandidate(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (objectStart >= 0 && objectEnd > objectStart) return trimmed.slice(objectStart, objectEnd + 1);
  if (arrayStart >= 0 && arrayEnd > arrayStart) return trimmed.slice(arrayStart, arrayEnd + 1);
  return trimmed;
}

function validateCandidate(args: {
  validate: (raw: unknown) => ExecutionPlan;
}, raw: unknown): { ok: true; plan: ExecutionPlan } | { ok: false; diagnostics: PlanDiagnostic[] } {
  try {
    return { ok: true, plan: args.validate(raw) };
  } catch (error) {
    return { ok: false, diagnostics: diagnosticsOf(error, "schema") };
  }
}

function modelResult(
  plan: ExecutionPlan,
  result: PlanningProviderResult,
  attempts: number,
  warnings: string[],
  diagnostics: PlanDiagnostic[],
  syntaxRepairApplied: boolean,
  semanticRepairApplied: boolean
): PlanningRunResult {
  return {
    plan,
    source: "model",
    provider: result.provider,
    model: result.model,
    attempts,
    warnings,
    diagnostics,
    syntaxRepairApplied,
    semanticRepairApplied
  };
}

function diagnosticsOf(error: unknown, fallbackStage: PlanDiagnostic["stage"]): PlanDiagnostic[] {
  if (error instanceof PlanningValidationError) return error.diagnostics;
  const record = error as { issues?: unknown };
  if (Array.isArray(record?.issues)) {
    return record.issues.map((issue) => {
      const candidate = issue as { path?: unknown[]; code?: string; message?: string };
      return {
        stage: fallbackStage,
        path: Array.isArray(candidate.path) ? candidate.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number") : [],
        code: candidate.code ?? "validation_error",
        message: candidate.message ?? messageOf(issue)
      };
    });
  }
  return [{ stage: fallbackStage, path: [], code: "planning_error", message: messageOf(error) }];
}

function diagnosticSummary(diagnostics: PlanDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.stage}:${diagnostic.path.join(".") || "<root>"}:${diagnostic.message}`).join("; ");
}

function isGenericFallbackPlan(plan: ExecutionPlan): boolean {
  const text = plan.phases.map((phase) => phase.objective).join("\n").toLowerCase();
  return /\bimplement (the )?(primary|approved|high-risk) behavior( change)?\b/.test(text)
    || /\bfocused regression coverage\b/.test(text)
    || /\bactual implementation work will need\b/.test(plan.summary.toLowerCase());
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
