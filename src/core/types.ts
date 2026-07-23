export type WorkflowMode = "fast" | "standard" | "rigorous";
export type Complexity = "low" | "medium" | "high";
export type RiskLevel = "none" | "low" | "medium" | "high";
export type TaskStatus = "pending" | "ready" | "active" | "completed" | "failed" | "blocked";
export type ValidationLevel = 0 | 1 | 2 | 3;
export type ModelProfile = "small" | "medium" | "large" | "inherit";
export type ReviewLevel = "sanity" | "integrated" | "deep" | "specialist";
export type TestLevel = "none" | "sanity" | "targeted" | "package" | "full";
export type ParallelismRecommendation = "sequential" | "candidate";
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
  expectedFilesOrAreas: string[];
  acceptanceCriteria: string[];
  validationCommands: string[];
  riskLevel: RiskLevel;
  modelTier: ModelProfile;
  status: "pending" | "active" | "completed" | "blocked";
  startedAt?: string;
  completedAt?: string;
  filesChanged: string[];
  commandsRun: string[];
  validationResults: ValidationEvidence[];
  scopeDeviations: string[];
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
  repairAttempts: number;
  blockers: string[];
  events: Array<{
    state: WorkflowLifecycleState;
    message: string;
    timestamp: string;
  }>;
}
