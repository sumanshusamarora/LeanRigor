import type { LeanRigorConfig } from "../config/schema.js";
import type { ModelTriageRecommendation, TriageEvidencePacket, TriageInspectionRequest, TriageInspectionResult, TriageOutput } from "./types.js";
import { deterministicRecommendationFromEvidence, recommendationToTriageOutput } from "./assessment.js";
import { collectTriageEvidence } from "./triage-evidence.js";
import { modelTriageRecommendationSchema, triageInspectionResultSchema, triageOutputSchema } from "./triage-schema.js";

export interface TriageProviderResult {
  raw: unknown;
  provider: string;
  model?: string;
  warnings?: string[];
}

export interface TriageProvider {
  name: string;
  recommend(input: TriageRecommendationInput): Promise<TriageProviderResult>;
  repairRecommendation?(input: TriageRecommendationInput, failure: string): Promise<TriageProviderResult>;
  inspect?(input: TriageInspectionInput): Promise<TriageProviderResult>;
}

export interface TriageRecommendationInput {
  request: string;
  root: string;
  config: LeanRigorConfig;
  evidence: TriageEvidencePacket;
}

export interface TriageInspectionInput {
  request: string;
  root: string;
  config: LeanRigorConfig;
  evidence: TriageEvidencePacket;
  inspection: TriageInspectionRequest;
}

export interface TriageRunResult {
  output: TriageOutput;
  source: "model" | "deterministic-fallback";
  provider: string;
  model?: string;
  attempts: number;
  fallbackReason?: string;
  warnings: string[];
  evidence: TriageEvidencePacket;
  recommendation?: ModelTriageRecommendation;
  policyDecision?: {
    finalMode: TriageOutput["workflow"]["finalMode"];
    overrideReasons: string[];
    fastEligible: boolean;
  };
  inspection?: {
    used: boolean;
    request?: TriageInspectionRequest;
    result?: TriageInspectionResult;
    failureReason?: string;
  };
}

export type TriageProviderSelection = "auto" | "claude" | "deterministic";

export class TriageExecutionError extends Error {}
export class TriageProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "provider_process_failure" | "max_turns" | "max_budget" | "malformed_json" | "schema_failure" | "inspection_failure" | "transient" = "provider_process_failure"
  ) {
    super(message);
  }
}

/**
 * Runs model triage with one schema-correction retry, then falls back to the
 * deterministic classifier. Policy overrides are always applied after model
 * output validation, so the model is advisory rather than authoritative.
 */
export async function runTriage(args: {
  request: string;
  root: string;
  config: LeanRigorConfig;
  provider?: TriageProvider;
  providerSelection?: TriageProviderSelection;
}): Promise<TriageRunResult> {
  const { request, root, config, provider } = args;
  const warnings: string[] = [];
  let evidence = await collectTriageEvidence({ request, root, config });

  if (!config.workflow.automaticTriage || !provider) {
    const fallbackReason = !config.workflow.automaticTriage
      ? "automatic triage is disabled by configuration"
      : args.providerSelection === "deterministic"
        ? "deterministic provider explicitly selected"
        : "no model triage provider was resolved";
    const recommendation = deterministicRecommendationFromEvidence(evidence, config);
    const policy = recommendationToTriageOutput({ request, evidence, recommendation, config });
    return {
      output: policy.output,
      source: "deterministic-fallback",
      provider: provider?.name ?? "deterministic",
      attempts: 0,
      fallbackReason,
      warnings,
      evidence,
      recommendation,
      policyDecision: policy.policyDecision,
      inspection: { used: false }
    };
  }

  let attempts = 0;
  let lastFailure: string | undefined;
  const repairAllowance = config.budgets.triageRecommendationRepairAttempts;
  for (let attempt = 0; attempt <= repairAllowance; attempt += 1) {
    try {
      attempts += 1;
      const result = attempt === 0 || !provider.repairRecommendation
        ? await provider.recommend({ request, root, config, evidence })
        : await provider.repairRecommendation({ request, root, config, evidence }, lastFailure ?? "Recommendation output failed validation.");
      warnings.push(...(result.warnings ?? []));
      let recommendation = validateRecommendation(normaliseModelPayload(result.raw));
      const inspection = await maybeInspect({ request, root, config, evidence, recommendation, provider, warnings });
      if (inspection?.result) {
        evidence = mergeInspectionFindings(evidence, inspection.result);
        const rerun = await provider.recommend({ request, root, config, evidence });
        attempts += 1;
        warnings.push(...(rerun.warnings ?? []));
        recommendation = validateRecommendation(normaliseModelPayload(rerun.raw));
      }
      const policy = recommendationToTriageOutput({ request, evidence, recommendation, config });
      return {
        output: policy.output,
        source: "model",
        provider: result.provider,
        model: result.model,
        attempts,
        warnings,
        evidence,
        recommendation,
        policyDecision: policy.policyDecision,
        inspection
      };
    } catch (error) {
      lastFailure = messageOf(error);
      warnings.push(`Model triage recommendation attempt ${attempts} failed: ${lastFailure}`);
      if (error instanceof TriageProviderError && (error.kind === "max_turns" || error.kind === "max_budget")) {
        warnings.push("Not retrying unchanged recommendation after a structural provider budget failure.");
        break;
      }
    }
  }

  const fallbackReason = `model triage recommendation failed after ${attempts} attempt${attempts === 1 ? "" : "s"}`;
  warnings.push("Model recommendation unavailable; deterministic policy selected a safe fallback.");
  const recommendation = deterministicRecommendationFromEvidence(evidence, config);
  const policy = recommendationToTriageOutput({ request, evidence, recommendation, config });
  return {
    output: policy.output,
    source: "deterministic-fallback",
    provider: provider.name,
    attempts,
    fallbackReason,
    warnings,
    evidence,
    recommendation,
    policyDecision: policy.policyDecision,
    inspection: { used: false }
  };
}

function validateRecommendation(value: unknown): ModelTriageRecommendation {
  const parsed = modelTriageRecommendationSchema.safeParse(value);
  if (parsed.success) return parsed.data as ModelTriageRecommendation;
  const legacy = triageOutputSchema.safeParse(value);
  if (legacy.success) return legacyTriageToRecommendation(legacy.data as TriageOutput);
  return modelTriageRecommendationSchema.parse(value) as ModelTriageRecommendation;
}

function legacyTriageToRecommendation(value: TriageOutput): ModelTriageRecommendation {
  return {
    version: 1,
    complexity: value.assessment.complexity,
    ambiguity: value.assessment.ambiguity,
    blastRadius: value.assessment.blastRadius,
    risks: {
      architecturalImpact: value.assessment.architecturalImpact,
      securityRisk: value.assessment.securityRisk,
      dataIntegrityRisk: value.assessment.dataIntegrityRisk,
      operationalRisk: value.assessment.operationalRisk
    },
    recommendedMode: value.workflow.modelRecommendation,
    confidence: value.workflow.confidence,
    parallelism: value.workflow.parallelism,
    constraints: value.constraints.mustNot,
    approachSummary: value.task.summary,
    needsAdditionalInspection: value.inspection.required,
    inspectionQuestions: value.inspection.targets.map((target, index) => ({
      id: `legacy-target-${index + 1}`,
      question: target,
      reason: "Legacy TriageOutput inspection target translated for compatibility."
    })),
    evidenceReferences: value.escalationReasons,
    taskType: value.task.type,
    clarification: value.clarification
  };
}

async function maybeInspect(args: {
  request: string;
  root: string;
  config: LeanRigorConfig;
  evidence: TriageEvidencePacket;
  recommendation: ModelTriageRecommendation;
  provider: TriageProvider;
  warnings: string[];
}): Promise<NonNullable<TriageRunResult["inspection"]>> {
  const inspectionRequest = inspectionRequestFor(args.evidence, args.recommendation, args.config);
  if (!inspectionRequest || !args.provider.inspect) return { used: false };
  try {
    const result = await args.provider.inspect({
      request: args.request,
      root: args.root,
      config: args.config,
      evidence: args.evidence,
      inspection: inspectionRequest
    });
    args.warnings.push(...(result.warnings ?? []));
    const parsed = triageInspectionResultSchema.parse(normaliseModelPayload(result.raw)) as TriageInspectionResult;
    return { used: true, request: inspectionRequest, result: parsed };
  } catch (error) {
    const failureReason = messageOf(error);
    args.warnings.push(`Targeted triage inspection failed: ${failureReason}`);
    return { used: true, request: inspectionRequest, failureReason };
  }
}

function inspectionRequestFor(evidence: TriageEvidencePacket, recommendation: ModelTriageRecommendation, config: LeanRigorConfig): TriageInspectionRequest | undefined {
  if (!recommendation.needsAdditionalInspection || recommendation.inspectionQuestions.length === 0) return undefined;
  const allowedPaths = unique([
    ...evidence.request.explicitlyNamedPaths,
    ...recommendation.inspectionQuestions.flatMap((question) => question.allowedPaths ?? [])
  ]).slice(0, 8);
  if (allowedPaths.length === 0) return undefined;
  return {
    questions: recommendation.inspectionQuestions.slice(0, 4),
    allowedPaths,
    maxReads: config.budgets.triageInspectionMaxReads,
    maxBytes: config.budgets.triageInspectionMaxBytes
  };
}

function mergeInspectionFindings(evidence: TriageEvidencePacket, result: TriageInspectionResult): TriageEvidencePacket {
  const next = structuredClone(evidence);
  next.deterministicFindings.push(...result.findings.map((finding) => ({ ...finding, source: `targeted inspection: ${finding.source}` })));
  for (const finding of result.findings) {
    if (finding.confidence !== "verified") continue;
    if (finding.key.endsWith("publicContract") && typeof finding.value === "boolean") next.changeSignals.publicContract = finding.value;
    if (finding.key.endsWith("schemaChange") && typeof finding.value === "boolean") next.changeSignals.schemaChange = finding.value;
    if (finding.key.endsWith("migration") && typeof finding.value === "boolean") next.changeSignals.migration = finding.value;
    if (finding.key.endsWith("security") && typeof finding.value === "boolean") next.changeSignals.security = finding.value;
    if (finding.key.endsWith("concurrency") && typeof finding.value === "boolean") next.changeSignals.concurrency = finding.value;
    if (finding.key.endsWith("destructiveOperation") && typeof finding.value === "boolean") next.changeSignals.destructiveOperation = finding.value;
    if (finding.key.endsWith("productionInfrastructure") && typeof finding.value === "boolean") next.changeSignals.productionInfrastructure = finding.value;
    if (finding.key.endsWith("dataIntegrity") && typeof finding.value === "boolean") next.changeSignals.dataIntegrity = finding.value;
    if (finding.key.endsWith("externalIntegration") && typeof finding.value === "boolean") next.changeSignals.externalIntegration = finding.value;
  }
  next.unresolvedQuestions = next.unresolvedQuestions.filter((question) => {
    const normalized = question.id.replace(/^triage-/, "").toLowerCase();
    return !result.findings.some((finding) => finding.confidence === "verified" && finding.key.toLowerCase().endsWith(normalized));
  });
  return next;
}

/** Accept direct JSON, fenced JSON, or Claude Code's JSON result envelope. */
export function normaliseModelPayload(raw: unknown): unknown {
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (typeof record.result === "string") return parseJsonText(record.result);
    if (typeof record.content === "string") return parseJsonText(record.content);
    return raw;
  }
  if (typeof raw === "string") return parseJsonText(raw);
  throw new TriageExecutionError("Triage provider returned neither JSON nor text.");
}

function parseJsonText(value: string): unknown {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) return JSON.parse(fenced);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new TriageExecutionError("Model response did not contain valid JSON.");
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
