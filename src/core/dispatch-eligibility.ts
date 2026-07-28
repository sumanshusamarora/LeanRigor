import { createHash } from "node:crypto";
import type { LeanRigorConfig } from "../config/schema.js";
import { approvalPermitsExecution, briefStalenessReasons } from "./approval.js";
import { detectOwnershipConflicts, ownershipIsExplicit } from "./ownership.js";
import type {
  PhaseDispatchBlocker,
  PhaseDispatchEligibility,
  SequentialWorkflowState,
  WorkflowPhase
} from "./types.js";

export const PHASE_PREPARATION_CAPABILITY = Symbol("leanrigor.phase-preparation");
export const TRUSTED_INTERNAL_PHASE_EXECUTION_CAPABILITY = Symbol("leanrigor.trusted-internal-phase-execution");

export interface PhaseDispatchEligibilityOptions {
  stage?: "preparation" | "dispatch";
  explicitlySelected?: boolean;
  ownerId?: string;
  now?: Date;
}

export function evaluatePhaseDispatchEligibility(
  state: SequentialWorkflowState,
  phaseId: string,
  config?: LeanRigorConfig,
  options: PhaseDispatchEligibilityOptions = {}
): PhaseDispatchEligibility {
  const blockers: PhaseDispatchBlocker[] = [];
  const phase = state.plan?.phases.find((candidate) => candidate.id === phaseId);
  const dependencyReadyPhases = dependencyReadyCandidates(state);
  const recommendedPhaseId = dependencyReadyPhases[0]?.id;
  const dependencyReady = Boolean(
    phase
    && (
      dependencyReadyPhases.some((candidate) => candidate.id === phase.id)
      || (
        ["leased", "running"].includes(phase.status)
        && dependencyIds(phase).every((id) => state.plan?.phases.find((candidate) => candidate.id === id)?.status === "completed")
      )
    )
  );
  const brief = state.phaseBriefs?.[phaseId];

  if (state.state !== "executing") add(blockers, "workflow_state", `Workflow state ${state.state} does not permit phase execution.`, "Return to the execution lifecycle before dispatch.");
  if (!state.plan) add(blockers, "missing_plan", "Workflow has no approved Workflow Plan.", "Generate and approve a Workflow Plan.");
  if (!phase) add(blockers, "unknown_phase", `Phase ${phaseId} does not exist in the approved Workflow Plan.`);
  if (phase && !dependencyReady) add(blockers, "dependencies_incomplete", `Phase ${phaseId} dependencies are not complete.`, "Complete and integrate the required phases first.");
  if (
    phase
    && dependencyReady
    && recommendedPhaseId
    && recommendedPhaseId !== phaseId
    && !options.explicitlySelected
  ) {
    add(blockers, "phase_not_selected", `Phase ${phaseId} is dependency-ready but ${recommendedPhaseId} is the deterministic recommendation.`, "Explicitly select the out-of-order dependency-ready phase.");
  }
  if (!brief) {
    add(blockers, "brief_missing", `Phase ${phaseId} has no Phase Execution Brief.`, "Generate the detailed Phase Execution Brief.");
  } else {
    for (const reason of briefStalenessReasons(state, phaseId)) add(blockers, reason.code, reason.message, "Regenerate the Phase Execution Brief and approve its new revision.");
    if (phase && config && brief.repository.executionPolicyHash && brief.repository.executionPolicyHash !== executionPolicyHash(phase, config)) {
      add(blockers, "brief_execution_policy_stale", `Phase ${phaseId} execution provider or workspace policy changed after brief generation.`, "Regenerate the Phase Execution Brief under the current execution policy.");
    }
    if (brief.validation.status !== "valid") add(blockers, "brief_quality_blocked", `Phase ${phaseId} brief revision ${brief.briefRevision} did not pass deterministic quality validation.`, "Repair the brief before approval.");
    if (brief.materialChangesFromWorkflowPlan.some((change) => change.material)) {
      add(blockers, "material_drift", `Phase ${phaseId} brief contains unresolved material changes from the approved Workflow Plan.`, "Revise or reapprove the affected plan boundary.");
    }
    if (!approvalPermitsExecution(state, phaseId)) {
      add(blockers, "brief_not_approved", `Phase ${phaseId} brief revision ${brief.briefRevision} is not exactly approved.`, `Approve Phase ${phaseId} brief revision ${brief.briefRevision}.`);
    }
  }
  if (state.blockers.length > 0) {
    for (const reason of state.blockers) add(blockers, "workflow_safety_blocker", reason, "Resolve the recorded workflow blocker.");
  }
  if (phase && (state.mode === "standard" || state.mode === "rigorous") && !ownershipIsExplicit(phase, state.mode)) {
    add(blockers, "ownership_uncertain", `${state.mode} mode requires explicit phase read and write boundaries.`, "Revise the phase boundaries.");
  }
  if (phase) {
    const activeLease = state.phaseLeases[phaseId];
    if (
      activeLease
      && !activeLease.releasedAt
      && Date.parse(activeLease.expiresAt) > (options.now ?? new Date()).getTime()
      && activeLease.ownerId !== options.ownerId
    ) {
      add(blockers, "active_lease", `Phase ${phaseId} has an active lease held by ${activeLease.ownerId}.`, "Wait for or recover the existing lease.");
    }
    const active = state.plan?.phases.filter((candidate) => ["leased", "running", "completion_pending"].includes(candidate.status) && candidate.id !== phaseId) ?? [];
    const conflicts = detectOwnershipConflicts([phase, ...active], config).filter((conflict) =>
      conflict.severity === "blocking" && (conflict.phaseA === phaseId || conflict.phaseB === phaseId));
    if (conflicts.length > 0) add(blockers, "ownership_conflict", `Phase ${phaseId} conflicts with an active phase write boundary.`, "Wait for the conflicting phase to finish.");
  }

  if ((options.stage ?? "dispatch") === "dispatch") validateWorkspace(state, phaseId, blockers);
  const eligible = blockers.length === 0;
  return {
    eligible,
    phaseId,
    workflowRevision: state.revision,
    briefRevision: brief?.briefRevision,
    dependencyReady,
    dispatchReady: eligible && (options.stage ?? "dispatch") === "dispatch",
    recommendedPhaseId,
    blockers
  };
}

export function dependencyReadyCandidates(state: SequentialWorkflowState): WorkflowPhase[] {
  if (!state.plan || state.state !== "executing") return [];
  return state.plan.phases.filter((phase) =>
    ["planned", "ready"].includes(phase.status)
    && dependencyIds(phase).every((id) => state.plan?.phases.find((candidate) => candidate.id === id)?.status === "completed")
  );
}

export function phasePlanFingerprint(phase: WorkflowPhase): string {
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

export function dependencyFingerprint(phase: WorkflowPhase): string {
  return stableHash(dependencyIds(phase));
}

export function priorPhaseOutcomesHash(state: SequentialWorkflowState, phase: WorkflowPhase): string {
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

export function executionPolicyHash(phase: WorkflowPhase, config?: LeanRigorConfig): string {
  return stableHash({
    modelTier: phase.modelTier,
    workspaceStrategy: config?.execution.workspaceStrategy,
    dependencyBootstrap: config?.execution.dependencyBootstrap,
    workerEnvironment: config?.execution.workerControls.environment
  });
}

export function effectiveConstraintHash(state: SequentialWorkflowState): string {
  return stableHash(state.constraints?.effective.map((constraint) => constraint.text) ?? state.triage?.constraints.mustNot ?? []);
}

export function workspaceIdentity(args: {
  repositoryIdentity?: string;
  workspacePath: string;
  baseCommit: string;
}): string {
  return stableHash(args);
}

function validateWorkspace(state: SequentialWorkflowState, phaseId: string, blockers: PhaseDispatchBlocker[]): void {
  const workspace = state.git?.phaseWorkspaces[phaseId];
  const preparation = workspace?.preparation;
  if (!workspace) {
    add(blockers, "workspace_missing", `Phase ${phaseId} workspace has not been created.`, "Prepare the phase workspace.");
    return;
  }
  if (!preparation || !["available", "prepared"].includes(preparation.status)) {
    const recovery = preparation?.approvalRequired ? "Review and approve the exact bootstrap request." : "Retry deterministic workspace preparation.";
    add(blockers, preparation?.status === "blocked" ? "workspace_bootstrap_pending" : "workspace_not_prepared", preparation?.reason ?? `Phase ${phaseId} workspace preparation has not completed.`, recovery);
    return;
  }
  const expectedIdentity = workspaceIdentity({
    repositoryIdentity: state.git?.context.repositoryIdentity,
    workspacePath: workspace.path,
    baseCommit: workspace.baseCommit
  });
  if (preparation.workspaceIdentity !== expectedIdentity) {
    add(blockers, "workspace_identity_mismatch", `Phase ${phaseId} preparation evidence belongs to a different workspace identity.`, "Rerun workspace preparation.");
  }
  if (preparation.worktreePath !== workspace.path || preparation.basis?.commit !== workspace.baseCommit) {
    add(blockers, "workspace_basis_mismatch", `Phase ${phaseId} preparation evidence does not match the current workspace path and base commit.`, "Rerun workspace preparation.");
  }
  if (preparation.validationCommandsAvailable === false) {
    add(blockers, "validation_unavailable", `Phase ${phaseId} validation commands are unavailable in the prepared workspace.`, "Complete an approved bootstrap or revise validation.");
  }
}

function dependencyIds(phase: WorkflowPhase): string[] {
  return [...new Set([...phase.dependencies, ...phase.dependsOn])];
}

function add(blockers: PhaseDispatchBlocker[], code: string, message: string, recovery?: string): void {
  if (!blockers.some((blocker) => blocker.code === code && blocker.message === message)) blockers.push({ code, message, recovery });
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
}
