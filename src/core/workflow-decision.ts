import { createHash, randomUUID } from "node:crypto";
import type {
  SequentialWorkflowState,
  WorkflowDecisionSource,
  WorkflowDecisionStatus,
  WorkflowDecisionType,
  WorkflowPendingDecision
} from "./types.js";

export interface PendingDecisionInput {
  type: WorkflowDecisionType;
  workflowRevision?: number;
  stateRevision?: number;
  phaseId?: string;
  briefRevision?: number;
  preparationRevision?: number;
  integrationRevision?: number;
  additionalTurns?: number;
  selectorPreview?: string;
  workspaceIdentity?: string;
  command?: string;
  riskSummary?: string[];
  question: string;
  allowedActions: string[];
  source?: WorkflowDecisionSource;
}

type DecisionQuestion = Pick<PendingDecisionInput, "type" | "phaseId" | "briefRevision" | "selectorPreview" | "question">;

const MAX_SELECTOR_PREVIEW_LENGTH = 720;

/**
 * AskUserQuestion is the only reliable visible surface at mandatory decision
 * gates. Keep the action prompt compact, with an optional bounded plain-text
 * preview that is safe to render in the selector itself.
 */
export function selectorQuestionForDecision(decision: DecisionQuestion): string {
  const phase = decision.phaseId ? ` for ${decision.phaseId}` : "";
  const action = (() => {
    switch (decision.type) {
    case "clarification":
      return compactClarificationQuestion(decision.question);
    case "approach-approval":
      return "Approve the workflow strategy before Workflow Plan generation?";
    case "workflow-plan-approval":
      return "Approve the Workflow Plan and its execution policy?";
    case "planning-fallback-review":
      return "Choose how to proceed with workflow planning?";
    case "phase-brief-approval":
      return `Review and approve ${decision.phaseId ?? "the current phase"} Execution Brief${decision.briefRevision === undefined ? "" : ` revision ${decision.briefRevision}`}?`;
    case "workspace-bootstrap-approval":
      return `Approve workspace preparation${phase}?`;
    case "material-drift-review":
      return `Review material drift${phase}?`;
    case "execution-recovery":
      return `Choose a recovery action${phase}?`;
    case "integration-conflict":
      return `Resolve the integration conflict${phase}?`;
    case "final-review":
      return "Record the final integrated review?";
    case "final-completion":
      return "Complete the workflow?";
    default:
      return "Choose the next persisted workflow action.";
    }
  })();
  const preview = compactSelectorPreview(decision.selectorPreview);
  return preview ? `${preview}\n\n${action}` : action;
}

export function setPendingDecision(state: SequentialWorkflowState, input: PendingDecisionInput): WorkflowPendingDecision {
  ensureApprovalState(state);
  const previous = state.approval!.pendingDecision;
  if (previous) resolvePendingDecision(state, "superseded", undefined, "system", previous.id);
  const selectorPreview = compactSelectorPreview(input.selectorPreview ?? selectorPreviewForDecision(state, input));
  const decision = {
    id: `decision-${randomUUID()}`,
    type: input.type,
    workflowRevision: input.workflowRevision ?? state.revision + 1,
    stateRevision: input.stateRevision ?? state.revision + 1,
    phaseId: input.phaseId,
    briefRevision: input.briefRevision,
    preparationRevision: input.preparationRevision,
    integrationRevision: input.integrationRevision,
    additionalTurns: input.additionalTurns,
    selectorPreview,
    workspaceIdentity: input.workspaceIdentity,
    command: input.command,
    riskSummary: input.riskSummary,
    question: selectorQuestionForDecision({ ...input, selectorPreview }),
    status: "pending",
    allowedActions: [...input.allowedActions],
    createdAt: new Date().toISOString(),
    source: input.source ?? "system",
    supersedesDecisionId: previous?.id
  } as WorkflowPendingDecision;
  state.approval!.pendingDecision = decision;
  return decision;
}

/**
 * Build the bounded plain-text context that must remain visible when a host
 * presents a mandatory decision through a native selector without rendering
 * the richer Markdown presentation first. Callers may provide a more specific
 * persisted preview, but every decision type has a safe state-derived default.
 */
export function selectorPreviewForDecision(state: SequentialWorkflowState, input: PendingDecisionInput): string | undefined {
  const phaseId = input.phaseId;
  const brief = phaseId ? state.phaseBriefs?.[phaseId] : undefined;
  const phase = phaseId ? state.plan?.phases.find((candidate) => candidate.id === phaseId) : undefined;
  const planning = state.planningRun;
  const planningProvenance = provenanceLine("Planning", planning?.provider, planning?.model, planning?.source, planning?.attempts);
  const briefProvenance = provenanceLine("Brief", brief?.generation.provider, brief?.generation.modelTier, undefined, undefined);

  switch (input.type) {
    case "clarification":
      return preview([
        "Clarification",
        field("Question", state.clarification?.question ?? input.question, 260),
        field("Why", state.clarification?.reason, 180)
      ]);
    case "approach-approval":
      return preview([
        "Workflow strategy",
        field("Mode", selectorModeLabel(state.mode)),
        field("Approach", state.approach?.proposed ?? state.triage?.task.summary, 200),
        field("Why", state.approach?.preferredBecause, 160),
        listField("Key risks", state.approach?.primaryRisks, 2, 150),
        listField("Key constraints", state.constraints?.effective.map((constraint) => constraint.text) ?? state.triage?.constraints.mustNot, 2, 150),
        provenanceLine("Triage", state.triageRun?.provider, state.triageRun?.model, state.triageRun?.source, state.triageRun?.attempts)
      ]);
    case "workflow-plan-approval":
      return preview([
        "Workflow Plan",
        field("Mode", selectorModeLabel(state.mode)),
        field("Summary", state.plan?.summary, 220),
        planPhases(state),
        field("Approval policy", state.mode === "rigorous" ? "Phase-by-phase review is required." : "Approve the plan policy before execution."),
        planningProvenance
      ]);
    case "planning-fallback-review":
      return preview([
        "Planning recovery",
        field("Reason", planning?.approvalBlockedReason ?? input.question, 300),
        planningProvenance,
        listField("Diagnostics", planning?.diagnostics?.map((diagnostic) => diagnostic.message), 2, 140)
      ]);
    case "phase-brief-approval":
      return preview([
        "Phase Execution Brief",
        field("Phase", phaseId),
        field("Objective", brief?.objective ?? phase?.objective, 190),
        field("Deliverable", brief?.deliverable, 160),
        listField("Write areas", brief?.writeAreas ?? phase?.expectedWriteAreas, 2, 120),
        listField("Validation", brief?.validationCommands ?? phase?.validationCommands, 2, 120),
        listField("Key risks", brief?.risks, 2, 120),
        briefProvenance
      ]);
    case "workspace-bootstrap-approval":
      return preview([
        "Workspace preparation",
        field("Phase", phaseId),
        field("Command", input.command, 200),
        listField("Risks", input.riskSummary, 2, 140),
        field("Workspace identity", input.workspaceIdentity, 120)
      ]);
    case "material-drift-review":
      return preview([
        "Material drift review",
        field("Phase", phaseId),
        field("Change", input.question, 260),
        listField("Proposed changes", brief?.materialChangesFromWorkflowPlan.map((change) => change.reason), 2, 150),
        field("Brief revision", input.briefRevision === undefined ? undefined : String(input.briefRevision))
      ]);
    case "execution-recovery":
      return preview([
        "Execution recovery",
        field("Phase", phaseId),
        field("Reason", input.question, 300),
        field("Provider result", phaseId ? state.execution.records[phaseId]?.resultSummary : undefined, 180),
        field("Additional turns", input.additionalTurns === undefined ? undefined : String(input.additionalTurns))
      ]);
    case "integration-conflict":
      return preview([
        "Integration conflict",
        field("Phase", phaseId),
        field("Conflict", input.question, 260),
        field("Integration validation", state.git?.integrationValidation?.status),
        listField("Write areas", brief?.writeAreas ?? phase?.expectedWriteAreas, 2, 120)
      ]);
    case "final-review":
      return preview([
        "Final integrated review",
        field("Integration validation", state.git?.integrationValidation?.status ?? validationStatus(state)),
        listField("Validation", state.validation.map((entry) => `${entry.command}: ${entry.status}`), 2, 140),
        field("Completed phases", state.plan ? `${state.plan.phases.filter((candidate) => candidate.status === "completed").length}/${state.plan.phases.length}` : undefined),
        listField("Blockers", state.blockers, 2, 140)
      ]);
    case "final-completion":
      return preview([
        "Workflow completion",
        field("Final review", state.review ? `${state.review.status}: ${state.review.summary}` : undefined, 220),
        field("Integration validation", state.git?.integrationValidation?.status ?? validationStatus(state)),
        field("Commit plan", state.commitPlan ? `${state.commitPlan.groups.length} proposed commit group(s)` : "No commit is executed by this approval."),
        listField("Commit messages", state.commitPlan?.groups.map((group) => group.message), 2, 120)
      ]);
    default:
      return undefined;
  }
}

export function resolvePendingDecision(
  state: SequentialWorkflowState,
  status: Exclude<WorkflowDecisionStatus, "pending">,
  selectedAction?: string,
  source: WorkflowDecisionSource = "system",
  decisionId?: string
): WorkflowPendingDecision | undefined {
  ensureApprovalState(state);
  const current = state.approval!.pendingDecision;
  if (!current) {
    if (decisionId && state.approval!.decisionHistory.some((decision) => decision.id === decisionId)) {
      throw new Error(`Decision ${decisionId} was already resolved and cannot be answered again.`);
    }
    if (decisionId) throw new Error(`Decision ${decisionId} is not the current pending workflow decision.`);
    return undefined;
  }
  if (decisionId && current.id !== decisionId) {
    const resolved = state.approval!.decisionHistory.some((decision) => decision.id === decisionId);
    throw new Error(resolved
      ? `Decision ${decisionId} was already resolved and cannot be answered again.`
      : `Decision ${decisionId} is stale; the current decision is ${current.id}.`);
  }
  if (selectedAction && !(current.allowedActions as string[]).includes(selectedAction)) {
    throw new Error(`Action ${selectedAction} is not allowed for decision ${current.id}.`);
  }
  const resolved = {
    ...current,
    status,
    resolvedAt: new Date().toISOString(),
    selectedAction,
    source
  } as WorkflowPendingDecision;
  state.approval!.decisionHistory.push(resolved);
  state.approval!.pendingDecision = undefined;
  return resolved;
}

export function requirePendingDecision(
  state: SequentialWorkflowState,
  type: WorkflowDecisionType,
  action: string,
  decisionId?: string
): WorkflowPendingDecision | undefined {
  const current = state.approval?.pendingDecision;
  if (!current) {
    if (decisionId) return resolvePendingDecision(state, "rejected", action, "controller", decisionId);
    return undefined;
  }
  if (current.type !== type) {
    throw new Error(`Decision ${current.id} is ${current.type}, not ${type}. Refresh the workflow before answering.`);
  }
  if (decisionId && current.id !== decisionId) {
    return resolvePendingDecision(state, "rejected", action, "controller", decisionId);
  }
  if (!(current.allowedActions as string[]).includes(action)) {
    throw new Error(`Action ${action} is not allowed for decision ${current.id}.`);
  }
  return current;
}

export function migrateWorkflowDecision(raw: unknown, index: number): unknown {
  const decision = { ...(raw as Record<string, unknown>) };
  const createdAt = typeof decision.createdAt === "string" ? decision.createdAt : new Date(0).toISOString();
  const id = typeof decision.id === "string" && decision.id.length > 0
    ? decision.id
    : `decision-migrated-${createHash("sha256").update(JSON.stringify(decision)).digest("hex").slice(0, 16)}-${index}`;
  return {
    ...decision,
    id,
    stateRevision: typeof decision.stateRevision === "number" ? decision.stateRevision : decision.workflowRevision ?? 0,
    selectorPreview: compactSelectorPreview(typeof decision.selectorPreview === "string" ? decision.selectorPreview : undefined),
    question: selectorQuestionForDecision({
      type: decision.type as WorkflowDecisionType,
      phaseId: typeof decision.phaseId === "string" ? decision.phaseId : undefined,
      briefRevision: typeof decision.briefRevision === "number" ? decision.briefRevision : undefined,
      selectorPreview: typeof decision.selectorPreview === "string" ? decision.selectorPreview : undefined,
      question: typeof decision.question === "string" ? decision.question : legacyQuestion(decision.type)
    }),
    createdAt,
    source: typeof decision.source === "string" ? decision.source : "legacy-migration"
  };
}

function ensureApprovalState(state: SequentialWorkflowState): void {
  state.approval ??= { history: [], decisionHistory: [] };
  state.approval.history ??= [];
  state.approval.decisionHistory ??= [];
}

function legacyQuestion(type: unknown): string {
  if (type === "phase-brief-approval") return "Approve the current Phase Execution Brief revision?";
  if (type === "workspace-bootstrap-approval") return "Approve the persisted workspace bootstrap request?";
  return "Choose the next persisted workflow action.";
}

function compactClarificationQuestion(question: string): string {
  const singleLine = question.replace(/\s+/g, " ").trim();
  if (!singleLine) return "Answer the persisted clarification question.";
  return singleLine.length <= 240 ? singleLine : `${singleLine.slice(0, 237).trimEnd()}…`;
}

function compactSelectorPreview(preview: string | undefined): string | undefined {
  if (!preview) return undefined;
  const lines = preview
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const compact = lines.join("\n");
  return compact.length <= MAX_SELECTOR_PREVIEW_LENGTH
    ? compact
    : `${compact.slice(0, MAX_SELECTOR_PREVIEW_LENGTH - 1).trimEnd()}…`;
}

function preview(lines: Array<string | undefined>): string | undefined {
  const visible = lines.filter((line): line is string => Boolean(line));
  return visible.length > 0 ? visible.join("\n") : undefined;
}

function field(label: string, value: string | undefined, maximum = 180): string | undefined {
  const text = compactText(value, maximum);
  return text ? `${label}: ${text}` : undefined;
}

function listField(label: string, values: string[] | undefined, count: number, maximum: number): string | undefined {
  const visible = (values ?? [])
    .map((value) => compactText(value, maximum))
    .filter((value): value is string => Boolean(value))
    .slice(0, count);
  if (visible.length === 0) return undefined;
  const omitted = Math.max(0, (values?.length ?? 0) - visible.length);
  return `${label}: ${visible.join("; ")}${omitted > 0 ? `; +${omitted} more` : ""}`;
}

function planPhases(state: SequentialWorkflowState): string | undefined {
  const phases = state.plan?.phases ?? [];
  if (phases.length === 0) return undefined;
  const visible = phases.slice(0, 2).map((phase) => {
    const objective = compactText(phase.objective, 90) ?? phase.id;
    const writes = phase.expectedWriteAreas.slice(0, 2).join(", ");
    return `${phase.id}: ${objective}${writes ? ` [${writes}]` : ""}`;
  });
  return `Phases: ${visible.join("; ")}${phases.length > visible.length ? `; +${phases.length - visible.length} more` : ""}`;
}

function provenanceLine(label: string, provider?: string, model?: string, source?: string, attempts?: number): string | undefined {
  const values = [provider, model, source, attempts === undefined ? undefined : `${attempts} attempt${attempts === 1 ? "" : "s"}`].filter(Boolean);
  return values.length > 0 ? `${label}: ${values.join(" / ")}` : undefined;
}

function validationStatus(state: SequentialWorkflowState): string | undefined {
  if (state.validation.length === 0) return undefined;
  const statuses = [...new Set(state.validation.map((entry) => entry.status))];
  return statuses.join(", ");
}

function compactText(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  const normalised = value.replace(/\s+/g, " ").trim();
  if (!normalised) return undefined;
  return normalised.length <= maximum ? normalised : `${normalised.slice(0, maximum - 1).trimEnd()}…`;
}

function selectorModeLabel(mode: string): string {
  return mode ? `${mode[0]!.toUpperCase()}${mode.slice(1)}` : mode;
}
