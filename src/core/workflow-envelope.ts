import type {
  PhaseExecutionBrief,
  SequentialWorkflowState,
  WorkflowDecisionEnvelope,
  WorkflowDecisionOption,
  WorkflowPendingDecision,
  WorkflowPhase
} from "./types.js";

export interface PersistedPhaseResultView {
  workflowId: string;
  workflowRevision: number;
  phaseId: string;
  lifecycle: {
    phaseStatus: string;
    briefApproval: string;
    workspacePreparation: string;
    providerDispatch: string;
    providerResult: string;
    resultIdentity: "verified" | "rejected" | "pending" | "not_available";
    scopeCheck: "passed" | "failed" | "pending" | "not_available";
    completionGate: string;
    phaseAcceptance: "accepted" | "not_accepted";
    integration: string;
    integratedValidation: string;
  };
  brief?: {
    revision: number;
    workflowRevision: number;
    objective: string;
    deliverable: string;
  };
  workspace?: {
    path: string;
    identity?: string;
    baseCommit: string;
    preparationRevision?: number;
    evidence: string[];
  };
  provider?: {
    id: string;
    executionId: string;
    sessionId?: string;
    status: string;
    summary?: string;
  };
  evidence: {
    changedFiles: string[];
    scopeDeviations: string[];
    validation: Array<{ command: string; status: string; result: string }>;
    criteria: Array<{ criterion: string; status: string; evidence: string[] }>;
    assumptions: string[];
    remainingRisks: string[];
  };
  blockers: string[];
  nextSafeActions: string[];
  manualInspection: {
    required: false;
    availableOnlyWhenExplicitlyRequested: true;
  };
}

export function workflowDecisionEnvelope(state: SequentialWorkflowState): WorkflowDecisionEnvelope {
  const decision = state.approval?.pendingDecision?.status === "pending"
    ? state.approval.pendingDecision
    : undefined;
  const phase = currentPhase(state);
  return {
    workflowId: state.id,
    workflowRevision: state.revision,
    state: state.state,
    status: workflowStatus(state, phase, decision),
    decision: decision ? {
      id: decision.id,
      type: decision.type,
      workflowRevision: decision.workflowRevision,
      phaseId: decision.phaseId,
      briefRevision: decision.briefRevision,
      preparationRevision: decision.preparationRevision,
      integrationRevision: decision.integrationRevision,
      additionalTurns: decision.additionalTurns,
      question: decision.question,
      options: decisionActionsForQuestion(decision).map((action) => decisionOption(state, decision, action))
    } : undefined,
    nextOperation: nextOperation(state, phase, decision)
  };
}

const MAX_ASK_USER_QUESTION_OPTIONS = 4;

function decisionActionsForQuestion(decision: WorkflowPendingDecision): string[] {
  const actions = [...new Set(decision.allowedActions)];
  if (actions.length <= MAX_ASK_USER_QUESTION_OPTIONS) return actions;
  const preferred = decision.type === "execution-recovery"
    ? [
        "discard-out-of-scope-and-retry",
        "continue-execution",
        "retry-execution",
        "revise-phase-brief",
        "revise-plan",
        "view-details",
        "cancel-workflow"
      ]
    : decision.type === "material-drift-review"
      ? [
          "revise-plan",
          "revise-phase-brief",
          "view-details",
          "review-material-drift",
          "cancel-workflow"
        ]
      : actions;
  const ranked = [
    ...preferred.filter((action) => actions.includes(action)),
    ...actions.filter((action) => !preferred.includes(action))
  ];
  if (!ranked.includes("cancel-workflow")) return ranked.slice(0, MAX_ASK_USER_QUESTION_OPTIONS);
  return [
    ...ranked.filter((action) => action !== "cancel-workflow").slice(0, MAX_ASK_USER_QUESTION_OPTIONS - 1),
    "cancel-workflow"
  ];
}

export function phaseResultView(state: SequentialWorkflowState, phaseId: string): PersistedPhaseResultView {
  const phase = state.plan?.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) throw new Error(`Unknown phase: ${phaseId}`);
  const brief = state.phaseBriefs?.[phaseId];
  const workspace = state.git?.phaseWorkspaces[phaseId] ?? phase.workspace;
  const record = state.execution.records[phaseId];
  const completion = phase.completion;
  const diagnostics = record?.diagnostics ?? {};
  const resultAccepted = diagnostics.resultAccepted;
  const integrated = state.git?.integration.integratedPhaseIds.includes(phaseId) ?? false;
  const conflicted = state.git?.integration.conflictingPhaseIds.includes(phaseId) ?? false;
  return {
    workflowId: state.id,
    workflowRevision: state.revision,
    phaseId,
    lifecycle: {
      phaseStatus: phase.status,
      briefApproval: brief?.approvalStatus ?? "not_generated",
      workspacePreparation: workspace?.preparation?.status ?? "not_started",
      providerDispatch: record ? "dispatched" : "not_dispatched",
      providerResult: record?.status ?? "not_received",
      resultIdentity: resultAccepted === false ? "rejected" : record?.status === "result_recorded" ? "verified" : record ? "pending" : "not_available",
      scopeCheck: resultAccepted === false ? "failed" : record?.status === "result_recorded" ? "passed" : record ? "pending" : "not_available",
      completionGate: completion?.decision ?? "not_started",
      phaseAcceptance: completion?.decision === "completed" ? "accepted" : "not_accepted",
      integration: conflicted ? "conflicted" : integrated ? "integrated" : completion?.decision === "completed" ? "ready" : "not_started",
      integratedValidation: state.git?.integrationValidation?.status ?? "not_started"
    },
    brief: briefSummary(brief),
    workspace: workspace ? {
      path: workspace.path,
      identity: workspace.preparation?.workspaceIdentity,
      baseCommit: workspace.baseCommit,
      preparationRevision: workspace.preparation?.preparationRevision,
      evidence: workspace.preparation?.evidence ?? []
    } : undefined,
    provider: record ? {
      id: record.providerId,
      executionId: record.providerExecutionId,
      sessionId: record.providerSession?.sessionId,
      status: record.status,
      summary: record.resultSummary
    } : undefined,
    evidence: {
      changedFiles: completion?.filesChanged ?? record?.checkpoint?.changedFiles ?? phase.filesChanged,
      scopeDeviations: completion?.scopeDeviations ?? phase.scopeDeviations,
      validation: (completion?.validation.commands ?? phase.validationResults).map((entry) => ({
        command: entry.command,
        status: entry.status,
        result: entry.result
      })),
      criteria: completion?.criteria ?? [],
      assumptions: completion?.assumptions ?? [],
      remainingRisks: completion?.remainingRisks ?? []
    },
    blockers: phaseBlockers(state, phase, record?.resultSummary),
    nextSafeActions: phaseNextActions(state, phase, integrated, conflicted),
    manualInspection: {
      required: false,
      availableOnlyWhenExplicitlyRequested: true
    }
  };
}

function workflowStatus(
  state: SequentialWorkflowState,
  phase: WorkflowPhase | undefined,
  decision: WorkflowPendingDecision | undefined
): WorkflowDecisionEnvelope["status"] {
  if (decision) {
    return {
      code: `awaiting_${decision.type.replaceAll("-", "_")}`,
      summary: decision.question,
      phaseId: decision.phaseId,
      briefRevision: decision.briefRevision
    };
  }
  if (state.state === "completed") return { code: "user_approved_final_completion", summary: "Final integrated review passed and the user completed the workflow." };
  if (state.state === "awaiting_commit_approval") return { code: "final_completion_pending", summary: "Final integrated review passed. User-approved final completion is pending." };
  if (state.state === "reviewing") return { code: "final_integrated_review_pending", summary: "Final integrated validation passed. Final integrated review is pending." };
  if (state.state === "validating") return { code: "final_integrated_validation_pending", summary: "All accepted phases are integrated. Final integrated validation is pending." };
  if (!phase) return { code: state.state, summary: `Workflow is ${state.state}.` };
  const view = phaseResultView(state, phase.id);
  if (view.lifecycle.integration === "integrated") return { code: "phase_integrated", summary: `${phase.id} was accepted and integrated.`, phaseId: phase.id };
  if (view.lifecycle.completionGate === "completed") return { code: "completion_gate_passed", summary: `${phase.id} completion gate passed. Integration is ${view.lifecycle.integration}.`, phaseId: phase.id };
  if (view.lifecycle.providerResult === "result_recorded") return { code: "provider_completed", summary: `${phase.id} provider result was received and identity verified. Completion evaluation is pending.`, phaseId: phase.id };
  if (view.lifecycle.providerDispatch === "dispatched") return { code: "provider_running", summary: `${phase.id} provider execution is ${view.provider?.status}.`, phaseId: phase.id, briefRevision: view.brief?.revision };
  if (view.lifecycle.workspacePreparation === "blocked") return { code: "workspace_preparation_blocked", summary: `${phase.id} has not started. Workspace preparation is blocked.`, phaseId: phase.id, briefRevision: view.brief?.revision };
  if (view.lifecycle.workspacePreparation === "prepared" || view.lifecycle.workspacePreparation === "available") return { code: "workspace_prepared", summary: `${phase.id} workspace is prepared. Provider dispatch has not started.`, phaseId: phase.id, briefRevision: view.brief?.revision };
  if (view.lifecycle.briefApproval === "approved") return { code: "phase_brief_approved", summary: `${phase.id} execution brief revision ${view.brief?.revision} is approved.`, phaseId: phase.id, briefRevision: view.brief?.revision };
  return { code: "phase_preflight", summary: `${phase.id} is awaiting its next persisted preflight transition.`, phaseId: phase.id, briefRevision: view.brief?.revision };
}

function nextOperation(
  state: SequentialWorkflowState,
  phase: WorkflowPhase | undefined,
  decision: WorkflowPendingDecision | undefined
): WorkflowDecisionEnvelope["nextOperation"] {
  if (decision) return { type: "answer-decision", automaticallyPermitted: false };
  const active = Object.values(state.execution.records).some((record) => ["dispatching", "queued", "running", "collecting"].includes(record.status));
  if (active) return { type: "execution-poll", automaticallyPermitted: true };
  if (state.state === "validating") return { type: "validate-integration", automaticallyPermitted: true };
  if (state.state === "executing" && phase && ["planned", "ready"].includes(phase.status)) {
    return { type: "execute-next", automaticallyPermitted: state.phaseBriefs?.[phase.id]?.approvalStatus === "approved" };
  }
  return undefined;
}

function decisionOption(state: SequentialWorkflowState, decision: WorkflowPendingDecision, action: string): WorkflowDecisionOption {
  const phase = decision.phaseId;
  const root = quote(state.root);
  const common = `--decision-id ${quote(decision.id)} --expected-revision ${state.revision} --root ${root}`;
  const options: Record<string, Omit<WorkflowDecisionOption, "intent">> = {
    answer: { label: "Answer clarification", description: "Record an answer to the persisted clarification question.", command: `leanrigor flow answer ${state.id} --answer-file <answer-file> ${common}` },
    "approve-approach": { label: "Approve approach and create plan", description: "Approve the persisted approach and generate the Workflow Plan.", command: `leanrigor flow approve-approach ${state.id} --provider auto ${common}` },
    "revise-approach": { label: "Revise approach", description: "Record revision feedback and return a fresh approach decision.", command: `leanrigor flow revise-approach ${state.id} --feedback-file <feedback-file> ${common}` },
    "approve-plan": { label: "Approve Workflow Plan and prepare Phase 1 brief", description: "Approve only the Workflow Plan and generate the first detailed brief.", command: `leanrigor flow approve-plan ${state.id} --approval-policy ${state.mode === "rigorous" ? "phase-by-phase" : "workflow-authorized"} ${common}` },
    "revise-plan": { label: "Revise Workflow Plan", description: "Record plan feedback and generate a fresh Workflow Plan decision.", command: `leanrigor flow revise-plan ${state.id} --feedback-file <feedback-file> --provider auto ${common}` },
    "retry-planning": { label: "Retry structured planning", description: "Retry bounded structured planning with the configured provider.", command: `leanrigor flow retry-plan ${state.id} --provider auto ${common}` },
    "approve-phase": { label: `Review and approve ${phaseLabel(phase)} brief`, description: "Approve exactly the persisted detailed brief revision.", command: `leanrigor flow approve-phase ${state.id} ${phase} --brief-revision ${decision.briefRevision} --workflow-revision ${decision.workflowRevision} ${common}` },
    "revise-phase-brief": { label: `Revise ${phaseLabel(phase)} brief`, description: "Persist feedback and create a new unapproved brief revision.", command: `leanrigor flow phase-brief ${state.id} ${phase} --feedback-file <feedback-file> ${common}` },
    "approve-bootstrap": { label: "Approve workspace bootstrap", description: "Approve only the persisted command and preparation identity.", command: bootstrapCommand(state, decision, common) },
    "retry-preparation": { label: "Retry workspace preparation", description: "Retry deterministic preparation without authorizing another command.", command: `leanrigor flow execute-next ${state.id} --provider auto --json --root ${root}` },
    "retry-brief": { label: "Retry bounded brief generation", description: "Retry read-only inspection and brief generation within the persisted boundary.", command: `leanrigor flow phase-brief ${state.id} ${phase} --refresh ${common}` },
    "retry-execution": { label: "Retry provider execution", description: "Retry the configured provider using persisted recovery state.", command: `leanrigor flow execution-recover ${state.id} --provider auto --json ${common}` },
    "discard-out-of-scope-and-retry": {
      label: "Discard out-of-scope changes and retry",
      description: "Restore only rejected out-of-scope paths, preserve approved-scope work, and retry in a fresh compact provider session.",
      command: `leanrigor flow discard-out-of-scope-and-retry ${state.id} --provider auto --json ${common}`
    },
    "continue-execution": {
      label: `Continue with ${decision.additionalTurns ?? "additional"} additional turns`,
      description: "Continue from the preserved phase worktree using the exact persisted additional-turn allowance.",
      command: `leanrigor flow continue-execution ${state.id} --provider auto --json ${common}`
    },
    "review-material-drift": { label: "Review material drift", description: "Show the persisted scope or identity mismatch before replanning.", command: `leanrigor flow phase-result ${state.id} ${phase} --json --root ${root}` },
    "record-review": { label: "Record final integrated review", description: "Record the final review result against persisted integrated evidence.", command: `leanrigor flow record-review ${state.id} --status <status> --summary <summary> ${common}` },
    "complete-workflow": { label: "Complete workflow", description: "Record explicit user-approved final completion without committing.", command: `leanrigor flow complete ${state.id} ${common}` },
    "view-details": {
      label: "View details",
      description: "Show persisted workflow evidence without inspecting a phase worktree.",
      command: decision.type === "material-drift-review" && phase && state.phaseBriefs?.[phase]
        ? `leanrigor flow phase-brief-show ${state.id} ${phase} --root ${root}`
        : phase
          ? `leanrigor flow phase-result ${state.id} ${phase} --json --root ${root}`
          : `leanrigor flow status ${state.id} --json --root ${root}`
    },
    "cancel-workflow": { label: "Cancel workflow", description: "Cancel without manual execution, commit, or push.", command: `leanrigor flow cancel ${state.id} ${common}` }
  };
  const option = options[action] ?? { label: action, description: "Apply the exact persisted workflow action." };
  return { intent: action, ...option };
}

function bootstrapCommand(state: SequentialWorkflowState, decision: WorkflowPendingDecision, common: string): string | undefined {
  if (decision.type !== "workspace-bootstrap-approval") return undefined;
  return `leanrigor flow approve-bootstrap ${state.id} ${decision.phaseId} --brief-revision ${decision.briefRevision} --preparation-revision ${decision.preparationRevision} --workspace-identity ${quote(decision.workspaceIdentity)} --command ${quote(decision.command)} ${common}`;
}

function currentPhase(state: SequentialWorkflowState): WorkflowPhase | undefined {
  const pendingPhase = state.approval?.pendingDecision?.phaseId;
  return state.plan?.phases.find((phase) => phase.id === pendingPhase)
    ?? state.plan?.phases.find((phase) => ["leased", "running", "completion_pending"].includes(phase.status))
    ?? state.plan?.phases.find((phase) => ["needs_repair", "needs_review", "needs_replan", "blocked"].includes(phase.status))
    ?? state.plan?.phases.find((phase) => phase.status === "completed" && !(state.git?.integration.integratedPhaseIds.includes(phase.id) ?? false))
    ?? state.plan?.phases.find((phase) => ["planned", "ready"].includes(phase.status) && phase.dependencies.every((id) => state.plan?.phases.find((candidate) => candidate.id === id)?.status === "completed"));
}

function briefSummary(brief: PhaseExecutionBrief | undefined): PersistedPhaseResultView["brief"] {
  return brief ? {
    revision: brief.briefRevision,
    workflowRevision: brief.workflowRevision,
    objective: brief.objective,
    deliverable: brief.deliverable
  } : undefined;
}

function phaseBlockers(state: SequentialWorkflowState, phase: WorkflowPhase, resultSummary?: string): string[] {
  return [
    ...state.blockers,
    ...(["needs_repair", "needs_review", "needs_replan", "blocked"].includes(phase.status)
      ? [phase.completion?.reason ?? resultSummary ?? `${phase.id} requires intervention.`]
      : [])
  ];
}

function phaseNextActions(state: SequentialWorkflowState, phase: WorkflowPhase, integrated: boolean, conflicted: boolean): string[] {
  if (conflicted) return ["repair-integration-conflict", "view-details", "cancel-workflow"];
  if (state.approval?.pendingDecision?.phaseId === phase.id) return [...state.approval.pendingDecision.allowedActions];
  if (phase.status === "completed" && !integrated) return ["integrate-phase"];
  if (["needs_repair", "needs_review", "needs_replan", "blocked"].includes(phase.status)) return ["view-details", "retry-execution", "revise-plan", "cancel-workflow"];
  if (["running", "completion_pending"].includes(phase.status)) return ["execution-poll"];
  return ["execute-next", "view-details", "cancel-workflow"];
}

function phaseLabel(phaseId?: string): string {
  if (!phaseId) return "phase";
  const suffix = phaseId.match(/^phase-(.+)$/i)?.[1];
  return suffix ? `Phase ${suffix.charAt(0).toUpperCase()}${suffix.slice(1)}` : phaseId;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
