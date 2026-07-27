import type { CriterionCompletionEvidence, ModelProfile, PhaseExecutionRecordStatus, ValidationEvidence, WorkflowMode, WorkspacePreparation } from "../types.js";

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
  sessions?: {
    persistent: boolean;
    resume: boolean;
    fork?: boolean;
  };
  diagnostics: string[];
}

export type ProviderSessionStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "unavailable";

export interface ProviderSessionRef {
  providerId: string;
  sessionId: string;
  workflowId: string;
  phaseId: string;
  executionAttemptId: string;
  workingDirectory: string;
  createdAt: string;
  updatedAt: string;
  status: ProviderSessionStatus;
  requestedTier?: ModelProfile;
  resolvedModel?: string;
  providerVersion?: string;
  safeCliArgs?: string[];
  resumePermitted: boolean;
  resumedFromSessionId?: string;
  replacementReason?: string;
}

export interface PhaseWorkspaceCheckpoint {
  capturedAt: string;
  workspacePath: string;
  dirty: boolean;
  trackedModified: string[];
  untrackedFiles: string[];
  deletedFiles: string[];
  changedFiles: string[];
  diffSummary: {
    text: string;
    bytes: number;
    truncated: boolean;
  };
  validationCommands: string[];
  validationResults: Array<{
    command: string;
    status?: string;
    exitCode?: number | null;
    result?: string;
  }>;
  note: string;
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
  approvedConstraints: string[];
  safetyInstructions: string[];
  previousCheckpoint?: PhaseWorkspaceCheckpoint;
  workspacePreparation?: WorkspacePreparation;
  resume?: {
    providerSession?: ProviderSessionRef;
    failureReason: string;
    attempt: number;
    mode: "same-session" | "compact-retry";
  };
  codeIntelligence?: {
    codegraph: "exact-worktree" | "root-advisory" | "unavailable";
    note?: string;
  };
  workerControls?: {
    maxDiscoveryTurns: number;
    reservedValidationTurns: number;
    reservedFinalResultTurns: number;
    repeatedReadWarningThreshold: number;
    largeToolOutputBytes: number;
  };
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
  providerSession?: ProviderSessionRef;
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

export interface ProviderSessionSummary {
  phaseId: string;
  provider: string;
  providerExecutionId: string;
  sessionId: string;
  workingDirectory: string;
  status: ProviderSessionStatus;
  resumePermitted: boolean;
  resolvedModel?: string;
}

export interface CoordinatorResult {
  workflowId: string;
  revision: number;
  state: string;
  executionMode?: "coordinator" | "manual";
  provider?: string;
  providerFallbackReason?: string;
  runningPhase?: string;
  lastProviderStatus?: string;
  phaseGateStatus?: string;
  integrationStatus?: string;
  combinedValidationStatus?: string;
  pendingUserGate?: string | null;
  nextValidAction?: ExecutionNextAction;
  running: CoordinatorPhaseSummary[];
  completed: CoordinatorPhaseSummary[];
  providerSessions?: ProviderSessionSummary[];
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
