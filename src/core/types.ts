import type { ExecutionTurnBudgetState, PhaseExecutionResult, PhaseWorkspaceCheckpoint, ProviderSessionRef } from "./execution/types.js";

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
export type TriageFactConfidence = "verified" | "inferred" | "unknown";
export type TriageSignalValue = boolean | "unknown";
export type CompletionGateDecision = "completed" | "needs_repair" | "needs_review" | "needs_replan" | "blocked";
export type IntegrationWorkspaceStatus =
  | "not_created"
  | "ready"
  | "integration_pending"
  | "validating"
  | "needs_repair"
  | "needs_review"
  | "ready_for_final_review"
  | "blocked";
export type PhaseWorkspaceStatus =
  | "not_created"
  | "ready"
  | "active"
  | "completion_pending"
  | "approved"
  | "integrated"
  | "needs_repair"
  | "conflicted"
  | "abandoned";
export type IntegrationValidationStatus = "pending" | "running" | "passed" | "failed" | "skipped";
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
export type PhaseExecutionRecordStatus =
  | "dispatching"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "blocked"
  | "collecting"
    | "result_recorded";
export type ConstraintSource = "policy" | "triage" | "user";
export type ConstraintAction = "add" | "remove" | "override";
export type WorkspacePreparationStatus = "available" | "prepared" | "blocked" | "failed";
export type ReferencedWorkItemSource = "github-issue";
export type ReferencedWorkItemContentStatus = "resolved" | "partial" | "unavailable";
export type ClarificationOwnership =
  | "user-intent"
  | "user-policy"
  | "safety-critical"
  | "repository-discoverable"
  | "planning-detail"
  | "already-resolved"
  | "unnecessary";
export type ClarificationDisposition = "accepted" | "inspected" | "deferred" | "suppressed";
export type PhaseApprovalPolicy = "workflow-authorized" | "phase-by-phase";
export type ApprovalSelectionSource = "user" | "deterministic-policy" | "legacy-default";
export type ApprovalRecommendationOption = "approve-all-remaining" | "approve-current-phase";
export type MaterialPlanChangeCategory =
  | "write-boundary"
  | "migration"
  | "compatibility"
  | "public-contract"
  | "security"
  | "concurrency"
  | "recovery"
  | "data-integrity"
  | "production-infrastructure"
  | "destructive-operation"
  | "network-operation"
  | "acceptance-criteria"
  | "validation"
  | "dependency"
  | "ordering"
  | "architecture"
  | "provider"
  | "file-refinement"
  | "symbol-refinement"
  | "read-boundary"
  | "risk";

export interface ApprovalRecommendation {
  option: ApprovalRecommendationOption;
  ruleId: string;
  reasons: string[];
  workflowRevision: number;
  phaseId?: string;
  createdAt: string;
  overridable: boolean;
}

export interface ApprovalHistoryEntry {
  policy: PhaseApprovalPolicy;
  source: ApprovalSelectionSource;
  timestamp: string;
  workflowRevision: number;
  phaseId?: string;
  briefRevision?: number;
  recommendation?: ApprovalRecommendation;
  recommendationOverridden: boolean;
  action: "plan-approved" | "phase-approved" | "policy-changed" | "reapproval-required";
}

export type PhaseApprovalDecisionAction =
  | "approve-phase"
  | "revise-phase-brief"
  | "view-details"
  | "cancel-workflow";

export type WorkflowDecisionStatus = "pending" | "approved" | "answered" | "rejected" | "superseded" | "cancelled";
export type WorkflowDecisionSource = "user" | "controller" | "system" | "legacy-migration";
export type WorkflowDecisionType =
  | "clarification"
  | "approach-approval"
  | "workflow-plan-approval"
  | "planning-fallback-review"
  | "phase-brief-approval"
  | "workspace-bootstrap-approval"
  | "material-drift-review"
  | "execution-recovery"
  | "integration-conflict"
  | "final-review"
  | "final-completion";

export interface WorkflowDecisionBase {
  id: string;
  type: WorkflowDecisionType;
  workflowRevision: number;
  stateRevision: number;
  phaseId?: string;
  briefRevision?: number;
  preparationRevision?: number;
  integrationRevision?: number;
  additionalTurns?: number;
  question: string;
  status: WorkflowDecisionStatus;
  allowedActions: string[];
  createdAt: string;
  resolvedAt?: string;
  selectedAction?: string;
  source: WorkflowDecisionSource;
  supersedesDecisionId?: string;
}

export interface PhaseApprovalDecision extends WorkflowDecisionBase {
  type: "phase-brief-approval";
  phaseId: string;
  briefRevision: number;
  allowedActions: PhaseApprovalDecisionAction[];
}

export type WorkspaceBootstrapDecisionAction =
  | "approve-bootstrap"
  | "retry-preparation"
  | "view-details"
  | "cancel-workflow";

export interface WorkspaceBootstrapDecision extends WorkflowDecisionBase {
  type: "workspace-bootstrap-approval";
  phaseId: string;
  briefRevision: number;
  preparationRevision: number;
  workspaceIdentity: string;
  command: string;
  riskSummary: string[];
  allowedActions: WorkspaceBootstrapDecisionAction[];
}

export interface WorkflowActionDecision extends WorkflowDecisionBase {
  type: Exclude<WorkflowDecisionType, "phase-brief-approval" | "workspace-bootstrap-approval">;
}

export type WorkflowPendingDecision = PhaseApprovalDecision | WorkspaceBootstrapDecision | WorkflowActionDecision;

export interface WorkflowDecisionOption {
  intent: string;
  label: string;
  description: string;
  command?: string;
}

export interface WorkflowDecisionEnvelope {
  workflowId: string;
  workflowRevision: number;
  state: WorkflowLifecycleState;
  status: {
    code: string;
    summary: string;
    phaseId?: string;
    briefRevision?: number;
  };
  decision?: {
    id: string;
    type: WorkflowDecisionType;
    workflowRevision: number;
    phaseId?: string;
    briefRevision?: number;
    preparationRevision?: number;
    integrationRevision?: number;
    additionalTurns?: number;
    question: string;
    options: WorkflowDecisionOption[];
  };
  nextOperation?: {
    type: string;
    automaticallyPermitted: boolean;
  };
}

export interface WorkflowApprovalState {
  policy?: PhaseApprovalPolicy;
  source?: ApprovalSelectionSource;
  selectedAt?: string;
  workflowPlanRevision?: number;
  currentAuthorizedPhase?: string;
  recommendation?: ApprovalRecommendation;
  history: ApprovalHistoryEntry[];
  pendingDecision?: WorkflowPendingDecision;
  decisionHistory: WorkflowPendingDecision[];
}

export interface MaterialPlanChange {
  category: MaterialPlanChangeCategory;
  previousValue?: string | string[];
  proposedValue?: string | string[];
  affectedPhase: string;
  severity: "informational" | "medium" | "high";
  material: boolean;
  reason: string;
  requiredTransition: "none" | "reapprove-plan" | "revise-plan" | "revise-phase-brief";
}

export type PhaseBriefRiskCategory =
  | "security"
  | "public-contract"
  | "migration"
  | "architecture"
  | "data-integrity"
  | "concurrency"
  | "recovery"
  | "production-infrastructure"
  | "destructive-operation"
  | "network-operation";

export interface PhaseBriefRiskDiscovery {
  risk: string;
  categories: PhaseBriefRiskCategory[];
  evidence: string[];
  source: "inspection";
}

export interface PhaseBriefInspectionQuestion {
  id: string;
  question: string;
  reason: string;
}

export interface PhaseBriefScopeExpansion {
  path: string;
  reason: string;
  sourcePath?: string;
  readOnly: true;
}

export interface PhaseBriefInspectionRequest {
  workflowId: string;
  phaseId: string;
  workflowRevision: number;
  questions: PhaseBriefInspectionQuestion[];
  allowedPaths: string[];
  scopeExpansions: PhaseBriefScopeExpansion[];
  maxReads: number;
  maxBytes: number;
  timeoutSeconds: number;
}

export interface PhaseBriefInspectionFinding {
  questionId: string;
  question: string;
  answer: string;
  evidence: string[];
}

export interface PhaseBriefInspectionResult {
  status: "completed" | "partial" | "unavailable" | "failed";
  findings: PhaseBriefInspectionFinding[];
  filesRead: string[];
  bytesRead: number;
  unresolvedQuestions: string[];
  warnings: string[];
  relevantFiles: string[];
  relevantSymbols: string[];
  validationCommands: string[];
  completedAt: string;
  provenance: {
    source: string;
    provider?: string;
    modelTier?: ModelProfile;
  };
}

export interface PhaseBriefDiagnostic {
  stage: "inspection" | "generation" | "quality";
  field: string;
  code: string;
  message: string;
  repairAttempt: "none" | "same-provider";
  resolution: "unresolved" | "repaired";
}

export type ArtifactQualityDimension =
  | "completeness"
  | "specificity"
  | "traceability"
  | "phase-closure"
  | "dependency-validity"
  | "evidence-coverage"
  | "recovery-viability"
  | "internal-consistency";

export interface ArtifactQualityDimensionResult {
  status: "pass" | "warning" | "fail";
  diagnosticCodes: string[];
  evidence: string[];
}

export interface ArtifactQualityResult {
  artifactType: "triage" | "workflow-plan" | "phase-brief" | "provider-result" | "completion-gate" | "integration" | "final-summary";
  artifactId: string;
  overall: "pass" | "warning" | "fail";
  dimensions: Record<ArtifactQualityDimension, ArtifactQualityDimensionResult>;
  evaluatedAt: string;
}

export type FailureOwnership =
  | "leanrigor_generation_failure"
  | "repository_evidence_insufficient"
  | "provider_failure"
  | "user_decision_required"
  | "policy_block"
  | "environment_failure"
  | "implementation_failure"
  | "validation_failure"
  | "integration_failure";

export type ArtifactRecoveryStrategy =
  | "initial-generation"
  | "targeted-repair"
  | "refreshed-inspection"
  | "alternate-strategy"
  | "deterministic-fallback";

export interface ArtifactRecoveryAttempt {
  attempt: number;
  strategy: ArtifactRecoveryStrategy;
  provider: string;
  modelTier: ModelProfile;
  inputArtifactHash: string;
  outputArtifactHash?: string;
  inspectionIdentity?: string;
  validationDiagnostics: string[];
  changed: boolean;
  disposition: "continue" | "succeeded" | "failed" | "skipped-identical";
  timestamp: string;
}

export interface PhaseBriefValidation {
  status: "valid" | "blocked";
  diagnostics: PhaseBriefDiagnostic[];
  repairAttempts: number;
  validatedAt: string;
}

export interface PhaseBriefRepositoryProvenance {
  baseCommit?: string;
  repositoryRevision: string;
  constraintHash: string;
  inspectionResultId: string;
  inspectedPaths: string[];
  planFingerprint?: string;
  dependencyFingerprint?: string;
  priorPhaseOutcomesHash?: string;
  executionPolicyHash?: string;
}

export interface PhaseBriefGenerationProvenance {
  source: "deterministic" | "provider";
  provider: string;
  modelTier: ModelProfile;
  warnings: string[];
}

export interface PhaseBriefRevisionRequest {
  feedback: string;
  timestamp: string;
}

export interface PhaseBriefGenerationFailure {
  phaseId: string;
  workflowRevision: number;
  briefRevision: number;
  status: "inspection-unavailable" | "inspection-failed" | "quality-blocked";
  message: string;
  diagnostics: PhaseBriefDiagnostic[];
  inspectionRequest: PhaseBriefInspectionRequest;
  inspectionResult?: PhaseBriefInspectionResult;
  repairAttempts: number;
  provider: string;
  modelTier: ModelProfile;
  failureOwnership?: FailureOwnership;
  recoveryAttempts?: ArtifactRecoveryAttempt[];
  quality?: ArtifactQualityResult;
  failedAt: string;
}

export interface PhaseExecutionBrief {
  phaseId: string;
  workflowRevision: number;
  briefRevision: number;
  generatedAt: string;
  objective: string;
  deliverable: string;
  currentBehaviour?: string;
  implementationApproach: string;
  readAreas: string[];
  writeAreas: string[];
  relevantFiles: string[];
  relevantSymbols: string[];
  dependencies: string[];
  assumptions: string[];
  exclusions: string[];
  acceptanceCriteria: string[];
  testObligations: string[];
  validationCommands: string[];
  risks: string[];
  riskDiscoveries?: PhaseBriefRiskDiscovery[];
  provider?: string;
  modelTier?: ModelProfile;
  inspectionRequest: PhaseBriefInspectionRequest;
  inspectionResult: PhaseBriefInspectionResult;
  repository: PhaseBriefRepositoryProvenance;
  generation: PhaseBriefGenerationProvenance;
  validation: PhaseBriefValidation;
  quality?: ArtifactQualityResult;
  recoveryAttempts?: ArtifactRecoveryAttempt[];
  deterministicallySynthesized?: boolean;
  revisionRequests: PhaseBriefRevisionRequest[];
  manualValidationPlan?: string;
  materialChangesFromWorkflowPlan: MaterialPlanChange[];
  approvalStatus: "not-required" | "pending" | "approved" | "rejected" | "stale";
}

export interface ReferencedWorkItem {
  source: ReferencedWorkItemSource;
  repository?: string;
  issueNumber: number;
  url?: string;
  title?: string;
  body?: string;
  acceptanceCriteria?: string[];
  contentStatus: ReferencedWorkItemContentStatus;
  truncated: boolean;
  failureReason?: string;
  retrievedAt?: string;
}

export interface ClarificationDecision {
  original: {
    required: boolean;
    question: string | null;
    reason: string | null;
  };
  ownership: ClarificationOwnership;
  disposition: ClarificationDisposition;
  finalRequired: boolean;
  reason: string;
}

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
  clarificationDecision?: ClarificationDecision;
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

export interface TriageFinding {
  key: string;
  value: string | number | boolean | "unknown" | string[];
  confidence: TriageFactConfidence;
  source: string;
  detail?: string;
}

export interface TriageQuestion {
  id: string;
  question: string;
  reason: string;
  allowedPaths?: string[];
}

export interface TriageEvidencePacket {
  version: 1;
  request: {
    text: string;
    referencedIssue?: string;
    explicitlyNamedPaths: string[];
  };
  referencedWorkItems?: ReferencedWorkItem[];
  repository: {
    root: string;
    languages: string[];
    packageManager?: string;
    projectType?: string;
    hasTests?: TriageSignalValue;
    hasMigrations?: TriageSignalValue;
    hasInfrastructure?: TriageSignalValue;
  };
  changeSignals: {
    taskType?: TriageOutput["task"]["type"];
    namedBoundaries: string[];
    publicContract: TriageSignalValue;
    schemaChange: TriageSignalValue;
    migration: TriageSignalValue;
    security: TriageSignalValue;
    concurrency: TriageSignalValue;
    destructiveOperation: TriageSignalValue;
    productionInfrastructure: TriageSignalValue;
    dataIntegrity: TriageSignalValue;
    externalIntegration: TriageSignalValue;
  };
  deterministicFindings: TriageFinding[];
  unresolvedQuestions: TriageQuestion[];
}

export interface RiskAssessment {
  architecturalImpact: Exclude<RiskLevel, "none">;
  securityRisk: RiskLevel;
  dataIntegrityRisk: RiskLevel;
  operationalRisk: RiskLevel;
}

export interface ModelTriageRecommendation {
  version: 1;
  complexity: Complexity;
  ambiguity: Exclude<RiskLevel, "none">;
  blastRadius: Exclude<RiskLevel, "none">;
  risks: RiskAssessment;
  recommendedMode: WorkflowMode;
  confidence: number;
  parallelism: ParallelismRecommendation;
  constraints: string[];
  approachSummary: string;
  needsAdditionalInspection: boolean;
  inspectionQuestions: TriageQuestion[];
  evidenceReferences: string[];
  taskType?: TriageOutput["task"]["type"];
  clarification?: {
    required: boolean;
    question: string | null;
    reason: string | null;
  };
}

export interface TriageInspectionRequest {
  questions: TriageQuestion[];
  allowedPaths: string[];
  maxReads: number;
  maxBytes: number;
}

export interface TriageInspectionResult {
  version: 1;
  findings: TriageFinding[];
  evidenceReferences: string[];
  exhaustedBudget: boolean;
}

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

export interface PlanningDiagnostic {
  stage: "syntax" | "schema" | "quality";
  path: Array<string | number>;
  code: string;
  message: string;
  contradictionType?: string;
  affectedPhase?: string;
  effectiveConstraint?: string;
  repairAttempt?: "same-model" | "deterministic-normalisation" | "none";
  resolution?: "repaired" | "blocked" | "fallback";
}

export interface PlanningAttemptRecord {
  stage: "draft" | "normalisation" | "semantic-review" | "repair" | "escalation";
  tier?: ModelProfile;
  model?: string;
  launchMode?: string;
  invocation: "not-attempted" | "succeeded" | "failed";
  validation: "not-attempted" | "passed" | "failed";
  diagnosticCodes: string[];
  failureReason?: string;
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
    fallbackReason?: string;
    warnings: string[];
    evidence?: TriageEvidencePacket;
    recommendation?: ModelTriageRecommendation;
    policyDecision?: {
      finalMode: WorkflowMode;
      overrideReasons: string[];
      fastEligible: boolean;
    };
    inspection?: {
      used: boolean;
      request?: TriageInspectionRequest;
      result?: TriageInspectionResult;
      failureReason?: string;
    };
  };
  planningRun?: {
    source: "model" | "deterministic-fallback";
    provider: string;
    model?: string;
    attempts: number;
    fallbackReason?: string;
    warnings: string[];
    diagnostics?: PlanningDiagnostic[];
    syntaxRepairApplied?: boolean;
    semanticRepairApplied?: boolean;
    approvalBlockedReason?: string;
    attemptRecords?: PlanningAttemptRecord[];
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
  revisionRequests?: Array<{ feedback: string; timestamp: string }>;
  rejectedReason?: string;
}

export interface WorkflowConstraintRecord {
  id: string;
  text: string;
  source: ConstraintSource;
  createdAt: string;
  workflowRevision: number;
  transition: string;
}

export interface WorkflowConstraintChange {
  source: ConstraintSource;
  action: ConstraintAction;
  text: string;
  target?: string;
  timestamp: string;
  workflowRevision: number;
  transition: string;
}

export interface WorkflowConstraints {
  original: WorkflowConstraintRecord[];
  policy: WorkflowConstraintRecord[];
  userAdditions: WorkflowConstraintRecord[];
  userRemovals: WorkflowConstraintChange[];
  userOverrides: WorkflowConstraintChange[];
  effective: WorkflowConstraintRecord[];
  audit: WorkflowConstraintChange[];
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
  acceptedDrifts?: PhaseDriftAcceptance[];
  repairAttempts: PhaseRepairAttempt[];
  workspace?: PhaseWorkspace;
}

/**
 * A user-authorized exception for a quarantined provider result.  It records
 * the decision without widening the phase's approved write boundary.
 */
export interface PhaseDriftAcceptance {
  decisionId: string;
  acceptedAt: string;
  acceptedBy: "user";
  workflowRevision: number;
  briefRevision: number;
  reason: string;
  summary: string;
  materialChanges: MaterialPlanChange[];
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
  /** Provider-reported evidence is informative; runner evidence is authoritative. */
  source?: "provider" | "runner";
  timestamp: string;
}

export interface CriterionCompletionEvidence {
  /** Stable within a phase's approved workflow revision; display text may be refined by the brief. */
  criterionId?: string;
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
    /** Required commands that have no matching recorded evidence. */
    missing: string[];
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
  approvedConstraints?: string[];
  evidenceArtifact?: {
    path: string;
    sourcePath?: string;
    recordedAt: string;
  };
  gitEvidence?: PhaseGitEvidence;
}

export interface WorkflowGitContext {
  repositoryRoot: string;
  repositoryIdentity?: string;
  gitCommonDir: string;
  baseCommit: string;
  originalHead: string;
  originalBranch?: string;
  createdAt: string;
  integrationBranch: string;
  integrationWorktreePath: string;
  workspaceRoot: string;
  branchPrefix: string;
  transferStrategy: "internal-commit";
}

export interface IntegrationWorkspace {
  path: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
  status: IntegrationWorkspaceStatus;
  integratedPhaseIds: string[];
  conflictingPhaseIds: string[];
  conflictedFiles: string[];
}

export interface PhaseWorkspace {
  phaseId: string;
  leaseOwnerId: string;
  path: string;
  branch: string;
  baseCommit: string;
  createdAt: string;
  updatedAt: string;
  status: PhaseWorkspaceStatus;
  preparation?: WorkspacePreparation;
}

export interface WorkspacePreparation {
  preparationRevision?: number;
  workspaceIdentity?: string;
  status: WorkspacePreparationStatus;
  worktreePath?: string;
  repositoryIdentity?: string;
  basis?: {
    branch?: string;
    commit?: string;
  };
  packageManager?: "npm" | "pnpm" | "yarn" | "bun" | "none" | "unknown";
  dependencies: "available" | "missing" | "not_applicable" | "unknown";
  bootstrapRequired: boolean;
  bootstrapCommand?: string;
  validationCommandsAvailable?: boolean;
  commandRisk: {
    localWrite: boolean;
    network: boolean;
    lifecycleScripts: boolean;
    lockfilePreserving: boolean;
    manifestMutationExpected: boolean;
  };
  approvalRequired: boolean;
  reason: string;
  checkedAt: string;
  evidence: string[];
}

export interface PhaseGitEvidence {
  workspacePath: string;
  baseCommit: string;
  workspaceHead: string;
  changedFiles: string[];
  diffHash: string;
  untrackedFiles: string[];
  validationCommitOrPatch?: string;
  transferStrategy: "internal-commit";
  binaryFiles: string[];
  fileModeChanges: string[];
}

export interface IntegrationValidation {
  integrationCommit: string;
  commands: ValidationEvidence[];
  startedAt: string;
  completedAt?: string;
  status: IntegrationValidationStatus;
  failureOwnership?: FailureOwnership;
}

export interface WorkflowGitState {
  context: WorkflowGitContext;
  integration: IntegrationWorkspace;
  phaseWorkspaces: Record<string, PhaseWorkspace>;
  integrationValidation?: IntegrationValidation;
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

export interface PhaseExecutionRecord {
  phaseId: string;
  providerId: string;
  providerExecutionId: string;
  leaseOwnerId: string;
  workspacePath: string;
  status: PhaseExecutionRecordStatus;
  startedAt: string;
  heartbeatAt?: string;
  completedAt?: string;
  resultSummary?: string;
  diagnostics?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
  providerSession?: ProviderSessionRef;
  checkpoint?: PhaseWorkspaceCheckpoint;
  executionBudget?: ExecutionTurnBudgetState;
  executionIdentity?: PhaseExecutionIdentity;
  /** Full provider result retained while material drift is awaiting a decision. */
  quarantinedResult?: PhaseExecutionResult;
}

export interface PhaseExecutionIdentity {
  workflowId: string;
  workflowRevision: number;
  phaseId: string;
  briefRevision: number;
  workspaceIdentity: string;
  workspacePath: string;
  baseCommit: string;
  constraintHash: string;
  providerId: string;
  providerSessionId?: string;
  dispatchedAt: string;
}

export interface PhaseDispatchBlocker {
  code: string;
  message: string;
  recovery?: string;
}

export interface PhaseDispatchEligibility {
  eligible: boolean;
  phaseId: string;
  workflowRevision: number;
  briefRevision?: number;
  dependencyReady: boolean;
  dispatchReady: boolean;
  recommendedPhaseId?: string;
  blockers: PhaseDispatchBlocker[];
}

export interface WorkflowExecutionState {
  coordinatorId?: string;
  records: Record<string, PhaseExecutionRecord>;
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
    fallbackReason?: string;
    warnings: string[];
    evidence?: TriageEvidencePacket;
    recommendation?: ModelTriageRecommendation;
    policyDecision?: {
      finalMode: WorkflowMode;
      overrideReasons: string[];
      fastEligible: boolean;
    };
    inspection?: {
      used: boolean;
      request?: TriageInspectionRequest;
      result?: TriageInspectionResult;
      failureReason?: string;
    };
  };
  constraints?: WorkflowConstraints;
  planningRun?: {
    source: "model" | "deterministic-fallback";
    provider: string;
    model?: string;
    attempts: number;
    fallbackReason?: string;
    warnings: string[];
    diagnostics?: PlanningDiagnostic[];
    syntaxRepairApplied?: boolean;
    semanticRepairApplied?: boolean;
    approvalBlockedReason?: string;
    attemptRecords?: PlanningAttemptRecord[];
  };
  clarification?: {
    question: string;
    reason: string;
    answer?: string;
    answeredAt?: string;
  };
  approach?: ApproachRecommendation;
  plan?: ExecutionPlan;
  approval?: WorkflowApprovalState;
  phaseBriefs?: Record<string, PhaseExecutionBrief>;
  phaseBriefFailures?: Record<string, PhaseBriefGenerationFailure>;
  validation: ValidationEvidence[];
  review?: IntegratedReviewResult;
  commitPlan?: CommitPlan;
  phaseLeases: Record<string, PhaseLease>;
  execution: WorkflowExecutionState;
  git?: WorkflowGitState;
  repairAttempts: number;
  blockers: string[];
  events: WorkflowEvent[];
}
