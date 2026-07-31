import { createHash } from "node:crypto";
import type {
  ApprovalRecommendation,
  PhaseApprovalPolicy,
  SequentialWorkflowState,
  WorkflowPhase
} from "./types.js";

const highRiskTerms: Array<[RegExp, string]> = [
  [/\bmigrat(e|ion)\b/i, "migration risk"],
  [/\b(public|api|contract|schema)\b/i, "public-contract impact"],
  [/\bsecurity|auth|permission|credential\b/i, "security risk"],
  [/\b(data.integrity|data loss|corrupt)\b/i, "data-integrity risk"],
  [/\b(concurren|race condition|locking)\b/i, "concurrency risk"],
  [/\b(recovery|idempoten)\b/i, "recovery or idempotency risk"],
  [/\b(deploy|production|infrastructure)\b/i, "production infrastructure impact"],
  [/\b(delete|destroy|drop)\b/i, "destructive-operation risk"]
];

export function defaultApprovalPolicy(mode: SequentialWorkflowState["mode"]): PhaseApprovalPolicy {
  return mode === "rigorous" ? "phase-by-phase" : "workflow-authorized";
}

export function approvalRecommendation(state: SequentialWorkflowState, phaseId?: string): ApprovalRecommendation {
  const now = new Date().toISOString();
  const phase = phaseId ? state.plan?.phases.find((candidate) => candidate.id === phaseId) : undefined;
  if (state.mode === "rigorous") {
    return {
      option: "approve-current-phase",
      ruleId: "rigorous-phase-by-phase",
      reasons: ["Rigorous mode requires approval of each phase before coordinator execution."],
      workflowRevision: state.revision,
      phaseId,
      createdAt: now,
      overridable: false
    };
  }

  const reasons = deterministicRiskReasons(state, phase);
  const hasElevatedRisk = reasons.length > 0;
  return {
    option: hasElevatedRisk ? "approve-current-phase" : "approve-all-remaining",
    ruleId: hasElevatedRisk ? "risk-or-discovery-phase-gate" : "bounded-stable-workflow",
    reasons: hasElevatedRisk
      ? reasons
      : ["The planned scope is bounded and stable; no migration, public-contract, security, or data-integrity risk is currently recorded."],
    workflowRevision: state.revision,
    phaseId,
    createdAt: now,
    overridable: !requiresPhaseByPhase(state, reasons)
  };
}

export function requiresPhaseByPhase(state: SequentialWorkflowState, reasons = deterministicRiskReasons(state)): boolean {
  if (reasons.some((reason) => reason.startsWith("The planned scope is bounded and stable"))) return false;
  return state.mode === "rigorous" || reasons.some((reason) =>
    /public-contract|security|data-integrity|destructive-operation|migration risk/.test(reason));
}

export function briefIsCurrent(state: SequentialWorkflowState, phaseId: string): boolean {
  const brief = state.phaseBriefs?.[phaseId];
  return Boolean(
    brief
    && briefStalenessReasons(state, phaseId).length === 0
    && brief.approvalStatus !== "stale"
    && brief.validation.status === "valid"
    && brief.repository.repositoryRevision
    && !brief.materialChangesFromWorkflowPlan.some((change) => change.material)
  );
}

export function briefStalenessReasons(state: SequentialWorkflowState, phaseId: string): Array<{ code: string; message: string }> {
  const brief = state.phaseBriefs?.[phaseId];
  const phase = state.plan?.phases.find((candidate) => candidate.id === phaseId);
  if (!brief || !phase) return [];
  const reasons: Array<{ code: string; message: string }> = [];
  const planRevision = state.approval?.workflowPlanRevision ?? state.revision;
  if (brief.workflowRevision !== planRevision) reasons.push({ code: "brief_plan_revision_stale", message: `Phase ${phaseId} brief belongs to Workflow Plan revision ${brief.workflowRevision}, not ${planRevision}.` });
  if (brief.approvalStatus === "stale") reasons.push({ code: "brief_superseded", message: `Phase ${phaseId} brief revision ${brief.briefRevision} was superseded.` });
  if (!brief.repository.planFingerprint || !brief.repository.dependencyFingerprint || !brief.repository.priorPhaseOutcomesHash || !brief.repository.executionPolicyHash) {
    reasons.push({ code: "brief_provenance_legacy", message: `Phase ${phaseId} brief lacks current dispatch provenance and must be regenerated.` });
  }
  if (brief.repository.constraintHash !== constraintHash(state)) reasons.push({ code: "brief_constraints_stale", message: `Phase ${phaseId} effective constraints changed after brief generation.` });
  if (brief.repository.planFingerprint && brief.repository.planFingerprint !== planFingerprint(phase)) reasons.push({ code: "brief_plan_stale", message: `Phase ${phaseId} approved Workflow Plan content changed after brief generation.` });
  if (brief.repository.dependencyFingerprint && brief.repository.dependencyFingerprint !== stableHash(dependencyIds(phase))) reasons.push({ code: "brief_dependencies_stale", message: `Phase ${phaseId} dependency definition changed after brief generation.` });
  if (brief.repository.priorPhaseOutcomesHash && brief.repository.priorPhaseOutcomesHash !== priorOutcomesHash(state, phase)) reasons.push({ code: "brief_prior_outcome_stale", message: `Phase ${phaseId} assumptions are stale because a prior phase outcome changed.` });
  if (state.git?.context.baseCommit && brief.repository.baseCommit && state.git.context.baseCommit !== brief.repository.baseCommit) reasons.push({ code: "brief_repository_stale", message: `Phase ${phaseId} brief repository base ${brief.repository.baseCommit} differs from workflow base ${state.git.context.baseCommit}.` });
  if (state.git?.integration.headCommit && brief.repository.repositoryRevision !== state.git.integration.headCommit) reasons.push({
    code: "brief_repository_revision_stale",
    message: `Phase ${phaseId} brief inspected repository revision ${brief.repository.repositoryRevision}, not integration revision ${state.git.integration.headCommit}.`
  });
  if (brief.modelTier && brief.modelTier !== phase.modelTier) reasons.push({ code: "brief_provider_policy_stale", message: `Phase ${phaseId} model policy changed after brief generation.` });
  return reasons;
}

export function approvalPermitsExecution(state: SequentialWorkflowState, phaseId: string): boolean {
  if (!briefIsCurrent(state, phaseId)) return false;
  const policy = state.approval?.policy ?? defaultApprovalPolicy(state.mode);
  const brief = state.phaseBriefs?.[phaseId];
  if (policy === "workflow-authorized") return brief?.approvalStatus === "approved" || brief?.approvalStatus === "not-required";
  return state.approval?.currentAuthorizedPhase === phaseId && brief?.approvalStatus === "approved";
}

function deterministicRiskReasons(state: SequentialWorkflowState, phase?: WorkflowPhase): string[] {
  const assessment = state.triage?.assessment;
  const text = [state.request, phase?.objective, phase?.rationale, ...(state.triage?.assumptions ?? [])].filter(Boolean).join("\n");
  const reasons = highRiskTerms.filter(([pattern]) => pattern.test(text)).map(([, reason]) => reason);
  if (assessment?.ambiguity === "high") reasons.push("unresolved assumptions or high ambiguity");
  if (assessment?.blastRadius === "high") reasons.push("wide blast radius");
  if (phase?.riskLevel === "high") reasons.push("high phase risk");
  if (phase && dependencyIds(phase).length > 0 && (state.triage?.assumptions.length ?? 0) > 0) reasons.push("later phase depends on unresolved earlier-phase findings");
  return unique(reasons);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function dependencyIds(phase: WorkflowPhase): string[] {
  return unique([...phase.dependencies, ...phase.dependsOn]);
}

function constraintHash(state: SequentialWorkflowState): string {
  return stableHash(state.constraints?.effective.map((constraint) => constraint.text) ?? state.triage?.constraints.mustNot ?? []);
}

function planFingerprint(phase: WorkflowPhase): string {
  return stableHash({
    id: phase.id,
    objective: phase.objective,
    rationale: phase.rationale,
    dependencies: dependencyIds(phase),
    expectedReadAreas: phase.expectedReadAreas,
    expectedWriteAreas: phase.expectedWriteAreas,
    expectedFilesOrAreas: phase.expectedFilesOrAreas,
    acceptanceCriteria: phase.acceptanceCriteria,
    validationCommands: phase.validationCommands,
    riskLevel: phase.riskLevel,
    modelTier: phase.modelTier
  });
}

function priorOutcomesHash(state: SequentialWorkflowState, phase: WorkflowPhase): string {
  return stableHash(dependencyIds(phase).map((id) => {
    const dependency = state.plan?.phases.find((candidate) => candidate.id === id);
    return {
      id,
      status: dependency?.status,
      completion: dependency?.completion
        ? {
            decision: dependency.completion.decision,
            filesChanged: dependency.completion.filesChanged,
            assumptions: dependency.completion.assumptions,
            remainingRisks: dependency.completion.remainingRisks,
            scopeDeviations: dependency.completion.scopeDeviations
          }
        : undefined
    };
  }));
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
}
