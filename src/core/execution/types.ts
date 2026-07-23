import type { CriterionCompletionEvidence, ModelProfile, PhaseExecutionRecordStatus, ValidationEvidence, WorkflowMode } from "../types.js";

export type ExecutionStatusState = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out" | "blocked" | "unknown";
export type ExecutionNextAction =
  | "dispatch"
  | "poll"
  | "await_user"
  | "repair"
  | "review"
  | "replan"
  | "resolve_conflict"
  | "validate_integration"
  | "final_review"
  | "commit_proposal"
  | "complete";

export interface ExecutionCapabilities {
  parallel: boolean;
  cancellation: boolean;
  heartbeats: boolean;
  maxConcurrent?: number;
  structuredResults: boolean;
  diagnostics: string[];
}

export interface PhaseExecutionInput {
  workflowId: string;
  workflowRevision: number;
  phaseId: string;
  objective: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  selectedMode: WorkflowMode;
  modelTier: ModelProfile;
  workspacePath: string;
  repositoryRoot: string;
  allowedReadAreas: string[];
  allowedWriteAreas: string[];
  methodologyReferences: string[];
  validationExpectations: string[];
  leaseOwnerId: string;
  timeoutSeconds: number;
  userRequest: string;
  planContext: string;
  safetyInstructions: string[];
}

export interface ExecutionHandle {
  providerId: string;
  providerExecutionId: string;
  workflowId: string;
  phaseId: string;
  leaseOwnerId: string;
  workspacePath: string;
  startedAt: string;
  lastKnownStatus: PhaseExecutionRecordStatus;
  providerMetadata?: Record<string, unknown>;
  nativeSessionId?: string;
}

export interface ExecutionStatus {
  status: ExecutionStatusState;
  heartbeatAt?: string;
  message?: string;
  diagnostics?: Record<string, unknown>;
}

export interface ExecutionValidationResult {
  command: string;
  exitCode?: number | null;
  status?: "passed" | "failed" | "skipped";
  result?: string;
  skipped?: boolean;
  skippedReason?: string;
  timestamp?: string;
}

export interface ScopeDeviation {
  path?: string;
  reason: string;
}

export type PhaseExecutionResult = {
  status: "completed" | "failed" | "cancelled" | "timed_out" | "blocked";
  summary: string;
  changedFiles: string[];
  validation: ExecutionValidationResult[];
  criterionEvidence: CriterionCompletionEvidence[];
  assumptions: string[];
  scopeDeviations: ScopeDeviation[];
  remainingRisks: string[];
  providerDiagnostics?: Record<string, unknown>;
};

export interface DispatchSummary {
  phaseId: string;
  provider: string;
  status: PhaseExecutionRecordStatus;
  workspacePath: string;
  leaseOwnerId: string;
}

export interface CoordinatorPhaseSummary {
  phaseId: string;
  provider: string;
  status: PhaseExecutionRecordStatus;
}

export interface CoordinatorResult {
  workflowId: string;
  revision: number;
  state: string;
  running: CoordinatorPhaseSummary[];
  completed: CoordinatorPhaseSummary[];
  blocked: Array<{ phaseId: string; reason: string }>;
  dispatched: DispatchSummary[];
  nextAction: ExecutionNextAction;
  message: string;
}

export function toValidationEvidence(phaseId: string, entry: ExecutionValidationResult): ValidationEvidence {
  const skipped = Boolean(entry.skipped || entry.status === "skipped");
  const exitStatus = skipped ? null : entry.exitCode ?? (entry.status === "failed" ? 1 : 0);
  return {
    phaseId,
    command: entry.command,
    exitStatus,
    result: entry.result ?? (skipped ? "Validation skipped." : "Validation command recorded."),
    status: skipped ? "skipped" : exitStatus === 0 ? "passed" : "failed",
    skipped,
    skippedReason: entry.skippedReason,
    timestamp: entry.timestamp ?? new Date().toISOString()
  };
}

