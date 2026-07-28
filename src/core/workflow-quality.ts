import { createHash } from "node:crypto";
import type {
  ArtifactQualityDimension,
  ArtifactQualityDimensionResult,
  ArtifactQualityResult,
  ArtifactRecoveryAttempt,
  ArtifactRecoveryStrategy,
  FailureOwnership,
  ModelProfile,
  PhaseBriefDiagnostic,
  PhaseExecutionBrief,
  WorkflowPhase
} from "./types.js";

const DIMENSIONS: ArtifactQualityDimension[] = [
  "completeness",
  "specificity",
  "traceability",
  "phase-closure",
  "dependency-validity",
  "evidence-coverage",
  "recovery-viability",
  "internal-consistency"
];

export function evaluatePhaseBriefQuality(
  brief: PhaseExecutionBrief,
  phase: WorkflowPhase,
  diagnostics: PhaseBriefDiagnostic[]
): ArtifactQualityResult {
  const dimensions = Object.fromEntries(DIMENSIONS.map((dimension) => [
    dimension,
    dimensionResult(dimension, brief, phase, diagnostics)
  ])) as Record<ArtifactQualityDimension, ArtifactQualityDimensionResult>;
  return {
    artifactType: "phase-brief",
    artifactId: `${brief.phaseId}:r${brief.briefRevision}`,
    overall: overallStatus(Object.values(dimensions)),
    dimensions,
    evaluatedAt: new Date().toISOString()
  };
}

export function classifyPhaseBriefFailure(
  status: "inspection-unavailable" | "inspection-failed" | "quality-blocked",
  diagnostics: PhaseBriefDiagnostic[]
): FailureOwnership {
  if (status === "inspection-unavailable") return "repository_evidence_insufficient";
  if (status === "inspection-failed") return "environment_failure";
  if (diagnostics.some((item) => item.code.includes("provider_failed"))) return "provider_failure";
  return "leanrigor_generation_failure";
}

export function artifactHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function recoveryAttempt(args: {
  attempts: ArtifactRecoveryAttempt[];
  strategy: ArtifactRecoveryStrategy;
  provider: string;
  modelTier: ModelProfile;
  input: unknown;
  output?: unknown;
  inspectionIdentity?: string;
  diagnostics: PhaseBriefDiagnostic[];
  disposition: ArtifactRecoveryAttempt["disposition"];
}): ArtifactRecoveryAttempt {
  const inputArtifactHash = artifactHash(args.input);
  const outputArtifactHash = args.output === undefined ? undefined : artifactHash(args.output);
  const previous = args.attempts.at(-1);
  const validationDiagnostics = args.diagnostics.map((item) => item.code);
  const changed = !previous
    || previous.strategy !== args.strategy
    || previous.provider !== args.provider
    || previous.modelTier !== args.modelTier
    || previous.inputArtifactHash !== inputArtifactHash
    || previous.outputArtifactHash !== outputArtifactHash
    || previous.inspectionIdentity !== args.inspectionIdentity
    || previous.validationDiagnostics.join("\0") !== validationDiagnostics.join("\0");
  return {
    attempt: args.attempts.length + 1,
    strategy: args.strategy,
    provider: args.provider,
    modelTier: args.modelTier,
    inputArtifactHash,
    outputArtifactHash,
    inspectionIdentity: args.inspectionIdentity,
    validationDiagnostics,
    changed,
    disposition: args.disposition,
    timestamp: new Date().toISOString()
  };
}

export function nextRecoveryStrategy(
  attempts: ArtifactRecoveryAttempt[],
  limits: { targeted: number; refreshedInspection: number; alternate: number; fallback: number }
): ArtifactRecoveryStrategy | undefined {
  const used = (strategy: ArtifactRecoveryStrategy) => attempts.filter((attempt) => attempt.strategy === strategy).length;
  if (used("initial-generation") === 0) return "initial-generation";
  if (used("targeted-repair") < limits.targeted) return "targeted-repair";
  if (used("refreshed-inspection") < limits.refreshedInspection) return "refreshed-inspection";
  if (used("alternate-strategy") < limits.alternate) return "alternate-strategy";
  if (used("deterministic-fallback") < limits.fallback) return "deterministic-fallback";
  return undefined;
}

export function identicalDeterministicRetry(
  previous: ArtifactRecoveryAttempt,
  candidate: Pick<ArtifactRecoveryAttempt, "strategy" | "provider" | "modelTier" | "inputArtifactHash" | "inspectionIdentity" | "validationDiagnostics">
): boolean {
  return previous.strategy === candidate.strategy
    && previous.provider === candidate.provider
    && previous.modelTier === candidate.modelTier
    && previous.inputArtifactHash === candidate.inputArtifactHash
    && previous.inspectionIdentity === candidate.inspectionIdentity
    && previous.validationDiagnostics.join("\0") === candidate.validationDiagnostics.join("\0");
}

function dimensionResult(
  dimension: ArtifactQualityDimension,
  brief: PhaseExecutionBrief,
  phase: WorkflowPhase,
  diagnostics: PhaseBriefDiagnostic[]
): ArtifactQualityDimensionResult {
  const codes = diagnostics.filter((item) => dimensionFor(item) === dimension).map((item) => item.code);
  if (codes.length > 0) return { status: "fail", diagnosticCodes: [...new Set(codes)], evidence: diagnostics.filter((item) => codes.includes(item.code)).map((item) => item.message) };
  if (dimension === "recovery-viability" && (brief.recoveryAttempts?.some((attempt) => attempt.disposition === "skipped-identical") ?? false)) {
    return { status: "warning", diagnosticCodes: ["recovery.identical_retry_skipped"], evidence: ["An unchanged deterministic retry was skipped."] };
  }
  const evidence: Record<ArtifactQualityDimension, string[]> = {
    completeness: [`${brief.acceptanceCriteria.length} criteria; ${brief.validationCommands.length} validation commands`],
    specificity: [...brief.relevantFiles, ...brief.relevantSymbols].slice(0, 8),
    traceability: brief.acceptanceCriteria,
    "phase-closure": [`Phase ${phase.id} validation is producible within ${brief.writeAreas.join(", ") || "the approved boundary"}.`],
    "dependency-validity": brief.dependencies.length > 0 ? brief.dependencies : ["No phase dependencies."],
    "evidence-coverage": [...brief.testObligations, ...brief.validationCommands],
    "recovery-viability": [`${brief.recoveryAttempts?.length ?? 0} bounded recovery attempts recorded.`],
    "internal-consistency": [`Brief phase ${brief.phaseId} matches plan phase ${phase.id}.`]
  };
  return { status: "pass", diagnosticCodes: [], evidence: evidence[dimension] };
}

function dimensionFor(diagnostic: PhaseBriefDiagnostic): ArtifactQualityDimension {
  if (diagnostic.field === "dependencies") return "dependency-validity";
  if (diagnostic.field === "acceptanceCriteria") return "traceability";
  if (diagnostic.field === "testObligations" || diagnostic.field === "validationCommands") return "evidence-coverage";
  if (diagnostic.field === "writeAreas") return "phase-closure";
  if (diagnostic.field === "repository" || diagnostic.field === "workflowRevision") return "internal-consistency";
  if (diagnostic.field === "objective" || diagnostic.field === "deliverable" || diagnostic.field === "implementationApproach") return "specificity";
  return "completeness";
}

function overallStatus(values: ArtifactQualityDimensionResult[]): ArtifactQualityResult["overall"] {
  if (values.some((value) => value.status === "fail")) return "fail";
  if (values.some((value) => value.status === "warning")) return "warning";
  return "pass";
}
