import { jsonrepair } from "jsonrepair";
import type { LeanRigorConfig, ModelTier } from "../config/schema.js";
import type { ExecutionPlan, PlanningAttemptRecord, TriageOutput } from "./types.js";
import { TriageProviderError, type TriageProviderSelection } from "./triage-runner.js";

export interface PlanDiagnostic {
  stage: "syntax" | "schema" | "quality";
  path: Array<string | number>;
  code: string;
  message: string;
  contradictionType?: string;
  affectedPhase?: string;
  effectiveConstraint?: string;
  repairAttempt?: "same-model" | "deterministic-normalisation" | "none";
  resolution?: "repaired" | "blocked" | "fallback";
}

export interface PlanningProviderResult {
  raw: unknown;
  provider: string;
  model?: string;
  tier?: ModelTier;
  launchMode?: string;
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
  effectiveConstraints?: string[];
  effectiveConstraintSet?: {
    policy: string[];
    triage: string[];
    userAdditions: string[];
    userRemovals: Array<{ target?: string; text: string }>;
    userOverrides: Array<{ target?: string; text: string }>;
    finalEffective: string[];
  };
  constraintChanges?: unknown;
  deterministicPlan: ExecutionPlan;
  revisionRequests: ExecutionPlan["revisionRequests"];
}

export interface PlanningProvider {
  name: string;
  plan(input: PlanningProviderInput): Promise<PlanningProviderResult>;
  repair?(input: PlanningProviderInput, request: PlanningRepairRequest): Promise<PlanningProviderResult>;
  escalate?(input: PlanningProviderInput, request: PlanningRepairRequest): Promise<PlanningProviderResult>;
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
  attemptRecords: PlanningAttemptRecord[];
}

export class PlanningValidationError extends Error {
  constructor(readonly diagnostics: PlanDiagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.stage}:${diagnostic.path.join(".") || "<root>"}:${diagnostic.message}`).join("\n"));
  }
}

export class PlanningProviderInvocationError extends Error {
  constructor(
    message: string,
    readonly kind: TriageProviderError["kind"],
    readonly attempt: Pick<PlanningProviderResult, "provider" | "model" | "tier" | "launchMode">
  ) {
    super(message);
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
  const attemptRecords: PlanningAttemptRecord[] = [];
  let syntaxRepairApplied = false;
  let semanticRepairApplied = false;
  let sawQualityRepairablePlan = false;
  let sawConstraintContradiction = false;
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
      warnings,
      attemptRecords
    };
  }

  const maxAttempts = Math.min(2, input.config.budgets.triageCalls);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    let result: PlanningProviderResult;
    try {
      result = await provider.plan(input);
    } catch (error) {
      const failureReason = messageOf(error);
      warnings.push(`Planning provider invocation ${attempt} failed: ${failureReason}`);
      attemptRecords.push(attemptRecord("draft", failedAttemptResult(error), {
        invocation: "failed",
        validation: "not-attempted",
        failureReason
      }));
      if (isStructuralProviderFailure(error)) break;
      continue;
    }

    warnings.push(...(result.warnings ?? []));
    const draftRecord = attemptRecord("draft", result, {
      invocation: "succeeded",
      validation: "not-attempted"
    });
    let parsed: ParsedPlanningPayload;
    try {
      parsed = parsePlanningPayload(result.raw);
      syntaxRepairApplied ||= parsed.syntaxRepairApplied;
      if (parsed.syntaxRepairApplied) warnings.push("Planning syntax repair applied once before schema validation.");
    } catch (error) {
      const diagnostics = diagnosticsOf(error, "syntax");
      allDiagnostics.push(...diagnostics);
      draftRecord.validation = "failed";
      draftRecord.diagnosticCodes = diagnosticCodes(diagnostics);
      draftRecord.failureReason = messageOf(error);
      attemptRecords.push(draftRecord);
      warnings.push(`Planning generation attempt ${attempt} produced unparseable JSON: ${messageOf(error)}`);
      continue;
    }

    const validated = validateCandidate(args, parsed.value);
    if (validated.ok) {
      draftRecord.validation = "passed";
      attemptRecords.push(draftRecord);
      return modelResult(validated.plan, result, attempt, warnings, allDiagnostics, syntaxRepairApplied, semanticRepairApplied, attemptRecords);
    }

    allDiagnostics.push(...validated.diagnostics);
    draftRecord.validation = "failed";
    draftRecord.diagnosticCodes = diagnosticCodes(validated.diagnostics);
    attemptRecords.push(draftRecord);
    if (validated.diagnostics.some((diagnostic) => diagnostic.stage === "quality")) sawQualityRepairablePlan = true;
    if (validated.diagnostics.some(isConstraintDiagnostic)) sawConstraintContradiction = true;
    warnings.push(`Planning generation attempt ${attempt} failed validation: ${diagnosticSummary(validated.diagnostics)}`);

    const normalised = args.normalise?.(parsed.value, validated.diagnostics) ?? { raw: parsed.value, changed: false };
    warnings.push(...(normalised.warnings ?? []));
    let latestPlan = normalised.raw;
    let latestDiagnostics = validated.diagnostics;
    if (normalised.changed) {
      const normalisedValidation = validateCandidate(args, normalised.raw);
      attemptRecords.push(attemptRecord("normalisation", undefined, {
        invocation: "not-attempted",
        validation: normalisedValidation.ok ? "passed" : "failed",
        diagnosticCodes: normalisedValidation.ok ? [] : diagnosticCodes(normalisedValidation.diagnostics)
      }));
      if (normalisedValidation.ok) {
        semanticRepairApplied = true;
        warnings.push("Planning semantic repair applied with deterministic field normalisation.");
        return modelResult(normalisedValidation.plan, result, attempt, warnings, allDiagnostics, syntaxRepairApplied, semanticRepairApplied, attemptRecords);
      }
      allDiagnostics.push(...normalisedValidation.diagnostics);
      latestDiagnostics = normalisedValidation.diagnostics;
    }

    if (provider.repair) {
      let repairResult: PlanningProviderResult | undefined;
      try {
        warnings.push("Attempting same-provider/model planning repair for exact validation diagnostics.");
        repairResult = await provider.repair(input, {
          plan: normalised.raw,
          diagnostics: validated.diagnostics.map((diagnostic) => ({ ...diagnostic, repairAttempt: "same-model" })),
          model: result.model,
          tier: result.tier
        });
      } catch (error) {
        const failureReason = messageOf(error);
        allDiagnostics.push(...diagnosticsOf(error, "schema"));
        attemptRecords.push(attemptRecord("repair", result, {
          invocation: "failed",
          validation: "not-attempted",
          failureReason
        }));
        warnings.push(`Planning semantic repair failed: ${failureReason}`);
      }
      if (repairResult) {
        const repairRecord = attemptRecord("repair", repairResult, {
          invocation: "succeeded",
          validation: "not-attempted"
        });
        try {
        warnings.push(...(repairResult.warnings ?? []));
        const repairedParsed = parsePlanningPayload(repairResult.raw);
        syntaxRepairApplied ||= repairedParsed.syntaxRepairApplied;
        if (repairedParsed.syntaxRepairApplied) warnings.push("Planning syntax repair applied once to semantic repair output.");
        const repairedValidation = validateCandidate(args, repairedParsed.value);
        if (repairedValidation.ok) {
          repairRecord.validation = "passed";
          attemptRecords.push(repairRecord);
          semanticRepairApplied = true;
          warnings.push("Planning semantic repair applied by the same provider/model.");
          markDiagnosticsResolution(allDiagnostics, validated.diagnostics, "repaired");
          return modelResult(repairedValidation.plan, repairResult, attempt, warnings, allDiagnostics, syntaxRepairApplied, semanticRepairApplied, attemptRecords);
        }
        repairRecord.validation = "failed";
        repairRecord.diagnosticCodes = diagnosticCodes(repairedValidation.diagnostics);
        attemptRecords.push(repairRecord);
        if (repairedValidation.diagnostics.some(isConstraintDiagnostic)) sawConstraintContradiction = true;
        allDiagnostics.push(...repairedValidation.diagnostics);
        latestPlan = repairedParsed.value;
        latestDiagnostics = repairedValidation.diagnostics;
        warnings.push(`Planning semantic repair output failed validation: ${diagnosticSummary(repairedValidation.diagnostics)}`);
      } catch (error) {
        const diagnostics = diagnosticsOf(error, "schema");
        allDiagnostics.push(...diagnostics);
        repairRecord.validation = "failed";
        repairRecord.diagnosticCodes = diagnosticCodes(diagnostics);
        repairRecord.failureReason = messageOf(error);
        attemptRecords.push(repairRecord);
        warnings.push(`Planning semantic repair failed: ${messageOf(error)}`);
      }
      }
    }

    if (provider.escalate && latestDiagnostics.some(isArchitecturalDiagnostic)) {
      let escalationResult: PlanningProviderResult | undefined;
      try {
        warnings.push("Escalating unresolved architectural planning diagnostics to the configured planning tier.");
        escalationResult = await provider.escalate(input, {
          plan: latestPlan,
          diagnostics: latestDiagnostics,
          model: result.model,
          tier: result.tier
        });
      } catch (error) {
        const failureReason = messageOf(error);
        attemptRecords.push(attemptRecord("escalation", result, {
          invocation: "failed",
          validation: "not-attempted",
          failureReason
        }));
        warnings.push(`Planning architecture escalation failed: ${failureReason}`);
      }
      if (escalationResult) {
        const escalationRecord = attemptRecord("escalation", escalationResult, {
          invocation: "succeeded",
          validation: "not-attempted"
        });
        try {
          const escalatedParsed = parsePlanningPayload(escalationResult.raw);
          const escalatedValidation = validateCandidate(args, escalatedParsed.value);
          if (escalatedValidation.ok) {
            escalationRecord.validation = "passed";
            attemptRecords.push(escalationRecord);
            semanticRepairApplied = true;
            warnings.push("Planning architecture escalation produced a valid bounded plan.");
            return modelResult(escalatedValidation.plan, escalationResult, attempt, warnings, allDiagnostics, syntaxRepairApplied, semanticRepairApplied, attemptRecords);
          }
          escalationRecord.validation = "failed";
          escalationRecord.diagnosticCodes = diagnosticCodes(escalatedValidation.diagnostics);
          attemptRecords.push(escalationRecord);
          allDiagnostics.push(...escalatedValidation.diagnostics);
          if (escalatedValidation.diagnostics.some(isConstraintDiagnostic)) sawConstraintContradiction = true;
          warnings.push(`Planning architecture escalation failed validation: ${diagnosticSummary(escalatedValidation.diagnostics)}`);
        } catch (error) {
          const diagnostics = diagnosticsOf(error, "schema");
          allDiagnostics.push(...diagnostics);
          escalationRecord.validation = "failed";
          escalationRecord.diagnosticCodes = diagnosticCodes(diagnostics);
          escalationRecord.failureReason = messageOf(error);
          attemptRecords.push(escalationRecord);
          warnings.push(`Planning architecture escalation returned invalid output: ${messageOf(error)}`);
        }
      }
    }
    if (validated.diagnostics.some((diagnostic) => diagnostic.stage === "quality")) break;
  }

  const fallbackReason = `model planning failed after ${attempts} attempt${attempts === 1 ? "" : "s"}`;
  const approvalBlockedReason = sawConstraintContradiction
    ? "Model planning contradicted approved constraints and repair did not produce a valid plan; plan approval is disabled until the plan is revised."
    : isGenericFallbackPlan(input.deterministicPlan)
    ? sawQualityRepairablePlan
      ? "Deterministic fallback plan is generic while a model-generated plan did not pass targeted repair; plan approval is disabled until planning is retried or the plan is revised."
      : "Model planning failed before producing an approval-quality plan and the deterministic fallback is generic; plan approval is disabled until planning is retried or the plan is revised."
    : undefined;
  if (approvalBlockedReason) {
    for (const diagnostic of allDiagnostics) {
      if (isConstraintDiagnostic(diagnostic) && !diagnostic.resolution) diagnostic.resolution = "blocked";
    }
  }
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
    approvalBlockedReason,
    attemptRecords
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

function isConstraintDiagnostic(diagnostic: PlanDiagnostic): boolean {
  return diagnostic.code.startsWith("constraint.");
}

function isArchitecturalDiagnostic(diagnostic: PlanDiagnostic): boolean {
  return diagnostic.code === "scope.mixed_architectural_boundaries"
    || diagnostic.code === "closure.future_dependency"
    || diagnostic.code === "dependency.unlinked_producer"
    || diagnostic.code === "dependency.write_boundary_overlap";
}

function isStructuralProviderFailure(error: unknown): boolean {
  return (error instanceof TriageProviderError || error instanceof PlanningProviderInvocationError)
    && ["provider_process_failure", "max_turns", "max_budget"].includes(error.kind);
}

function failedAttemptResult(error: unknown): PlanningProviderResult | undefined {
  return error instanceof PlanningProviderInvocationError
    ? { raw: undefined, ...error.attempt }
    : undefined;
}

function diagnosticCodes(diagnostics: PlanDiagnostic[]): string[] {
  return [...new Set(diagnostics.map((diagnostic) => diagnostic.code))];
}

function attemptRecord(
  stage: PlanningAttemptRecord["stage"],
  result: PlanningProviderResult | undefined,
  outcome: Pick<PlanningAttemptRecord, "invocation" | "validation"> & Partial<Pick<PlanningAttemptRecord, "diagnosticCodes" | "failureReason">>
): PlanningAttemptRecord {
  return {
    stage,
    tier: result?.tier,
    model: result?.model,
    launchMode: result?.launchMode,
    invocation: outcome.invocation,
    validation: outcome.validation,
    diagnosticCodes: outcome.diagnosticCodes ?? [],
    failureReason: outcome.failureReason
  };
}

function markDiagnosticsResolution(allDiagnostics: PlanDiagnostic[], matched: PlanDiagnostic[], resolution: NonNullable<PlanDiagnostic["resolution"]>): void {
  for (const diagnostic of allDiagnostics) {
    if (!matched.some((candidate) => candidate.code === diagnostic.code && candidate.message === diagnostic.message && candidate.path.join(".") === diagnostic.path.join("."))) continue;
    diagnostic.resolution = resolution;
  }
}

function modelResult(
  plan: ExecutionPlan,
  result: PlanningProviderResult,
  attempts: number,
  warnings: string[],
  diagnostics: PlanDiagnostic[],
  syntaxRepairApplied: boolean,
  semanticRepairApplied: boolean,
  attemptRecords: PlanningAttemptRecord[]
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
    semanticRepairApplied,
    attemptRecords
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
