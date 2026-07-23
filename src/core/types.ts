export type WorkflowMode = "fast" | "standard" | "rigorous";
export type Complexity = "low" | "medium" | "high";
export type RiskLevel = "none" | "low" | "medium" | "high";
export type TaskStatus = "pending" | "ready" | "active" | "completed" | "failed" | "blocked";
export type ValidationLevel = 0 | 1 | 2 | 3;
export type ModelProfile = "small" | "medium" | "large" | "inherit";
export type ReviewLevel = "sanity" | "integrated" | "deep" | "specialist";
export type TestLevel = "none" | "sanity" | "targeted" | "package" | "full";
export type ParallelismRecommendation = "sequential" | "candidate";
export type CriterionStatus = "met" | "not_met" | "uncertain" | "not_applicable";
export type CompletionGateDecision = "completed" | "needs_repair" | "needs_review" | "needs_replan" | "blocked";
export type PhaseStatus =
  | "planned"
  | "ready"
  | "leased"
  | "running"
  | "completion_pending"
  | "completed"
  | "needs_repair"
  | "needs_review"
  | "needs_replan"
  | "blocked"
  | "cancelled";
export type WorkflowLockOwnerType = "cli" | "claude-session" | "agent" | "system";
export type WorkflowLifecycleState =
  | "created"
  | "triaging"
  | "awaiting_clarification"
  | "awaiting_approach_approval"
  | "planning"
  | "awaiting_plan_approval"
  | "executing"
  | "validating"
  | "reviewing"
  | "awaiting_commit_approval"
  | "completed"
  | "blocked"
  | "cancelled";

export interface TriageOutput {
  version: 1;
  task: {
    type: "bug" | "feature" | "refactor" | "investigation" | "maintenance" | "documentation" | "unknown";
    summary: string;
  };
  assessment: {
    complexity: Complexity;
    ambiguity: Exclude<RiskLevel, "none">;
    blastRadius: Exclude<RiskLevel, "none">;
    architecturalImpact: Exclude<RiskLevel, "none">;
    securityRisk: RiskLevel;
    dataIntegrityRisk: RiskLevel;
    operationalRisk: RiskLevel;
  };
  workflow: {
    modelRecommendation: WorkflowMode;
    finalMode: WorkflowMode;
    confidence: number;
    parallelism: ParallelismRecommendation;
    reviewLevel: ReviewLevel;
    testLevel: TestLevel;
    overridden: boolean;
    overrideReason: string | null;
  };
  clarification: {
    required: boolean;
    question: string | null;
    reason: string | null;
  };
  inspection: {
    required: boolean;
    targets: string[];
  };
  escalationReasons: string[];
  assumptions: string[];
  constraints: {
    mustNot: string[];
  };
}

/** @deprecated Prefer TriageOutput. Kept as an alias for early integrations. */
export type TaskAssessment = TriageOutput;

export interface ReflectionRecord {
  trigger: "preflight" | "scope-expansion" | "architecture-change" | "failed-repair" | "integration-conflict" | "manual";
  finding: string;
  previousMode: WorkflowMode;
  recommendedMode: WorkflowMode;
  planChangeRequired: boolean;
  timestamp: string;
}

export interface ExecutionTask {
  id: string;
  objective: string;
  reads: string[];
  writes: string[];
  dependsOn: string[];
  validation: string[];
  status: TaskStatus;
  assignedAgent?: string;
}

export interface ExecutionGraph {
  version: 1;
  tasks: ExecutionTask[];
}

export interface ValidationResult {
  taskId?: string;
  command: string;
  level: ValidationLevel;
  status: "passed" | "failed" | "skipped";
  output?: string;
  timestamp: string;
}

export interface WorkflowState {
  version: 1;
  request: string;
  mode: WorkflowMode;
  assessment?: TriageOutput;
  triageRun?: {
    source: "model" | "deterministic-fallback";
    provider: string;
    model?: string;
    attempts: number;
    warnings: string[];
  };
  graph?: ExecutionGraph;
  reflections?: ReflectionRecord[];
  currentPhase:
    | "intake"
    | "inspection"
    | "clarification"
    | "planning"
    | "approval"
    | "execution"
    | "integration"
    | "validation"
    | "review"
    | "commit-preparation"
    | "completed";
  decisions: Array<{ question: string; answer: string; timestamp: string }>;
  updatedAt: string;
}

export interface ApproachRecommendation {
  required: boolean;
  approved: boolean;
  proposed: string;
  preferredBecause: string;
  alternatives: string[];
  primaryRisks: string[];
  validationStrategy: string[];
  rejectedReason?: string;
}

export interface WorkflowPhase {
  id: string;
  objective: string;
  rationale: string;
  dependencies: string[];
  dependsOn: string[];
  expectedReadAreas: string[];
  expectedWriteAreas: string[];
  expectedFilesOrAreas: string[];
  acceptanceCriteria: string[];
  validationCommands: string[];
  riskLevel: RiskLevel;
  modelTier: ModelProfile;
  status: PhaseStatus;
  ownershipUncertain?: boolean;
  startedAt?: string;
  completedAt?: string;
  filesChanged: string[];
  commandsRun: string[];
  validationResults: ValidationEvidence[];
  scopeDeviations: string[];
  completion?: PhaseCompletionRecord;
  repairAttempts: PhaseRepairAttempt[];
}

export interface ExecutionPlan {
  version: 1;
  summary: string;
  principles: string[];
  phases: WorkflowPhase[];
  approvedAt?: string;
  revisionRequests: Array<{ feedback: string; timestamp: string }>;
}

export interface ValidationEvidence {
  phaseId?: string;
  command: string;
  exitStatus: number | null;
  result: string;
  status: "passed" | "failed" | "skipped";
  skipped: boolean;
  skippedReason?: string;
  timestamp: string;
}

export interface CriterionCompletionEvidence {
  criterion: string;
  status: CriterionStatus;
  evidence: string[];
}

export interface PhaseRepairAttempt {
  attempt: number;
  reason: string;
  requestedScope: string;
  validation: ValidationEvidence[];
  outcome?: CompletionGateDecision;
  timestamp: string;
}

export interface PhaseCompletionRecord {
  phaseId: string;
  objective: string;
  criteria: CriterionCompletionEvidence[];
  filesChanged: string[];
  validation: {
    status: "passed" | "failed" | "skipped" | "missing";
    commands: ValidationEvidence[];
    skipped: Array<{ command: string; reason: string }>;
  };
  scopeDeviations: string[];
  assumptions: string[];
  remainingRisks: string[];
  dependentPhasesMayProceed: boolean;
  decision: CompletionGateDecision;
  reason: string;
  repairAttempt: number;
  timestamp: string;
  workflowRevision: number;
  leaseOwnerId?: string;
}

export interface IntegratedReviewResult {
  status: "passed" | "needs_repair" | "needs_replan" | "blocked";
  summary: string;
  findings: string[];
  repairScope?: string;
  reviewedAt: string;
}

export interface CommitPlanGroup {
  message: string;
  files: string[];
  rationale: string;
  commands: string[];
}

export interface CommitPlan {
  generatedAt: string;
  groups: CommitPlanGroup[];
  note: string;
}

export interface WorkflowLock {
  workflowId: string;
  ownerId: string;
  ownerType: WorkflowLockOwnerType;
  operation: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  processId?: number;
  host?: string;
}

export interface PhaseLease {
  phaseId: string;
  ownerId: string;
  ownerType: WorkflowLockOwnerType;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  workflowRevisionAtAcquire: number;
  allowedWriteAreas: string[];
  releasedAt?: string;
}

export interface WorkflowEvent {
  eventId: string;
  timestamp: string;
  actorId: string;
  type: string;
  workflowRevisionBefore: number;
  workflowRevisionAfter: number;
  phaseId?: string;
  summary: string;
}

export interface SequentialWorkflowState {
  version: 2;
  id: string;
  revision: number;
  state: WorkflowLifecycleState;
  request: string;
  root: string;
  mode: WorkflowMode;
  createdAt: string;
  updatedAt: string;
  triage?: TriageOutput;
  triageRun?: {
    source: "model" | "deterministic-fallback";
    provider: string;
    model?: string;
    attempts: number;
    warnings: string[];
  };
  clarification?: {
    question: string;
    reason: string;
    answer?: string;
    answeredAt?: string;
  };
  approach?: ApproachRecommendation;
  plan?: ExecutionPlan;
  validation: ValidationEvidence[];
  review?: IntegratedReviewResult;
  commitPlan?: CommitPlan;
  phaseLeases: Record<string, PhaseLease>;
  repairAttempts: number;
  blockers: string[];
  events: WorkflowEvent[];
}
