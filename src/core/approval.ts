import type {
  ApprovalRecommendation,
  PhaseApprovalPolicy,
  SequentialWorkflowState,
  WorkflowPhase
} from "./types.js";
import { dependencyIds } from "./scheduler.js";

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
    && brief.workflowRevision === (state.approval?.workflowPlanRevision ?? state.revision)
    && brief.approvalStatus !== "stale"
    && brief.validation.status === "valid"
    && brief.repository.repositoryRevision
    && !brief.materialChangesFromWorkflowPlan.some((change) => change.material)
  );
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
