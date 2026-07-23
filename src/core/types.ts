export type WorkflowMode = "fast" | "standard" | "rigorous";
export type Complexity = "low" | "medium" | "high";
export type RiskLevel = "none" | "low" | "medium" | "high";
export type TaskStatus = "pending" | "ready" | "active" | "completed" | "failed" | "blocked";
export type ValidationLevel = 0 | 1 | 2 | 3;
export type ModelProfile = "small" | "medium" | "large" | "inherit";
export type ReviewLevel = "sanity" | "integrated" | "deep" | "specialist";
export type TestLevel = "none" | "sanity" | "targeted" | "package" | "full";
export type ParallelismRecommendation = "sequential" | "candidate";

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
