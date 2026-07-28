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
  workspaceIdentity?: string;
  command?: string;
  riskSummary?: string[];
  question: string;
  allowedActions: string[];
  source?: WorkflowDecisionSource;
}

export function setPendingDecision(state: SequentialWorkflowState, input: PendingDecisionInput): WorkflowPendingDecision {
  ensureApprovalState(state);
  const previous = state.approval!.pendingDecision;
  if (previous) resolvePendingDecision(state, "superseded", undefined, "system", previous.id);
  const decision = {
    id: `decision-${randomUUID()}`,
    type: input.type,
    workflowRevision: input.workflowRevision ?? state.revision + 1,
    stateRevision: input.stateRevision ?? state.revision + 1,
    phaseId: input.phaseId,
    briefRevision: input.briefRevision,
    preparationRevision: input.preparationRevision,
    integrationRevision: input.integrationRevision,
    workspaceIdentity: input.workspaceIdentity,
    command: input.command,
    riskSummary: input.riskSummary,
    question: input.question,
    status: "pending",
    allowedActions: [...input.allowedActions],
    createdAt: new Date().toISOString(),
    source: input.source ?? "system",
    supersedesDecisionId: previous?.id
  } as WorkflowPendingDecision;
  state.approval!.pendingDecision = decision;
  return decision;
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
    question: typeof decision.question === "string" && decision.question.length > 0
      ? decision.question
      : legacyQuestion(decision.type),
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
