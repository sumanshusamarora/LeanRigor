import { listFlows, resumeFlow } from "./flow.js";
import type { CommitPlan, SequentialWorkflowState, WorkflowLifecycleState, WorkflowMode, WorkflowPhase } from "./types.js";

export interface WorkflowListSummary {
  id: string;
  request: string;
  state: WorkflowLifecycleState;
  mode: WorkflowMode;
  updatedAt: string;
}

export interface ActiveWorkflowSelection {
  status: "none" | "one" | "multiple";
  workflow?: WorkflowListSummary;
  workflows: WorkflowListSummary[];
  message: string;
}

export interface WorkflowNextSummary {
  workflow: WorkflowListSummary;
  label: string;
  userDecisionRequired: boolean;
  pendingDecision: string | null;
  pendingAction: string;
  allowedIntents: string[];
  summary: Record<string, unknown>;
  troubleshooting: {
    showCommandsOnlyOnFailure: true;
    internalOperations: string[];
  };
}

export async function activeWorkflowSelection(root: string): Promise<ActiveWorkflowSelection> {
  const flows = (await listFlows(root)).filter((flow) => !["completed", "cancelled"].includes(flow.state));
  const workflows = flows.map((flow) => ({
    id: flow.id,
    request: flow.request,
    state: flow.state,
    mode: flow.mode,
    updatedAt: flow.updatedAt
  }));
  if (workflows.length === 0) {
    return { status: "none", workflows, message: "No active LeanRigor workflow exists in this repository." };
  }
  if (workflows.length === 1) {
    return { status: "one", workflow: workflows[0], workflows, message: "One active LeanRigor workflow is available." };
  }
  return { status: "multiple", workflows, message: "Multiple active LeanRigor workflows require user selection." };
}

export async function resolveSingleActiveWorkflow(root: string): Promise<SequentialWorkflowState> {
  const selection = await activeWorkflowSelection(root);
  if (selection.status === "none") throw new Error("No active LeanRigor workflow exists. Start one with a request.");
  if (selection.status === "multiple") throw new Error("Multiple active LeanRigor workflows exist. Choose a workflow ID before continuing.");
  if (!selection.workflow) throw new Error("Active workflow selection is missing workflow details.");
  return resumeFlow(root, selection.workflow.id);
}

export function workflowNextSummary(state: SequentialWorkflowState): WorkflowNextSummary {
  const workflow = workflowListSummary(state);
  const phase = currentPhaseObject(state);
  const base = {
    workflow,
    troubleshooting: {
      showCommandsOnlyOnFailure: true as const,
      internalOperations: internalOperationsFor(state)
    }
  };

  if (state.state === "awaiting_clarification") {
    return {
      ...base,
      label: "Clarification",
      userDecisionRequired: true,
      pendingDecision: "Answer the single blocking clarification question.",
      pendingAction: state.clarification?.question ?? "What specific behaviour should change?",
      allowedIntents: ["answer", "cancel", "show status"],
      summary: { reason: state.clarification?.reason }
    };
  }
  if (state.state === "awaiting_approach_approval") {
    return {
      ...base,
      label: "Approach approval",
      userDecisionRequired: true,
      pendingDecision: "Approve this approach, request changes, reject it, or cancel.",
      pendingAction: "Approve this approach, request changes, or cancel?",
      allowedIntents: ["approve", "looks good", "continue", "revise", "reject", "cancel", "show status"],
      summary: {
        proposed: state.approach?.proposed,
        preferredBecause: state.approach?.preferredBecause,
        risks: state.approach?.primaryRisks ?? [],
        validation: state.approach?.validationStrategy ?? []
      }
    };
  }
  if (state.state === "awaiting_plan_approval") {
    return {
      ...base,
      label: "Plan approval",
      userDecisionRequired: true,
      pendingDecision: "Approve this plan, request changes, or cancel.",
      pendingAction: "Approve this plan, request changes, or cancel?",
      allowedIntents: ["approve", "looks good", "continue", "revise", "cancel", "show status", "show plan"],
      summary: {
        phases: state.plan?.phases.map((candidate, index) => ({
          number: index + 1,
          id: candidate.id,
          objective: candidate.objective,
          status: candidate.status,
          validation: candidate.validationCommands
        })) ?? [],
        validation: unique(state.plan?.phases.flatMap((candidate) => candidate.validationCommands) ?? [])
      }
    };
  }
  if (state.state === "executing" && phase) {
    const needsIntervention = ["needs_repair", "needs_review", "needs_replan", "blocked"].includes(phase.status);
    return {
      ...base,
      label: needsIntervention ? "Phase completion review" : "Phase execution",
      userDecisionRequired: needsIntervention,
      pendingDecision: needsIntervention ? phase.completion?.reason ?? "The active phase needs intervention." : null,
      pendingAction: phaseNextAction(phase.status),
      allowedIntents: phaseIntents(phase.status),
      summary: {
        phase: phase.id,
        objective: phase.objective,
        status: phase.status,
        completionGate: phase.completion?.decision ?? "pending",
        criteria: phase.completion ? summariseCriteria(phase.completion.criteria) : undefined,
        validation: phase.completion?.validation.status ?? "pending",
        repairAttempts: phase.repairAttempts.length,
        scopeDeviations: phase.scopeDeviations
      }
    };
  }
  if (state.state === "validating" || state.state === "reviewing") {
    return {
      ...base,
      label: "Final integrated review",
      userDecisionRequired: false,
      pendingDecision: null,
      pendingAction: "Run the final integrated review and record the result.",
      allowedIntents: ["continue", "show status", "cancel"],
      summary: {
        validation: state.validation.map((evidence) => ({ command: evidence.command, status: evidence.status, result: evidence.result })),
        review: state.review
      }
    };
  }
  if (state.state === "awaiting_commit_approval") {
    return {
      ...base,
      label: "Commit proposal",
      userDecisionRequired: true,
      pendingDecision: "Review the commit proposal. No commit or push has occurred.",
      pendingAction: "Review the proposal, ask for changes, complete the workflow, or cancel.",
      allowedIntents: ["show proposal", "complete", "cancel", "show status"],
      summary: { commitPlan: commitPlanSummary(state.commitPlan) }
    };
  }
  if (state.state === "blocked") {
    return {
      ...base,
      label: "Blocked",
      userDecisionRequired: true,
      pendingDecision: state.blockers[0] ?? "Workflow is blocked.",
      pendingAction: "Resolve the blocker, revise the workflow, or cancel.",
      allowedIntents: ["show status", "cancel"],
      summary: { blockers: state.blockers }
    };
  }
  return {
    ...base,
    label: "Workflow status",
    userDecisionRequired: false,
    pendingDecision: null,
    pendingAction: "Inspect the workflow state.",
    allowedIntents: ["show status", "cancel"],
    summary: {}
  };
}

export function currentPhaseObject(state: SequentialWorkflowState): WorkflowPhase | undefined {
  return state.plan?.phases.find((phase) => phase.status === "running" || phase.status === "leased" || phase.status === "completion_pending")
    ?? state.plan?.phases.find((phase) => phase.status === "ready")
    ?? state.plan?.phases.find((phase) => ["needs_repair", "needs_review", "needs_replan", "blocked"].includes(phase.status));
}

export function phaseRepairBudget(state: SequentialWorkflowState): number {
  if (state.mode === "fast") return 1;
  return 2;
}

function workflowListSummary(state: SequentialWorkflowState): WorkflowListSummary {
  return {
    id: state.id,
    request: state.request,
    state: state.state,
    mode: state.mode,
    updatedAt: state.updatedAt
  };
}

function phaseNextAction(status: string): string {
  if (status === "needs_repair") return "Repair the phase within the gate's requested scope; continue cannot bypass repair.";
  if (status === "needs_review") return "Review the uncertain phase evidence or revise the plan.";
  if (status === "needs_replan") return "Revise the plan before continuing.";
  if (status === "blocked") return "Resolve the blocker or cancel.";
  if (status === "ready") return "Execute the ready phase after acquiring the internal phase lease, record validation, and submit completion evidence.";
  return "Execute the leased phase, record validation, and submit completion evidence.";
}

function phaseIntents(status: string): string[] {
  if (status === "needs_repair") return ["repair it", "revise", "show status", "cancel"];
  if (status === "needs_review") return ["review", "revise", "show status", "cancel"];
  if (status === "needs_replan") return ["revise", "show status", "cancel"];
  if (status === "blocked") return ["show status", "cancel"];
  return ["continue", "show status", "show plan", "cancel"];
}

function internalOperationsFor(state: SequentialWorkflowState): string[] {
  if (state.state === "awaiting_clarification") return ["answer"];
  if (state.state === "awaiting_approach_approval") return ["approve-approach", "reject-approach", "cancel"];
  if (state.state === "awaiting_plan_approval") return ["approve-plan", "revise-plan", "cancel"];
  if (state.state === "executing") return ["ready", "lease-phase", "phase-start", "record-validation", "phase-complete", "repair", "recover-leases", "revise-plan", "cancel"];
  if (state.state === "validating" || state.state === "reviewing") return ["record-validation", "record-review"];
  if (state.state === "awaiting_commit_approval") return ["commit-plan", "complete", "cancel"];
  return ["status"];
}

function commitPlanSummary(plan: CommitPlan | undefined): unknown {
  return plan ? {
    generatedAt: plan.generatedAt,
    note: plan.note,
    groups: plan.groups.map((group) => ({ message: group.message, files: group.files, rationale: group.rationale }))
  } : undefined;
}

function summariseCriteria(criteria: Array<{ status: string }>): { met: number; notMet: number; uncertain: number; notApplicable: number } {
  return {
    met: criteria.filter((criterion) => criterion.status === "met").length,
    notMet: criteria.filter((criterion) => criterion.status === "not_met").length,
    uncertain: criteria.filter((criterion) => criterion.status === "uncertain").length,
    notApplicable: criteria.filter((criterion) => criterion.status === "not_applicable").length
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
