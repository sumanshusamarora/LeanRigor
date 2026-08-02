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
    selectorPreview: compactSelectorPreview(input.selectorPreview),
    workspaceIdentity: input.workspaceIdentity,
    command: input.command,
    riskSummary: input.riskSummary,
    question: selectorQuestionForDecision(input),
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
