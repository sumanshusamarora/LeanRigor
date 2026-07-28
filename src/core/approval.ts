import type {
  ApprovalRecommendation,
  MaterialPlanChange,
  PhaseApprovalPolicy,
  PhaseExecutionBrief,
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

export function buildPhaseExecutionBrief(
  state: SequentialWorkflowState,
  phase: WorkflowPhase,
  provider?: string,
  previous?: PhaseExecutionBrief
): PhaseExecutionBrief {
  const materialChangesFromWorkflowPlan = compareBriefAgainstWorkflowPlan(phase, previous);
  const policy = state.approval?.policy ?? defaultApprovalPolicy(state.mode);
  const isAuthorized = policy === "workflow-authorized" || state.approval?.currentAuthorizedPhase === phase.id;
  const planRevision = state.approval?.workflowPlanRevision ?? state.revision;
  return {
    phaseId: phase.id,
    workflowRevision: planRevision,
    briefRevision: (previous?.briefRevision ?? 0) + 1,
    generatedAt: new Date().toISOString(),
    objective: phase.objective,
    deliverable: phase.acceptanceCriteria.join(" "),
    currentBehaviour: phase.rationale,
    implementationApproach: `Implement the bounded ${phase.id} objective only within its approved read and write areas.`,
    readAreas: unique(phase.expectedReadAreas),
    writeAreas: unique(phase.expectedWriteAreas.length > 0 ? phase.expectedWriteAreas : phase.expectedFilesOrAreas),
    dependencies: dependencyIds(phase),
    assumptions: unique(state.triage?.assumptions ?? []),
    exclusions: unique(state.constraints?.effective.map((constraint) => constraint.text) ?? state.triage?.constraints.mustNot ?? []),
    acceptanceCriteria: [...phase.acceptanceCriteria],
    testObligations: [...phase.acceptanceCriteria],
    validationCommands: [...phase.validationCommands],
    risks: unique([phase.riskLevel === "none" ? "No material phase risk recorded." : `${phase.riskLevel} phase risk.`, ...deterministicRiskReasons(state, phase)]),
    provider,
    modelTier: phase.modelTier,
    materialChangesFromWorkflowPlan,
    approvalStatus: materialChangesFromWorkflowPlan.length > 0 ? "stale" : isAuthorized ? "approved" : "pending"
  };
}

export function compareBriefAgainstWorkflowPlan(phase: WorkflowPhase, brief?: PhaseExecutionBrief): MaterialPlanChange[] {
  if (!brief) return [];
  const changes: MaterialPlanChange[] = [];
  const allowedWrites = new Set(phase.expectedWriteAreas.length > 0 ? phase.expectedWriteAreas : phase.expectedFilesOrAreas);
  const unexpectedWrites = brief.writeAreas.filter((area) => !allowedWrites.has(area));
  if (unexpectedWrites.length > 0) changes.push(change("write-boundary", phase.id, [...allowedWrites], unexpectedWrites, "The brief adds a write boundary outside the approved phase."));
  if (!sameItems(phase.acceptanceCriteria, brief.acceptanceCriteria)) changes.push(change("acceptance-criteria", phase.id, phase.acceptanceCriteria, brief.acceptanceCriteria, "The brief changes approved acceptance criteria."));
  const missingValidation = phase.validationCommands.filter((command) => !brief.validationCommands.includes(command));
  if (missingValidation.length > 0) changes.push(change("validation", phase.id, phase.validationCommands, brief.validationCommands, "The brief removes mandatory validation."));
  if (!sameItems(dependencyIds(phase), brief.dependencies)) changes.push(change("dependency", phase.id, dependencyIds(phase), brief.dependencies, "The brief changes phase dependencies."));
  return changes;
}

export function briefIsCurrent(state: SequentialWorkflowState, phaseId: string): boolean {
  const brief = state.phaseBriefs?.[phaseId];
  return Boolean(
    brief
    && brief.workflowRevision === (state.approval?.workflowPlanRevision ?? state.revision)
    && brief.approvalStatus !== "stale"
    && brief.materialChangesFromWorkflowPlan.length === 0
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

function change(category: MaterialPlanChange["category"], affectedPhase: string, previousValue: string[], proposedValue: string[], reason: string): MaterialPlanChange {
  return { category, previousValue, proposedValue, affectedPhase, severity: "high", reason, requiredTransition: "reapprove-plan" };
}

function sameItems(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
