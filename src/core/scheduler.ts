import type { LeanRigorConfig } from "../config/schema.js";
import { detectOwnershipConflicts, ownershipIsExplicit, type OwnershipConflict } from "./ownership.js";
import type { ExecutionPlan, PhaseStatus, SequentialWorkflowState, WorkflowPhase } from "./types.js";

export class PhaseDagError extends Error {}

export interface ReadyPhase {
  phaseId: string;
  objective: string;
  blockedBy: string[];
  conflictsWith: OwnershipConflict[];
}

export interface ReadyPhaseSchedule {
  workflowId: string;
  revision: number;
  readyPhases: ReadyPhase[];
  eligibleCount: number;
  dispatchableCount: number;
  maxParallelPhases: number;
  blockedReasons: string[];
}

export function validatePhaseDag(plan: ExecutionPlan): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const phase of plan.phases) {
    if (ids.has(phase.id)) issues.push(`Phase ${phase.id} is duplicated.`);
    ids.add(phase.id);
    if (phase.dependencies.includes(phase.id) || phase.dependsOn.includes(phase.id)) issues.push(`Phase ${phase.id} depends on itself.`);
  }
  for (const phase of plan.phases) {
    for (const dependency of dependencyIds(phase)) {
      if (!ids.has(dependency)) issues.push(`Phase ${phase.id} depends on missing phase ${dependency}.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.phases.map((phase) => [phase.id, phase]));
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      issues.push(`Dependency cycle detected at ${id}.`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencyIds(byId.get(id))) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const phase of plan.phases) visit(phase.id);
  return unique(issues);
}

export function topologicalPhaseOrder(plan: ExecutionPlan): string[] {
  const issues = validatePhaseDag(plan);
  if (issues.length > 0) throw new PhaseDagError(issues.join("; "));
  const completed = new Set<string>();
  const remaining = new Map(plan.phases.map((phase) => [phase.id, phase]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const wave = [...remaining.values()]
      .filter((phase) => dependencyIds(phase).every((id) => completed.has(id)))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (wave.length === 0) throw new PhaseDagError("No topological progress is possible.");
    for (const phase of wave) {
      remaining.delete(phase.id);
      completed.add(phase.id);
      order.push(phase.id);
    }
  }
  return order;
}

export function refreshPhaseReadiness(state: SequentialWorkflowState, config?: LeanRigorConfig): void {
  if (!state.plan || state.state !== "executing") return;
  const schedule = calculateReadyPhases(state, config);
  const ready = new Set(schedule.readyPhases.map((phase) => phase.phaseId));
  for (const phase of state.plan.phases) {
    if (terminalPhaseStatuses.has(phase.status) || activePhaseStatuses.has(phase.status)) continue;
    phase.status = ready.has(phase.id) ? "ready" : "planned";
  }
}

export function calculateReadyPhases(state: SequentialWorkflowState, config?: LeanRigorConfig): ReadyPhaseSchedule {
  const maxParallelPhases = config?.execution.maxParallelPhases ?? 1;
  const blockedReasons: string[] = [];
  if (!state.plan) {
    return emptySchedule(state, maxParallelPhases, ["Workflow has no approved plan."]);
  }
  const dagIssues = validatePhaseDag(state.plan);
  if (dagIssues.length > 0) return emptySchedule(state, maxParallelPhases, dagIssues);
  if (state.state !== "executing") return emptySchedule(state, maxParallelPhases, [`Workflow state ${state.state} is not executable.`]);
  if (state.blockers.length > 0) return emptySchedule(state, maxParallelPhases, state.blockers);
  if (state.plan.phases.some((phase) => phase.status === "needs_replan" || phase.status === "blocked")) {
    return emptySchedule(state, maxParallelPhases, ["Workflow has a blocked or replanning phase."]);
  }

  const activeLeasedPhases = state.plan.phases.filter((phase) => activePhaseStatuses.has(phase.status));
  const activeConflicts = detectOwnershipConflicts(activeLeasedPhases, config).filter((conflict) => conflict.severity === "blocking");
  const candidates = topologicalPhaseOrder(state.plan)
    .map((id) => phaseById(state.plan!, id))
    .filter((phase): phase is WorkflowPhase => Boolean(phase))
    .filter((phase) => phase.status === "ready" || phase.status === "planned")
    .filter((phase) => dependencyIds(phase).every((id) => phaseById(state.plan!, id)?.status === "completed"))
    .filter((phase) => !hasActiveLease(state, phase.id));
  const candidateConflicts = detectOwnershipConflicts([...candidates, ...activeLeasedPhases], config)
    .filter((conflict) => conflict.severity === "blocking");
  const activeIds = new Set(activeLeasedPhases.map((phase) => phase.id));

  const readyPhases: ReadyPhase[] = [];
  for (const phase of candidates) {
    const blockedBy: string[] = [];
    if ((state.mode === "standard" || state.mode === "rigorous") && !ownershipIsExplicit(phase, state.mode)) {
      blockedBy.push(`${state.mode} mode requires explicit read/write ownership before parallel eligibility.`);
    }
    const conflicts = candidateConflicts
      .filter((conflict) => conflict.phaseA === phase.id || conflict.phaseB === phase.id)
      .filter((conflict) => conflict.severity === "blocking");
    if (activeConflicts.length > 0) blockedBy.push("Active leased phases already have unresolved ownership conflicts.");
    readyPhases.push({ phaseId: phase.id, objective: phase.objective, blockedBy, conflictsWith: conflicts });
  }

  const dispatchable = selectDispatchable(readyPhases, activeIds, maxParallelPhases);
  return {
    workflowId: state.id,
    revision: state.revision,
    readyPhases,
    eligibleCount: readyPhases.length,
    dispatchableCount: dispatchable.length,
    maxParallelPhases,
    blockedReasons
  };
}

function selectDispatchable(readyPhases: ReadyPhase[], activeIds: Set<string>, maxParallelPhases: number): ReadyPhase[] {
  const selected: ReadyPhase[] = [];
  for (const phase of readyPhases) {
    if (selected.length >= maxParallelPhases) break;
    if (phase.blockedBy.length > 0) continue;
    if (phase.conflictsWith.some((conflict) => activeIds.has(conflict.phaseA) || activeIds.has(conflict.phaseB))) continue;
    if (phase.conflictsWith.some((conflict) => selected.some((candidate) => candidate.phaseId === conflict.phaseA || candidate.phaseId === conflict.phaseB))) continue;
    selected.push(phase);
  }
  return selected;
}

export function dependencyIds(phase: WorkflowPhase | undefined): string[] {
  return unique([...(phase?.dependencies ?? []), ...(phase?.dependsOn ?? [])]);
}

export const activePhaseStatuses = new Set<PhaseStatus>(["leased", "running", "completion_pending"]);
export const terminalPhaseStatuses = new Set<PhaseStatus>(["completed", "needs_repair", "needs_review", "needs_replan", "blocked", "cancelled"]);

function hasActiveLease(state: SequentialWorkflowState, phaseId: string): boolean {
  const lease = state.phaseLeases[phaseId];
  return Boolean(lease && !lease.releasedAt && Date.parse(lease.expiresAt) > Date.now());
}

function phaseById(plan: ExecutionPlan, id: string): WorkflowPhase | undefined {
  return plan.phases.find((phase) => phase.id === id);
}

function emptySchedule(state: SequentialWorkflowState, maxParallelPhases: number, blockedReasons: string[]): ReadyPhaseSchedule {
  return {
    workflowId: state.id,
    revision: state.revision,
    readyPhases: [],
    eligibleCount: 0,
    dispatchableCount: 0,
    maxParallelPhases,
    blockedReasons
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
