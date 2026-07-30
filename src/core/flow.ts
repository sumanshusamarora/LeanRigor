import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import { defaultConfig } from "../config/defaults.js";
import type { LeanRigorConfig, ModelTier } from "../config/schema.js";
import { resolveModelTier } from "../config/models.js";
import { isPotentialRepositoryFile, isRepositoryPathPattern, normaliseRepositoryPath } from "./repository-path.js";
import { commitCommands, proposeCommits } from "./commit-planner.js";
import {
  applyApprovedPhaseToIntegration,
  captureApprovedPhaseChange,
  cleanupOwnedWorkspaces,
  createPhaseWorkspace,
  ensureIntegrationWorkspace,
  inspectPhaseWorkspaceChanges,
  integrationStatus as buildIntegrationStatus,
  preflightGitRepository,
  recoverWorkspaceState,
  runIntegrationValidation,
  workspaceStatus as buildWorkspaceStatus,
  type GitPreflightResult,
  type IntegrationOperationResult,
  type WorkspaceCleanupReport,
  type WorkspaceRecoveryReport,
  type WorkspaceStatus
} from "./git-workspace.js";
import type { PlanDiagnostic, PlanningProvider, PlanningProviderInput, PlanningRunResult } from "./planning-runner.js";
import { PlanningValidationError, runPlanning } from "./planning-runner.js";
import type { TriageProvider, TriageProviderSelection, TriageRunResult } from "./triage-runner.js";
import { runTriage } from "./triage-runner.js";
import type {
  ApproachRecommendation,
  CommitPlan,
  CompletionGateDecision,
  ConstraintAction,
  ConstraintSource,
  CriterionCompletionEvidence,
  ExecutionGraph,
  ExecutionPlan,
  IntegratedReviewResult,
  ModelProfile,
  PhaseApprovalDecision,
  PhaseCompletionRecord,
  PhaseRepairAttempt,
  RiskLevel,
  SequentialWorkflowState,
  TriageEvidencePacket,
  TriageOutput,
  ValidationEvidence,
  WorkflowConstraintChange,
  WorkflowConstraintRecord,
  WorkflowConstraints,
  WorkflowDecisionType,
  WorkflowLifecycleState,
  WorkflowMode,
  WorkflowEvent,
  WorkflowLockOwnerType,
  WorkflowPhase
} from "./types.js";
import { acquireWorkflowLock, releaseWorkflowLock } from "./workflow-lock.js";
import { RevisionConflictError, atomicWriteJson } from "./workflow-store.js";
import { calculateReadyPhases, dependencyIds, refreshPhaseReadiness, validatePhaseDag } from "./scheduler.js";
import { approvalRecommendation, briefIsCurrent, defaultApprovalPolicy, requiresPhaseByPhase } from "./approval.js";
import {
  evaluatePhaseDispatchEligibility,
  PHASE_PREPARATION_CAPABILITY,
  TRUSTED_INTERNAL_PHASE_EXECUTION_CAPABILITY
} from "./dispatch-eligibility.js";
import {
  classifyAcceptanceOutcome,
  generateInspectedPhaseExecutionBrief,
  synthesizeObservableAcceptanceCriteria,
  type PhaseBriefGenerationOutcome,
  type PhaseBriefPlanningProvider
} from "./phase-brief-planner.js";
import { repairPhaseGraphDependencies, validatePhaseGraphQuality } from "./phase-graph-quality.js";
import { missingRequiredValidationCommands } from "./validation-policy.js";
import {
  migrateWorkflowDecision,
  requirePendingDecision,
  resolvePendingDecision,
  setPendingDecision
} from "./workflow-decision.js";

export const WORKFLOW_DIR = path.join(".leanrigor", "workflows");
export const STATE_VERSION = 2;
const require = createRequire(import.meta.url);

const lifecycleStateSchema = z.enum([
  "created",
  "triaging",
  "awaiting_clarification",
  "awaiting_approach_approval",
  "planning",
  "awaiting_plan_approval",
  "executing",
  "validating",
  "reviewing",
  "awaiting_commit_approval",
  "completed",
  "blocked",
  "cancelled"
]);

const riskSchema = z.enum(["none", "low", "medium", "high"]);
const modelProfileSchema = z.enum(["small", "medium", "large", "inherit"]);
const criterionStatusSchema = z.enum(["met", "not_met", "uncertain", "not_applicable"]);
const completionDecisionSchema = z.enum(["completed", "needs_repair", "needs_review", "needs_replan", "blocked"]);
const phaseStatusSchema = z.enum(["planned", "ready", "leased", "running", "completion_pending", "completed", "needs_repair", "needs_review", "needs_replan", "blocked", "cancelled"]);
const constraintSourceSchema = z.enum(["policy", "triage", "user"]);
const constraintActionSchema = z.enum(["add", "remove", "override"]);
const clarificationOwnershipSchema = z.enum(["user-intent", "user-policy", "safety-critical", "repository-discoverable", "planning-detail", "already-resolved", "unnecessary"]);
const clarificationDispositionSchema = z.enum(["accepted", "inspected", "deferred", "suppressed"]);

const triageSchema = z.object({
  version: z.literal(1),
  task: z.object({
    type: z.enum(["bug", "feature", "refactor", "investigation", "maintenance", "documentation", "unknown"]),
    summary: z.string()
  }),
  assessment: z.object({
    complexity: z.enum(["low", "medium", "high"]),
    ambiguity: z.enum(["low", "medium", "high"]),
    blastRadius: z.enum(["low", "medium", "high"]),
    architecturalImpact: z.enum(["low", "medium", "high"]),
    securityRisk: riskSchema,
    dataIntegrityRisk: riskSchema,
    operationalRisk: riskSchema
  }),
  workflow: z.object({
    modelRecommendation: z.enum(["fast", "standard", "rigorous"]),
    finalMode: z.enum(["fast", "standard", "rigorous"]),
    confidence: z.number(),
    parallelism: z.enum(["sequential", "candidate"]),
    reviewLevel: z.enum(["sanity", "integrated", "deep", "specialist"]),
    testLevel: z.enum(["none", "sanity", "targeted", "package", "full"]),
    overridden: z.boolean(),
    overrideReason: z.string().nullable()
  }),
  clarification: z.object({
    required: z.boolean(),
    question: z.string().nullable(),
    reason: z.string().nullable()
  }),
  clarificationDecision: z.object({
    original: z.object({
      required: z.boolean(),
      question: z.string().nullable(),
      reason: z.string().nullable()
    }),
    ownership: clarificationOwnershipSchema,
    disposition: clarificationDispositionSchema,
    finalRequired: z.boolean(),
    reason: z.string()
  }).optional(),
  inspection: z.object({
    required: z.boolean(),
    targets: z.array(z.string())
  }),
  escalationReasons: z.array(z.string()),
  assumptions: z.array(z.string()),
  constraints: z.object({ mustNot: z.array(z.string()) })
});

const validationEvidenceSchema = z.object({
  phaseId: z.string().optional(),
  command: z.string().min(1),
  exitStatus: z.number().int().nullable(),
  result: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  skipped: z.boolean(),
  skippedReason: z.string().optional(),
  timestamp: z.string()
}).superRefine((value, ctx) => {
  if (value.skipped && !value.skippedReason) {
    ctx.addIssue({ code: "custom", path: ["skippedReason"], message: "Skipped validation requires a reason." });
  }
  if (!value.skipped && value.exitStatus === null) {
    ctx.addIssue({ code: "custom", path: ["exitStatus"], message: "Non-skipped validation requires an exit status." });
  }
});

const criterionCompletionSchema = z.object({
  criterion: z.string().min(1),
  status: criterionStatusSchema,
  evidence: z.array(z.string().min(1))
});

const phaseRepairAttemptSchema = z.object({
  attempt: z.number().int().min(1),
  reason: z.string().min(1),
  requestedScope: z.string().min(1),
  validation: z.array(validationEvidenceSchema),
  outcome: completionDecisionSchema.optional(),
  timestamp: z.string()
});

const phaseGitEvidenceSchema = z.object({
  workspacePath: z.string().min(1),
  baseCommit: z.string().min(1),
  workspaceHead: z.string().min(1),
  changedFiles: z.array(z.string()),
  diffHash: z.string().min(1),
  untrackedFiles: z.array(z.string()),
  validationCommitOrPatch: z.string().optional(),
  transferStrategy: z.literal("internal-commit"),
  binaryFiles: z.array(z.string()).default([]),
  fileModeChanges: z.array(z.string()).default([])
});

const phaseCompletionRecordSchema = z.object({
  phaseId: z.string().min(1),
  objective: z.string().min(1),
  criteria: z.array(criterionCompletionSchema),
  filesChanged: z.array(z.string()),
  validation: z.object({
    status: z.enum(["passed", "failed", "skipped", "missing"]),
    commands: z.array(validationEvidenceSchema),
    skipped: z.array(z.object({ command: z.string().min(1), reason: z.string().min(1) }))
  }),
  scopeDeviations: z.array(z.string()),
  assumptions: z.array(z.string()),
  remainingRisks: z.array(z.string()),
  dependentPhasesMayProceed: z.boolean(),
  decision: completionDecisionSchema,
  reason: z.string(),
  repairAttempt: z.number().int().min(0),
  timestamp: z.string(),
  workflowRevision: z.number().int().min(0),
  leaseOwnerId: z.string().optional(),
  approvedConstraints: z.array(z.string()).optional(),
  evidenceArtifact: z.object({
    path: z.string().min(1),
    sourcePath: z.string().min(1).optional(),
    recordedAt: z.string()
  }).optional(),
  gitEvidence: phaseGitEvidenceSchema.optional()
});

const phaseWorkspaceSchema = z.object({
  phaseId: z.string().min(1),
  leaseOwnerId: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  baseCommit: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(["not_created", "ready", "active", "completion_pending", "approved", "integrated", "needs_repair", "conflicted", "abandoned"]),
  preparation: z.object({
    preparationRevision: z.number().int().min(1).optional(),
    workspaceIdentity: z.string().min(1).optional(),
    status: z.enum(["available", "prepared", "blocked", "failed"]),
    worktreePath: z.string().min(1).optional(),
    repositoryIdentity: z.string().min(1).optional(),
    basis: z.object({
      branch: z.string().min(1).optional(),
      commit: z.string().min(1).optional()
    }).optional(),
    packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "none", "unknown"]).optional(),
    dependencies: z.enum(["available", "missing", "not_applicable", "unknown"]),
    bootstrapRequired: z.boolean(),
    bootstrapCommand: z.string().optional(),
    validationCommandsAvailable: z.boolean().optional(),
    commandRisk: z.object({
      localWrite: z.boolean(),
      network: z.boolean(),
      lifecycleScripts: z.boolean(),
      lockfilePreserving: z.boolean(),
      manifestMutationExpected: z.boolean()
    }),
    approvalRequired: z.boolean(),
    reason: z.string(),
    checkedAt: z.string(),
    evidence: z.array(z.string())
  }).optional()
});

const materialPlanChangeSchema = z.object({
  category: z.enum(["write-boundary", "migration", "compatibility", "public-contract", "security", "concurrency", "recovery", "data-integrity", "production-infrastructure", "destructive-operation", "network-operation", "acceptance-criteria", "validation", "dependency", "ordering", "architecture", "provider", "file-refinement", "symbol-refinement", "read-boundary", "risk"]),
  previousValue: z.union([z.string(), z.array(z.string())]).optional(),
  proposedValue: z.union([z.string(), z.array(z.string())]).optional(),
  affectedPhase: z.string().min(1),
  severity: z.enum(["informational", "medium", "high"]),
  material: z.boolean().default(true),
  reason: z.string().min(1),
  requiredTransition: z.enum(["none", "reapprove-plan", "revise-plan", "revise-phase-brief"])
});

const phaseSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  rationale: z.string().min(1),
  dependencies: z.array(z.string()),
  dependsOn: z.array(z.string()).default([]),
  expectedReadAreas: z.array(z.string()).default([]),
  expectedWriteAreas: z.array(z.string()).default([]),
  expectedFilesOrAreas: z.array(z.string()),
  acceptanceCriteria: z.array(z.string().min(1)),
  validationCommands: z.array(z.string()),
  riskLevel: riskSchema,
  modelTier: modelProfileSchema,
  status: z.preprocess((value) => value === "pending" ? "planned" : value === "active" ? "running" : value, phaseStatusSchema),
  ownershipUncertain: z.boolean().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  filesChanged: z.array(z.string()),
  commandsRun: z.array(z.string()),
  validationResults: z.array(validationEvidenceSchema),
  scopeDeviations: z.array(z.string()),
  completion: phaseCompletionRecordSchema.optional(),
  acceptedDrifts: z.array(z.object({
    decisionId: z.string().min(1),
    acceptedAt: z.string(),
    acceptedBy: z.literal("user"),
    workflowRevision: z.number().int().min(0),
    briefRevision: z.number().int().min(1),
    reason: z.string().min(1).max(4000),
    summary: z.string().max(4000),
    materialChanges: z.array(materialPlanChangeSchema)
  })).default([]),
  repairAttempts: z.array(phaseRepairAttemptSchema).default([]),
  workspace: phaseWorkspaceSchema.optional()
});

const planSchema = z.object({
  version: z.literal(1),
  summary: z.string().min(1),
  principles: z.array(z.string().min(1)),
  phases: z.array(phaseSchema).min(1),
  approvedAt: z.string().optional(),
  revisionRequests: z.array(z.object({ feedback: z.string().min(1), timestamp: z.string() }))
}).superRefine((plan, ctx) => {
  const ids = new Set(plan.phases.map((phase) => phase.id));
  if (ids.size !== plan.phases.length) {
    ctx.addIssue({ code: "custom", path: ["phases"], message: "Phase IDs must be unique." });
  }
  for (const phase of plan.phases) {
    for (const dependency of dependencyIds(phase as WorkflowPhase)) {
      if (!ids.has(dependency)) {
        ctx.addIssue({ code: "custom", path: ["phases", phase.id, "dependencies"], message: `Missing dependency ${dependency}.` });
      }
    }
  }
  for (const issue of validatePhaseDag(plan as ExecutionPlan)) {
    ctx.addIssue({ code: "custom", path: ["phases"], message: issue });
  }
});

const modelPlanPhaseSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  rationale: z.string().min(1),
  dependencies: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).optional(),
  expectedReadAreas: z.array(z.string()).optional(),
  expectedWriteAreas: z.array(z.string()).optional(),
  expectedFilesOrAreas: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  validationCommands: z.array(z.string()),
  riskLevel: riskSchema,
  modelTier: modelProfileSchema
});

const modelPlanSchema = z.object({
  version: z.literal(1).default(1),
  summary: z.string().min(1),
  principles: z.array(z.string().min(1)).optional(),
  phases: z.array(modelPlanPhaseSchema).min(1),
  revisionRequests: z.array(z.object({ feedback: z.string().min(1), timestamp: z.string() })).default([])
});

const phaseLeaseSchema = z.object({
  phaseId: z.string().min(1),
  ownerId: z.string().min(1),
  ownerType: z.enum(["cli", "claude-session", "agent", "system"]).default("cli"),
  acquiredAt: z.string(),
  heartbeatAt: z.string(),
  expiresAt: z.string(),
  workflowRevisionAtAcquire: z.number().int().min(0),
  allowedWriteAreas: z.array(z.string()),
  releasedAt: z.string().optional()
});

const boundedRecord = z.record(z.string(), z.unknown()).default({}).transform((value) => boundDiagnosticObject(value));

const providerSessionSchema = z.object({
  providerId: z.string().min(1),
  sessionId: z.string().min(1),
  workflowId: z.string().min(1),
  phaseId: z.string().min(1),
  executionAttemptId: z.string().min(1),
  workingDirectory: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(["created", "running", "completed", "failed", "cancelled", "expired", "unavailable"]),
  requestedTier: modelProfileSchema.optional(),
  resolvedModel: z.string().optional(),
  providerVersion: z.string().optional(),
  safeCliArgs: z.array(z.string()).optional(),
  resumePermitted: z.boolean().default(false),
  resumedFromSessionId: z.string().optional(),
  replacementReason: z.string().optional()
});

const phaseWorkspaceCheckpointSchema = z.object({
  capturedAt: z.string(),
  workspacePath: z.string().min(1),
  dirty: z.boolean(),
  trackedModified: z.array(z.string()),
  untrackedFiles: z.array(z.string()),
  deletedFiles: z.array(z.string()),
  changedFiles: z.array(z.string()),
  contentFingerprint: z.string().optional(),
  diffSummary: z.object({
    text: z.string().max(32768),
    bytes: z.number().int().min(0),
    truncated: z.boolean()
  }),
  validationCommands: z.array(z.string()),
  validationResults: z.array(z.object({
    command: z.string(),
    status: z.string().optional(),
    exitCode: z.number().int().nullable().optional(),
    result: z.string().max(1000).optional()
  })),
  note: z.string().max(1000)
});

const phaseExecutionRecordSchema = z.object({
  phaseId: z.string().min(1),
  providerId: z.string().min(1),
  providerExecutionId: z.string().min(1),
  leaseOwnerId: z.string().min(1),
  workspacePath: z.string().min(1),
  status: z.enum(["dispatching", "running", "completed", "failed", "cancelled", "timed_out", "blocked", "collecting", "result_recorded"]),
  startedAt: z.string(),
  heartbeatAt: z.string().optional(),
  completedAt: z.string().optional(),
  resultSummary: z.string().max(4000).optional(),
  diagnostics: boundedRecord.optional(),
  providerMetadata: boundedRecord.optional(),
  providerSession: providerSessionSchema.optional(),
  checkpoint: phaseWorkspaceCheckpointSchema.optional(),
  executionBudget: z.object({
    initialTurnLimit: z.number().int().min(1),
    effectiveTurnLimit: z.number().int().min(1),
    extensionTurnLimit: z.number().int().min(1),
    extensionApprovals: z.number().int().min(0),
    cumulativeAuthorizedTurns: z.number().int().min(1),
    attempts: z.array(z.object({
      providerExecutionId: z.string().min(1),
      maxTurns: z.number().int().min(1),
      reportedTurnsUsed: z.number().int().min(0).optional(),
      terminalReason: z.string().optional(),
      costUsd: z.number().min(0).optional(),
      completedAt: z.string().optional()
    })).default([])
  }).optional(),
  executionIdentity: z.object({
    workflowId: z.string().min(1),
    workflowRevision: z.number().int().min(0),
    phaseId: z.string().min(1),
    briefRevision: z.number().int().min(1),
    workspaceIdentity: z.string().min(1),
    workspacePath: z.string().min(1),
    baseCommit: z.string().min(1),
    constraintHash: z.string().min(1),
    providerId: z.string().min(1),
    providerSessionId: z.string().optional(),
    dispatchedAt: z.string()
  }).optional(),
  quarantinedResult: z.object({
    status: z.enum(["completed", "needs_replan", "needs_review", "failed", "cancelled", "timed_out", "blocked"]),
    executionIdentity: z.object({
      workflowId: z.string().min(1),
      workflowRevision: z.number().int().min(0),
      phaseId: z.string().min(1),
      briefRevision: z.number().int().min(1),
      workspaceIdentity: z.string().min(1),
      workspacePath: z.string().min(1),
      baseCommit: z.string().min(1),
      constraintHash: z.string().min(1),
      providerId: z.string().min(1),
      providerSessionId: z.string().optional(),
      dispatchedAt: z.string()
    }),
    summary: z.string().max(4000),
    changedFiles: z.array(z.string()),
    validation: z.array(z.object({
      command: z.string(), exitCode: z.number().int().nullable().optional(), status: z.enum(["passed", "failed", "skipped"]).optional(), result: z.string().optional(), skipped: z.boolean().optional(), skippedReason: z.string().optional(), timestamp: z.string().optional()
    })),
    criterionEvidence: z.array(z.object({ criterion: z.string(), status: z.enum(["met", "not_met", "uncertain", "not_applicable"]), evidence: z.array(z.string()) })),
    assumptions: z.array(z.string()),
    scopeDeviations: z.array(z.object({ path: z.string().optional(), reason: z.string() })),
    discoveredMaterialChanges: z.array(materialPlanChangeSchema),
    remainingRisks: z.array(z.string()),
    providerDiagnostics: boundedRecord.optional()
  }).optional()
});

const workflowExecutionStateSchema = z.object({
  coordinatorId: z.string().optional(),
  records: z.record(z.string(), phaseExecutionRecordSchema).default({})
}).default({ records: {} });

const constraintRecordSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  source: constraintSourceSchema,
  createdAt: z.string(),
  workflowRevision: z.number().int().min(0),
  transition: z.string().min(1)
});

const constraintChangeSchema = z.object({
  source: constraintSourceSchema,
  action: constraintActionSchema,
  text: z.string().min(1),
  target: z.string().min(1).optional(),
  timestamp: z.string(),
  workflowRevision: z.number().int().min(0),
  transition: z.string().min(1)
});

const workflowConstraintsSchema = z.object({
  original: z.array(constraintRecordSchema).default([]),
  policy: z.array(constraintRecordSchema).default([]),
  userAdditions: z.array(constraintRecordSchema).default([]),
  userRemovals: z.array(constraintChangeSchema).default([]),
  userOverrides: z.array(constraintChangeSchema).default([]),
  effective: z.array(constraintRecordSchema).default([]),
  audit: z.array(constraintChangeSchema).default([])
});

const approvalRecommendationSchema = z.object({
  option: z.enum(["approve-all-remaining", "approve-current-phase"]),
  ruleId: z.string().min(1),
  reasons: z.array(z.string().min(1)),
  workflowRevision: z.number().int().min(0),
  phaseId: z.string().optional(),
  createdAt: z.string(),
  overridable: z.boolean()
});

const phaseBriefRiskCategorySchema = z.enum([
  "security",
  "public-contract",
  "migration",
  "architecture",
  "data-integrity",
  "concurrency",
  "recovery",
  "production-infrastructure",
  "destructive-operation",
  "network-operation"
]);

const phaseBriefRiskDiscoverySchema = z.object({
  risk: z.string().min(1),
  categories: z.array(phaseBriefRiskCategorySchema).min(1),
  evidence: z.array(z.string().min(1)).min(1),
  source: z.literal("inspection")
});

const phaseBriefInspectionQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  reason: z.string().min(1)
});

const phaseBriefScopeExpansionSchema = z.object({
  path: z.string().min(1),
  reason: z.string().min(1),
  sourcePath: z.string().optional(),
  readOnly: z.literal(true)
});

const phaseBriefInspectionRequestSchema = z.object({
  workflowId: z.string().min(1),
  phaseId: z.string().min(1),
  workflowRevision: z.number().int().min(0),
  questions: z.array(phaseBriefInspectionQuestionSchema),
  allowedPaths: z.array(z.string()),
  scopeExpansions: z.array(phaseBriefScopeExpansionSchema),
  maxReads: z.number().int().min(1),
  maxBytes: z.number().int().min(1),
  timeoutSeconds: z.number().min(0)
});

const phaseBriefInspectionResultSchema = z.object({
  status: z.enum(["completed", "partial", "unavailable", "failed"]),
  findings: z.array(z.object({
    questionId: z.string().min(1),
    question: z.string().min(1),
    answer: z.string(),
    evidence: z.array(z.string())
  })),
  filesRead: z.array(z.string()),
  bytesRead: z.number().int().min(0),
  unresolvedQuestions: z.array(z.string()),
  warnings: z.array(z.string()),
  relevantFiles: z.array(z.string()),
  relevantSymbols: z.array(z.string()),
  validationCommands: z.array(z.string()),
  completedAt: z.string(),
  provenance: z.object({
    source: z.string().min(1),
    provider: z.string().optional(),
    modelTier: modelProfileSchema.optional()
  })
});

const phaseBriefDiagnosticSchema = z.object({
  stage: z.enum(["inspection", "generation", "quality"]),
  field: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
  repairAttempt: z.enum(["none", "same-provider"]),
  resolution: z.enum(["unresolved", "repaired"])
});

const artifactRecoveryAttemptSchema = z.object({
  attempt: z.number().int().min(1),
  strategy: z.enum(["initial-generation", "targeted-repair", "refreshed-inspection", "alternate-strategy", "deterministic-fallback"]),
  provider: z.string().min(1),
  modelTier: modelProfileSchema,
  inputArtifactHash: z.string().min(1),
  outputArtifactHash: z.string().min(1).optional(),
  inspectionIdentity: z.string().min(1).optional(),
  validationDiagnostics: z.array(z.string()),
  changed: z.boolean(),
  disposition: z.enum(["continue", "succeeded", "failed", "skipped-identical"]),
  timestamp: z.string()
});

const artifactQualityDimensionSchema = z.object({
  status: z.enum(["pass", "warning", "fail"]),
  diagnosticCodes: z.array(z.string()),
  evidence: z.array(z.string())
});

const artifactQualityResultSchema = z.object({
  artifactType: z.enum(["triage", "workflow-plan", "phase-brief", "provider-result", "completion-gate", "integration", "final-summary"]),
  artifactId: z.string().min(1),
  overall: z.enum(["pass", "warning", "fail"]),
  dimensions: z.object({
    completeness: artifactQualityDimensionSchema,
    specificity: artifactQualityDimensionSchema,
    traceability: artifactQualityDimensionSchema,
    "phase-closure": artifactQualityDimensionSchema,
    "dependency-validity": artifactQualityDimensionSchema,
    "evidence-coverage": artifactQualityDimensionSchema,
    "recovery-viability": artifactQualityDimensionSchema,
    "internal-consistency": artifactQualityDimensionSchema
  }),
  evaluatedAt: z.string()
});

const legacyInspectionRequest = {
  workflowId: "legacy",
  phaseId: "legacy",
  workflowRevision: 0,
  questions: [],
  allowedPaths: [],
  scopeExpansions: [],
  maxReads: 1,
  maxBytes: 1,
  timeoutSeconds: 0
};

const legacyInspectionResult = {
  status: "unavailable" as const,
  findings: [],
  filesRead: [],
  bytesRead: 0,
  unresolvedQuestions: ["Legacy brief has no bounded inspection provenance."],
  warnings: ["Loaded from a workflow created before inspected phase briefs."],
  relevantFiles: [],
  relevantSymbols: [],
  validationCommands: [],
  completedAt: "1970-01-01T00:00:00.000Z",
  provenance: { source: "legacy-unverified" }
};

const phaseExecutionBriefSchema = z.object({
  phaseId: z.string().min(1),
  workflowRevision: z.number().int().min(0),
  briefRevision: z.number().int().min(1),
  generatedAt: z.string(),
  objective: z.string().min(1),
  deliverable: z.string().min(1),
  currentBehaviour: z.string().optional(),
  implementationApproach: z.string().min(1),
  readAreas: z.array(z.string()),
  writeAreas: z.array(z.string()),
  relevantFiles: z.array(z.string()).default([]),
  relevantSymbols: z.array(z.string()).default([]),
  dependencies: z.array(z.string()),
  assumptions: z.array(z.string()),
  exclusions: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  testObligations: z.array(z.string()),
  validationCommands: z.array(z.string()),
  risks: z.array(z.string()),
  riskDiscoveries: z.array(phaseBriefRiskDiscoverySchema).default([]),
  provider: z.string().optional(),
  modelTier: modelProfileSchema.optional(),
  inspectionRequest: phaseBriefInspectionRequestSchema.default(legacyInspectionRequest),
  inspectionResult: phaseBriefInspectionResultSchema.default(legacyInspectionResult),
  repository: z.object({
    baseCommit: z.string().optional(),
    repositoryRevision: z.string().min(1),
    constraintHash: z.string().min(1),
    inspectionResultId: z.string().min(1),
    inspectedPaths: z.array(z.string()),
    planFingerprint: z.string().optional(),
    dependencyFingerprint: z.string().optional(),
    priorPhaseOutcomesHash: z.string().optional(),
    executionPolicyHash: z.string().optional()
  }).default({
    repositoryRevision: "legacy-unverified",
    constraintHash: "legacy-unverified",
    inspectionResultId: "legacy-unverified",
    inspectedPaths: []
  }),
  generation: z.object({
    source: z.enum(["deterministic", "provider"]),
    provider: z.string().min(1),
    modelTier: modelProfileSchema,
    warnings: z.array(z.string())
  }).default({
    source: "deterministic",
    provider: "legacy-unverified",
    modelTier: "inherit",
    warnings: ["Loaded from a workflow created before phase-brief generation provenance."]
  }),
  validation: z.object({
    status: z.enum(["valid", "blocked"]),
    diagnostics: z.array(phaseBriefDiagnosticSchema),
    repairAttempts: z.number().int().min(0),
    validatedAt: z.string()
  }).default({
    status: "blocked",
    diagnostics: [{
      stage: "quality",
      field: "brief",
      code: "brief.legacy_unverified",
      message: "Legacy phase brief must be regenerated before execution.",
      repairAttempt: "none",
      resolution: "unresolved"
    }],
    repairAttempts: 0,
    validatedAt: "1970-01-01T00:00:00.000Z"
  }),
  quality: artifactQualityResultSchema.optional(),
  recoveryAttempts: z.array(artifactRecoveryAttemptSchema).optional(),
  deterministicallySynthesized: z.boolean().optional(),
  revisionRequests: z.array(z.object({ feedback: z.string().min(1), timestamp: z.string() })).default([]),
  manualValidationPlan: z.string().optional(),
  materialChangesFromWorkflowPlan: z.array(materialPlanChangeSchema).default([]),
  approvalStatus: z.enum(["not-required", "pending", "approved", "rejected", "stale"])
});

const phaseBriefGenerationFailureSchema = z.object({
  phaseId: z.string().min(1),
  workflowRevision: z.number().int().min(0),
  briefRevision: z.number().int().min(1),
  status: z.enum(["inspection-unavailable", "inspection-failed", "quality-blocked"]),
  message: z.string().min(1),
  diagnostics: z.array(phaseBriefDiagnosticSchema),
  inspectionRequest: phaseBriefInspectionRequestSchema,
  inspectionResult: phaseBriefInspectionResultSchema.optional(),
  repairAttempts: z.number().int().min(0),
  provider: z.string().min(1),
  modelTier: modelProfileSchema,
  failureOwnership: z.enum([
    "leanrigor_generation_failure",
    "repository_evidence_insufficient",
    "provider_failure",
    "user_decision_required",
    "policy_block",
    "environment_failure",
    "implementation_failure",
    "validation_failure",
    "integration_failure"
  ]).optional(),
  recoveryAttempts: z.array(artifactRecoveryAttemptSchema).optional(),
  quality: artifactQualityResultSchema.optional(),
  failedAt: z.string()
});

const workflowDecisionBaseShape = {
  id: z.string().min(1),
  workflowRevision: z.number().int().min(0),
  stateRevision: z.number().int().min(0),
  question: z.string().min(1),
  status: z.enum(["pending", "approved", "answered", "rejected", "superseded", "cancelled"]),
  createdAt: z.string(),
  resolvedAt: z.string().optional(),
  selectedAction: z.string().min(1).optional(),
  source: z.enum(["user", "controller", "system", "legacy-migration"]),
  additionalTurns: z.number().int().min(1).optional(),
  supersedesDecisionId: z.string().min(1).optional()
};

const phaseApprovalDecisionSchema = z.object({
  ...workflowDecisionBaseShape,
  type: z.literal("phase-brief-approval"),
  phaseId: z.string().min(1),
  briefRevision: z.number().int().min(1),
  preparationRevision: z.number().int().min(1).optional(),
  integrationRevision: z.number().int().min(0).optional(),
  allowedActions: z.array(z.enum(["approve-phase", "revise-phase-brief", "view-details", "cancel-workflow"]))
});

const workspaceBootstrapDecisionSchema = z.object({
  ...workflowDecisionBaseShape,
  type: z.literal("workspace-bootstrap-approval"),
  phaseId: z.string().min(1),
  briefRevision: z.number().int().min(1),
  preparationRevision: z.number().int().min(1),
  integrationRevision: z.number().int().min(0).optional(),
  workspaceIdentity: z.string().min(1),
  command: z.string().min(1),
  riskSummary: z.array(z.string().min(1)),
  allowedActions: z.array(z.enum(["approve-bootstrap", "retry-preparation", "view-details", "cancel-workflow"]))
});

const workflowActionDecisionSchema = z.object({
  ...workflowDecisionBaseShape,
  type: z.enum([
    "clarification",
    "approach-approval",
    "workflow-plan-approval",
    "planning-fallback-review",
    "material-drift-review",
    "execution-recovery",
    "integration-conflict",
    "final-review",
    "final-completion"
  ]),
  phaseId: z.string().min(1).optional(),
  briefRevision: z.number().int().min(1).optional(),
  preparationRevision: z.number().int().min(1).optional(),
  integrationRevision: z.number().int().min(0).optional(),
  allowedActions: z.array(z.string().min(1))
});

const workflowPendingDecisionSchema = z.discriminatedUnion("type", [
  phaseApprovalDecisionSchema,
  workspaceBootstrapDecisionSchema,
  workflowActionDecisionSchema
]);

const workflowApprovalSchema = z.object({
  policy: z.enum(["workflow-authorized", "phase-by-phase"]).optional(),
  source: z.enum(["user", "deterministic-policy", "legacy-default"]).optional(),
  selectedAt: z.string().optional(),
  workflowPlanRevision: z.number().int().min(0).optional(),
  currentAuthorizedPhase: z.string().optional(),
  recommendation: approvalRecommendationSchema.optional(),
  history: z.array(z.object({
    policy: z.enum(["workflow-authorized", "phase-by-phase"]),
    source: z.enum(["user", "deterministic-policy", "legacy-default"]),
    timestamp: z.string(),
    workflowRevision: z.number().int().min(0),
    phaseId: z.string().optional(),
    briefRevision: z.number().int().min(1).optional(),
    recommendation: approvalRecommendationSchema.optional(),
    recommendationOverridden: z.boolean(),
    action: z.enum(["plan-approved", "phase-approved", "policy-changed", "reapproval-required"])
  })).default([]),
  pendingDecision: workflowPendingDecisionSchema.optional(),
  decisionHistory: z.array(workflowPendingDecisionSchema).default([])
});

const workflowEventSchema = z.object({
  eventId: z.string().min(1),
  timestamp: z.string(),
  actorId: z.string().min(1),
  type: z.string().min(1),
  workflowRevisionBefore: z.number().int().min(0),
  workflowRevisionAfter: z.number().int().min(0),
  phaseId: z.string().optional(),
  summary: z.string().min(1)
});

const integrationValidationSchema = z.object({
  integrationCommit: z.string().min(1),
  commands: z.array(validationEvidenceSchema),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  status: z.enum(["pending", "running", "passed", "failed", "skipped"]),
  failureOwnership: z.enum([
    "leanrigor_generation_failure",
    "repository_evidence_insufficient",
    "provider_failure",
    "user_decision_required",
    "policy_block",
    "environment_failure",
    "implementation_failure",
    "validation_failure",
    "integration_failure"
  ]).optional()
});

const workflowGitStateSchema = z.object({
  context: z.object({
    repositoryRoot: z.string().min(1),
    repositoryIdentity: z.string().min(1).optional(),
    gitCommonDir: z.string().min(1),
    baseCommit: z.string().min(1),
    originalHead: z.string().min(1),
    originalBranch: z.string().optional(),
    createdAt: z.string(),
    integrationBranch: z.string().min(1),
    integrationWorktreePath: z.string().min(1),
    workspaceRoot: z.string().min(1),
    branchPrefix: z.string().min(1),
    transferStrategy: z.literal("internal-commit")
  }),
  integration: z.object({
    path: z.string().min(1),
    branch: z.string().min(1),
    baseCommit: z.string().min(1),
    headCommit: z.string().min(1),
    status: z.enum(["not_created", "ready", "integration_pending", "validating", "needs_repair", "needs_review", "ready_for_final_review", "blocked"]),
    integratedPhaseIds: z.array(z.string()).default([]),
    conflictingPhaseIds: z.array(z.string()).default([]),
    conflictedFiles: z.array(z.string()).default([])
  }),
  phaseWorkspaces: z.record(z.string(), phaseWorkspaceSchema).default({}),
  integrationValidation: integrationValidationSchema.optional()
});

const planningDiagnosticSchema = z.object({
  stage: z.enum(["syntax", "schema", "quality"]),
  path: z.array(z.union([z.string(), z.number()])),
  code: z.string(),
  message: z.string(),
  contradictionType: z.string().optional(),
  affectedPhase: z.string().optional(),
  effectiveConstraint: z.string().optional(),
  repairAttempt: z.enum(["same-model", "deterministic-normalisation", "none"]).optional(),
  resolution: z.enum(["repaired", "blocked", "fallback"]).optional()
});

const planningAttemptRecordSchema = z.object({
  stage: z.enum(["draft", "normalisation", "semantic-review", "repair", "escalation"]),
  tier: z.enum(["small", "medium", "large", "inherit"]).optional(),
  model: z.string().optional(),
  launchMode: z.string().optional(),
  invocation: z.enum(["not-attempted", "succeeded", "failed"]),
  validation: z.enum(["not-attempted", "passed", "failed"]),
  diagnosticCodes: z.array(z.string()).default([]),
  failureReason: z.string().optional()
});

const workflowStateSchema = z.object({
  version: z.literal(STATE_VERSION),
  id: z.string().min(1),
  revision: z.number().int().min(0),
  state: lifecycleStateSchema,
  request: z.string().min(1),
  root: z.string().min(1),
  mode: z.enum(["fast", "standard", "rigorous"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  triage: triageSchema.optional(),
  triageRun: z.object({
    source: z.enum(["model", "deterministic-fallback"]),
    provider: z.string(),
    model: z.string().optional(),
    attempts: z.number().int(),
    fallbackReason: z.string().optional(),
    warnings: z.array(z.string()),
    evidence: boundedRecord.optional(),
    recommendation: boundedRecord.optional(),
    policyDecision: z.object({
      finalMode: z.enum(["fast", "standard", "rigorous"]),
      overrideReasons: z.array(z.string()),
      fastEligible: z.boolean()
    }).optional(),
    inspection: z.object({
      used: z.boolean(),
      request: boundedRecord.optional(),
      result: boundedRecord.optional(),
      failureReason: z.string().optional()
    }).optional()
  }).optional(),
  constraints: workflowConstraintsSchema.optional(),
  planningRun: z.object({
    source: z.enum(["model", "deterministic-fallback"]),
    provider: z.string(),
    model: z.string().optional(),
    attempts: z.number().int(),
    fallbackReason: z.string().optional(),
    warnings: z.array(z.string()),
    diagnostics: z.array(planningDiagnosticSchema).optional(),
    attemptRecords: z.array(planningAttemptRecordSchema).optional(),
    syntaxRepairApplied: z.boolean().optional(),
    semanticRepairApplied: z.boolean().optional(),
    approvalBlockedReason: z.string().optional()
  }).optional(),
  clarification: z.object({
    question: z.string().min(1),
    reason: z.string().min(1),
    answer: z.string().optional(),
    answeredAt: z.string().optional()
  }).optional(),
  approach: z.object({
    required: z.boolean(),
    approved: z.boolean(),
    proposed: z.string().min(1),
    preferredBecause: z.string().min(1),
    alternatives: z.array(z.string()),
    primaryRisks: z.array(z.string()),
    validationStrategy: z.array(z.string()),
    revisionRequests: z.array(z.object({ feedback: z.string().min(1), timestamp: z.string() })).optional(),
    rejectedReason: z.string().optional()
  }).optional(),
  plan: planSchema.optional(),
  approval: workflowApprovalSchema.optional(),
  phaseBriefs: z.record(z.string(), phaseExecutionBriefSchema).default({}),
  phaseBriefFailures: z.record(z.string(), phaseBriefGenerationFailureSchema).default({}),
  validation: z.array(validationEvidenceSchema),
  review: z.object({
    status: z.enum(["passed", "needs_repair", "needs_replan", "blocked"]),
    summary: z.string(),
    findings: z.array(z.string()),
    repairScope: z.string().optional(),
    reviewedAt: z.string()
  }).optional(),
  commitPlan: z.object({
    generatedAt: z.string(),
    groups: z.array(z.object({
      message: z.string(),
      files: z.array(z.string()),
      rationale: z.string(),
      commands: z.array(z.string())
    })),
    note: z.string()
  }).optional(),
  phaseLeases: z.record(z.string(), phaseLeaseSchema).default({}),
  execution: workflowExecutionStateSchema,
  git: workflowGitStateSchema.optional(),
  repairAttempts: z.number().int().min(0),
  blockers: z.array(z.string()),
  events: z.array(workflowEventSchema).default([])
});

export class WorkflowNotFoundError extends Error {}
export class WorkflowStateError extends Error {}
export class InvalidTransitionError extends Error {}
export class StaleWorkflowError extends Error {}
export class CorruptedWorkflowError extends Error {}

export interface MutationOptions {
  expectedRevision?: number;
  ownerId?: string;
  ownerType?: WorkflowLockOwnerType;
  decisionId?: string;
  operation?: string;
  lockTimeoutSeconds?: number;
}

const DEFAULT_OWNER_ID = "cli";
const DEFAULT_LOCK_TIMEOUT_SECONDS = 30;
const DEFAULT_PHASE_LEASE_TIMEOUT_SECONDS = 900;
const MAX_EVENTS = 200;

export interface FlowStartOptions {
  request: string;
  root: string;
  config: LeanRigorConfig;
  provider?: TriageProvider;
  planningProvider?: PlanningProvider;
  providerSelection?: TriageProviderSelection;
}

export interface ApprovalConstraintChanges {
  add?: string[];
  remove?: string[];
  override?: Array<{ target: string; text: string }>;
}

export async function startFlow(options: FlowStartOptions): Promise<SequentialWorkflowState> {
  const root = path.resolve(options.root);
  const now = timestamp();
  let state: SequentialWorkflowState = {
    version: STATE_VERSION,
    id: workflowId(),
    revision: 0,
    state: "created",
    request: options.request,
    root,
    mode: "standard",
    createdAt: now,
    updatedAt: now,
    validation: [],
    approval: { history: [], decisionHistory: [] },
    phaseLeases: {},
    execution: { records: {} },
    repairAttempts: 0,
    blockers: [],
    events: [workflowEvent({ type: "workflow_created", actorId: "system", before: 0, after: 0, summary: "Workflow created.", at: now })]
  };

  await saveFlowState(root, state, { create: true });
  state = await updateFlowState(root, state.id, (current) => transition(current, "triaging", "Task triage started."));

  const triageRun = await runTriage({
    request: options.request,
    root,
    config: options.config,
    provider: options.provider,
    providerSelection: options.providerSelection
  });

  return updateFlowState(root, state.id, (current) => applyTriageResult(current, triageRun, options.config, {
    planningProvider: options.planningProvider,
    providerSelection: options.providerSelection
  }));
}

export async function answerClarification(args: {
  root: string;
  workflowId: string;
  answer: string;
  config: LeanRigorConfig;
  provider?: TriageProvider;
  planningProvider?: PlanningProvider;
  providerSelection?: TriageProviderSelection;
  mutation?: MutationOptions;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, async (state) => {
    assertState(state, ["awaiting_clarification"]);
    if (!state.clarification) throw new WorkflowStateError("Workflow is awaiting clarification but has no persisted question.");
    const answered = structuredClone(state);
    resolveDecisionAction(answered, "answer", args.mutation, "answered", "clarification");
    answered.clarification = {
      question: state.clarification.question,
      reason: state.clarification.reason,
      answer: args.answer,
      answeredAt: timestamp()
    };
    appendEvent(answered, "clarification_answered", "Blocking clarification answered.");

    const triageRun = await runTriage({
      request: `${answered.request}\n\nClarification answer: ${args.answer}`,
      root: answered.root,
      config: args.config,
      provider: args.provider,
      providerSelection: args.providerSelection
    });
    const next = await applyTriageResult(answered, triageRun, args.config, {
      clarificationAlreadyAnswered: true,
      planningProvider: args.planningProvider,
      providerSelection: args.providerSelection
    });
    return next;
  }, { ...args.mutation, operation: "answer_clarification" });
}

export async function approveApproach(
  root: string,
  workflowId: string,
  config?: LeanRigorConfig,
  mutation?: MutationOptions,
  planning?: { provider?: PlanningProvider; providerSelection?: TriageProviderSelection },
  constraintChanges?: ApprovalConstraintChanges
): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, async (state) => {
    assertState(state, ["awaiting_approach_approval"]);
    if (!state.approach) throw new WorkflowStateError("No approach recommendation is available.");
    const next = structuredClone(state);
    resolveDecisionAction(next, "approve-approach", mutation, "approved", "approach-approval");
    next.constraints = applyApprovalConstraintChanges(next, config ?? defaultConfig(), constraintChanges);
    next.approach = { ...state.approach, approved: true };
    appendEvent(next, "approach_approved", approvalConstraintSummary(next.constraints));
    return withPlan(next, config, planning);
  }, { ...mutation, operation: "approve_approach" });
}

export async function rejectApproach(root: string, workflowId: string, reason: string, mutation?: MutationOptions): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, (state) => {
    assertState(state, ["awaiting_approach_approval"]);
    const next = structuredClone(state);
    next.approach = next.approach ? { ...next.approach, rejectedReason: reason } : undefined;
    next.blockers = [`Approach rejected: ${reason}`];
    return transition(next, "blocked", "Approach rejected; workflow blocked pending a new request or manual restart.");
  }, { ...mutation, operation: "reject_approach" });
}

export async function reviseApproach(root: string, workflowId: string, feedback: string, mutation?: MutationOptions): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, (state) => {
    assertState(state, ["awaiting_approach_approval"]);
    if (!state.approach) throw new WorkflowStateError("No approach recommendation is available.");
    const next = structuredClone(state);
    resolveDecisionAction(next, "revise-approach", mutation, "answered", "approach-approval");
    next.approach = {
      ...state.approach,
      approved: false,
      revisionRequests: [...state.approach.revisionRequests ?? [], { feedback, timestamp: timestamp() }]
    };
    appendEvent(next, "approach_revision_requested", "Approach revision feedback recorded.");
    return transition(next, "awaiting_approach_approval", "Approach revision feedback recorded; approval is still required before planning.");
  }, { ...mutation, operation: "revise_approach" });
}

export async function revisePlan(root: string, workflowId: string, feedback: string, config?: LeanRigorConfig, mutation?: MutationOptions, planning?: { provider?: PlanningProvider; providerSelection?: TriageProviderSelection }): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, async (state) => {
    assertState(state, ["awaiting_plan_approval", "executing", "validating", "reviewing", "blocked"]);
    if (state.state === "blocked" && !state.planningRun?.approvalBlockedReason) throw new WorkflowStateError("Cannot revise this blocked workflow through the plan revision path.");
    if (!state.triage) throw new WorkflowStateError("Cannot revise a plan before triage completes.");
    const next = structuredClone(state);
    resolveDecisionAction(next, "revise-plan", mutation, "answered");
    const triage = state.triage;
    const previousRequests = next.plan?.revisionRequests ?? [];
    const revisionRequests = [...previousRequests, { feedback, timestamp: timestamp() }];
    const planningRun = await generatePlan({
      request: next.request,
      root: next.root,
      triage,
      config,
      constraints: effectiveConstraintTexts(next, triage, config ?? defaultConfig()),
      constraintSet: effectiveConstraintSet(next, triage, config ?? defaultConfig()),
      constraintAudit: next.constraints?.audit ?? [],
      revisionRequests,
      provider: planning?.provider,
      providerSelection: planning?.providerSelection
    });
    next.plan = planningRun.plan;
    next.planningRun = planningRunMetadata(planningRun);
    next.phaseBriefs = {};
    next.phaseBriefFailures = {};
    supersedePendingPhaseApproval(next);
    next.approval = {
      ...(next.approval ?? { history: [], decisionHistory: [] }),
      currentAuthorizedPhase: undefined,
      pendingDecision: undefined,
      recommendation: approvalRecommendation(next)
    };
    appendEvent(next, "planning_completed", planningEventSummary(planningRun));
    next.review = undefined;
    next.commitPlan = undefined;
    next.blockers = [];
    if (planningRun.approvalBlockedReason) {
      next.blockers = [planningRun.approvalBlockedReason];
      return transition(next, "blocked", "Revised planning still requires an explicit planning fallback review before approval.");
    }
    return transition(next, "awaiting_plan_approval", "Plan revised and awaiting approval.");
  }, { ...mutation, operation: "revise_plan" });
}

export async function retryPlanning(root: string, workflowId: string, config?: LeanRigorConfig, mutation?: MutationOptions, planning?: { provider?: PlanningProvider; providerSelection?: TriageProviderSelection }): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, async (state) => {
    assertState(state, ["blocked"]);
    if (!state.planningRun?.approvalBlockedReason) throw new WorkflowStateError("Planning can only be retried through this path after a blocked planning fallback.");
    if (!state.triage) throw new WorkflowStateError("Cannot retry planning before triage completes.");
    const next = structuredClone(state);
    resolveDecisionAction(next, "retry-planning", mutation, "answered", "planning-fallback-review");
    const planningRun = await generatePlan({
      request: next.request,
      root: next.root,
      triage: state.triage,
      config,
      constraints: effectiveConstraintTexts(next, state.triage, config ?? defaultConfig()),
      constraintSet: effectiveConstraintSet(next, state.triage, config ?? defaultConfig()),
      constraintAudit: next.constraints?.audit ?? [],
      revisionRequests: [...(next.approach?.revisionRequests ?? []), ...(next.plan?.revisionRequests ?? [])],
      provider: planning?.provider,
      providerSelection: planning?.providerSelection
    });
    next.plan = planningRun.plan;
    next.planningRun = planningRunMetadata(planningRun);
    next.phaseBriefs = {};
    next.phaseBriefFailures = {};
    supersedePendingPhaseApproval(next);
    next.approval = {
      ...(next.approval ?? { history: [], decisionHistory: [] }),
      currentAuthorizedPhase: undefined,
      pendingDecision: undefined,
      recommendation: approvalRecommendation(next)
    };
    next.review = undefined;
    next.commitPlan = undefined;
    next.blockers = planningRun.approvalBlockedReason ? [planningRun.approvalBlockedReason] : [];
    appendEvent(next, "planning_completed", planningEventSummary(planningRun));
    return planningRun.approvalBlockedReason
      ? transition(next, "blocked", "Planning retry still requires an explicit planning fallback review before approval.")
      : transition(next, "awaiting_plan_approval", "Planning retry completed and is awaiting approval.");
  }, { ...mutation, operation: "retry_planning" });
}

export async function approvePlan(
  root: string,
  workflowId: string,
  mutation?: MutationOptions,
  selectedPolicy?: "workflow-authorized" | "phase-by-phase",
  config: LeanRigorConfig = defaultConfig(),
  briefProvider?: PhaseBriefPlanningProvider
): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, async (state) => {
    if (state.state === "blocked" && state.planningRun?.approvalBlockedReason) {
      throw new WorkflowStateError("This plan cannot be approved because its generic planning fallback requires review. Retry structured planning or revise the Workflow Plan first.");
    }
    assertState(state, ["awaiting_plan_approval"]);
    if (!state.plan) throw new WorkflowStateError("No plan is available for approval.");
    const next = structuredClone(state);
    resolveDecisionAction(next, "approve-plan", mutation, "approved", "workflow-plan-approval");
    const plan = state.plan;
    const recommendation = approvalRecommendation(next);
    const policy = selectedPolicy ?? (recommendation.option === "approve-current-phase" ? "phase-by-phase" : defaultApprovalPolicy(next.mode));
    if (policy === "workflow-authorized" && requiresPhaseByPhase(next, recommendation.reasons)) {
      throw new InvalidTransitionError(`Full-workflow approval is not permitted by ${recommendation.ruleId}; approve the current phase instead.`);
    }
    const approvalRevision = next.revision + 1;
    const now = timestamp();
    next.plan = { ...plan, approvedAt: timestamp() };
    next.plan.phases = plan.phases.map((phase) => ({ ...phase, status: "planned" }));
    next.phaseBriefs = {};
    next.phaseBriefFailures = {};
    next.approval = {
      policy,
      source: selectedPolicy ? "user" : "legacy-default",
      selectedAt: now,
      workflowPlanRevision: approvalRevision,
      recommendation: { ...recommendation, workflowRevision: approvalRevision, createdAt: now },
      history: [{
        policy,
        source: selectedPolicy ? "user" : "legacy-default",
        timestamp: now,
        workflowRevision: approvalRevision,
        recommendation: { ...recommendation, workflowRevision: approvalRevision, createdAt: now },
        recommendationOverridden: policy !== (recommendation.option === "approve-current-phase" ? "phase-by-phase" : "workflow-authorized"),
        action: "plan-approved"
      }],
      decisionHistory: next.approval?.decisionHistory ?? []
    };
    const executing = transition(next, "executing", "Workflow Plan approved. The first Phase Execution Brief requires a separate approval.");
    refreshPhaseReadiness(executing);
    const firstReady = executing.plan?.phases.find((phase) =>
      ["planned", "ready"].includes(phase.status)
      && dependencyIds(phase).every((id) => executing.plan?.phases.find((candidate) => candidate.id === id)?.status === "completed"));
    if (firstReady) {
      const outcome = await generateInspectedPhaseExecutionBrief({
        state: executing,
        phase: firstReady,
        config,
        provider: briefProvider
      });
      persistPhaseBriefOutcome(executing, firstReady, outcome, true);
      executing.approval!.recommendation = approvalRecommendation(executing, firstReady.id);
    }
    return executing;
  }, { ...mutation, operation: "approve_plan" });
}

export async function preparePhaseExecutionBrief(args: {
  root: string;
  workflowId: string;
  phaseId: string;
  config?: LeanRigorConfig;
  provider?: PhaseBriefPlanningProvider;
  feedback?: string;
  refresh?: boolean;
  requireApproval?: boolean;
  mutation?: MutationOptions;
}): Promise<SequentialWorkflowState> {
  if (!args.feedback && !args.refresh) {
    const current = await loadFlowState(args.root, args.workflowId);
    if (current.phaseBriefs?.[args.phaseId] && briefIsCurrent(current, args.phaseId)) return current;
  }
  return updateFlowState(args.root, args.workflowId, async (state) => {
    assertState(state, ["executing"]);
    const phase = state.plan?.phases.find((candidate) => candidate.id === args.phaseId);
    if (!phase) throw new WorkflowStateError(`Unknown phase: ${args.phaseId}`);
    if (!["planned", "ready"].includes(phase.status)) throw new InvalidTransitionError(`Phase ${phase.id} is ${phase.status}; only an unstarted phase can receive an execution brief.`);
    const next = structuredClone(state);
    if (
      args.feedback
      && ["phase-brief-approval", "material-drift-review"].includes(next.approval?.pendingDecision?.type ?? "")
    ) {
      resolveDecisionAction(
        next,
        "revise-phase-brief",
        args.mutation,
        "superseded",
        next.approval?.pendingDecision?.type
      );
    }
    const current = next.phaseBriefs?.[phase.id];
    if (current) current.approvalStatus = "stale";
    if (next.approval?.currentAuthorizedPhase === phase.id) next.approval.currentAuthorizedPhase = undefined;
    supersedePendingPhaseApproval(next);
    const outcome = await generateInspectedPhaseExecutionBrief({
      state: next,
      phase,
      config: args.config ?? defaultConfig(),
      previous: current,
      feedback: args.feedback,
      provider: args.provider
    });
    const requiresApproval = args.requireApproval === true
      || next.approval?.policy === "phase-by-phase"
      || !next.approval?.history.some((entry) => entry.action === "phase-approved");
    persistPhaseBriefOutcome(next, phase, outcome, requiresApproval);
    return next;
  }, { ...args.mutation, operation: "phase_brief_prepare" });
}

export async function approvePhase(args: {
  root: string;
  workflowId: string;
  phaseId: string;
  briefRevision: number;
  workflowRevision: number;
  mutation?: MutationOptions;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, (state) => {
    assertState(state, ["executing"]);
    const phase = state.plan?.phases.find((candidate) => candidate.id === args.phaseId);
    const brief = state.phaseBriefs?.[args.phaseId];
    const decision = state.approval?.pendingDecision;
    if (brief?.materialChangesFromWorkflowPlan.some((change) => change.material)) {
      throw new InvalidTransitionError(
        `Phase ${args.phaseId} brief revision ${brief.briefRevision} contains unresolved material changes from the approved Workflow Plan. Revise the Workflow Plan or revise the Phase Execution Brief to remain within the approved plan before phase approval.`
      );
    }
    requirePendingDecision(state, "phase-brief-approval", "approve-phase", args.mutation?.decisionId);
    if (!phase || !["planned", "ready"].includes(phase.status) || !dependencyIds(phase).every((id) => state.plan?.phases.find((candidate) => candidate.id === id)?.status === "completed")) {
      throw new InvalidTransitionError(`Phase ${args.phaseId} is not dependency-ready for approval.`);
    }
    if (
      !decision
      || decision.type !== "phase-brief-approval"
      || decision.status !== "pending"
      || decision.phaseId !== args.phaseId
      || decision.briefRevision !== args.briefRevision
      || decision.workflowRevision !== args.workflowRevision
    ) {
      throw new InvalidTransitionError(`Phase ${args.phaseId} has no pending approval decision for workflow revision ${args.workflowRevision} and brief revision ${args.briefRevision}.`);
    }
    if (!brief || !briefIsCurrent(state, args.phaseId) || brief.briefRevision !== args.briefRevision) throw new InvalidTransitionError(`Phase ${args.phaseId} has no current execution brief revision ${args.briefRevision}.`);
    if (brief.workflowRevision !== args.workflowRevision || state.approval?.workflowPlanRevision !== args.workflowRevision) {
      throw new InvalidTransitionError(`Phase ${args.phaseId} brief revision ${args.briefRevision} does not belong to workflow revision ${args.workflowRevision}.`);
    }
    const next = structuredClone(state);
    const now = timestamp();
    next.approval!.currentAuthorizedPhase = args.phaseId;
    resolvePendingDecision(next, "approved", "approve-phase", args.mutation?.decisionId ? "controller" : "user", args.mutation?.decisionId);
    next.phaseBriefs![args.phaseId] = { ...brief, approvalStatus: "approved" };
    const recommendation = approvalRecommendation(next, args.phaseId);
    next.approval!.recommendation = recommendation;
    next.approval!.history.push({
      policy: next.approval!.policy ?? "phase-by-phase",
      source: "user",
      timestamp: now,
      workflowRevision: next.revision + 1,
      phaseId: args.phaseId,
      briefRevision: brief.briefRevision,
      recommendation,
      recommendationOverridden: false,
      action: "phase-approved"
    });
    appendEvent(next, "phase_execution_approved", `Phase ${args.phaseId} brief revision ${brief.briefRevision} approved.`, args.phaseId);
    return next;
  }, { ...args.mutation, operation: "approve_phase" });
}

export async function approveWorkspaceBootstrap(args: {
  root: string;
  workflowId: string;
  phaseId: string;
  briefRevision: number;
  preparationRevision: number;
  workspaceIdentity: string;
  command: string;
  mutation?: MutationOptions;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, (state) => {
    assertState(state, ["executing"]);
    const decision = state.approval?.pendingDecision;
    requirePendingDecision(state, "workspace-bootstrap-approval", "approve-bootstrap", args.mutation?.decisionId);
    if (
      !decision
      || decision.type !== "workspace-bootstrap-approval"
      || decision.status !== "pending"
      || decision.phaseId !== args.phaseId
      || decision.briefRevision !== args.briefRevision
      || decision.preparationRevision !== args.preparationRevision
      || decision.workspaceIdentity !== args.workspaceIdentity
      || decision.command !== args.command
    ) {
      throw new InvalidTransitionError(`Phase ${args.phaseId} has no exact pending bootstrap approval for preparation revision ${args.preparationRevision}.`);
    }
    const brief = state.phaseBriefs?.[args.phaseId];
    const workspace = state.git?.phaseWorkspaces[args.phaseId];
    if (!brief || brief.briefRevision !== args.briefRevision || !briefIsCurrent(state, args.phaseId)) {
      throw new InvalidTransitionError(`Phase ${args.phaseId} bootstrap approval does not reference the current approved brief.`);
    }
    if (!workspace?.preparation || workspace.preparation.preparationRevision !== args.preparationRevision || workspace.preparation.workspaceIdentity !== args.workspaceIdentity) {
      throw new InvalidTransitionError(`Phase ${args.phaseId} workspace preparation identity changed before bootstrap approval.`);
    }
    resolvePendingDecision(state, "approved", "approve-bootstrap", args.mutation?.decisionId ? "controller" : "user", args.mutation?.decisionId);
    appendEvent(state, "workspace_bootstrap_approved", `Phase ${args.phaseId} preparation revision ${args.preparationRevision} bootstrap command approved.`, args.phaseId);
    return state;
  }, { ...args.mutation, operation: "workspace_bootstrap_approve" });
}

export async function startPhase(root: string, workflowId: string, phaseId?: string, mutation?: MutationOptions & { config?: LeanRigorConfig; internalCapability?: symbol }): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, (state) => {
    assertState(state, ["executing"]);
    const next = structuredClone(state);
    if (!phaseId) throw new InvalidTransitionError("Starting a phase requires an explicit phase ID.");
    const trustedInternal = mutation?.internalCapability === TRUSTED_INTERNAL_PHASE_EXECUTION_CAPABILITY;
    if (!trustedInternal) {
      const eligibility = evaluatePhaseDispatchEligibility(next, phaseId, mutation?.config, {
        explicitlySelected: true,
        ownerId: mutation?.ownerId
      });
      if (!eligibility.eligible) throw new InvalidTransitionError(formatDispatchBlockers(eligibility.blockers));
    }
    const phase = selectStartablePhase(next, phaseId);
    const ownerId = mutation?.ownerId ?? DEFAULT_OWNER_ID;
    phase.status = "running";
    phase.startedAt = phase.startedAt ?? timestamp();
    next.phaseLeases[phase.id] = phaseLease(phase, ownerId, mutation?.ownerType ?? "cli", next.revision, mutation?.config?.execution.phaseLeaseTimeoutSeconds ?? DEFAULT_PHASE_LEASE_TIMEOUT_SECONDS);
    appendEvent(next, "phase_started", `Phase ${phase.id} leased and started by ${ownerId}.`, phase.id);
    return next;
  }, { ...mutation, operation: "phase_start" });
}

export async function completePhase(args: {
  root: string;
  workflowId: string;
  phaseId: string;
  config?: LeanRigorConfig;
  criteria?: CriterionCompletionEvidence[];
  filesChanged?: string[];
  commandsRun?: string[];
  validation?: ValidationEvidence[];
  scopeDeviations?: string[];
  assumptions?: string[];
  remainingRisks?: string[];
  evidenceArtifact?: PhaseCompletionRecord["evidenceArtifact"];
  blockedReason?: string;
  requestedRepairScope?: string;
  modelDecision?: CompletionGateDecision;
  mutation?: MutationOptions;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, async (state) => {
    assertState(state, ["executing"]);
    if (!state.plan) throw new WorkflowStateError("Cannot complete a phase without a plan.");
    const next = structuredClone(state);
    const plan = next.plan;
    if (!plan) throw new WorkflowStateError("Cannot complete a phase without a plan.");
    const phase = plan.phases.find((candidate) => candidate.id === args.phaseId);
    if (!phase) throw new WorkflowStateError(`Unknown phase: ${args.phaseId}`);
    const ownerId = args.mutation?.ownerId ?? DEFAULT_OWNER_ID;
    const lease = next.phaseLeases[phase.id];
    if (phase.status !== "running" && phase.status !== "leased") throw new InvalidTransitionError(`Phase ${phase.id} is ${phase.status}; only a leased or running phase can enter the completion gate.`);
    if (!lease || lease.releasedAt || lease.ownerId !== ownerId || Date.parse(lease.expiresAt) <= Date.now()) {
      throw new InvalidTransitionError(`Phase ${phase.id} completion requires an active lease held by ${ownerId}.`);
    }
    if (lease.ownerType === "agent" && args.mutation?.ownerType !== "system") {
      throw new InvalidTransitionError(`Phase ${phase.id} is owned by an execution provider; completion must be submitted through the coordinator.`);
    }
    const inspected = await inspectPhaseWorkspaceChanges(next, phase, ownerId);
    phase.status = "completion_pending";
    phase.filesChanged = unique([...phase.filesChanged, ...(args.filesChanged ?? []), ...(inspected?.changedFiles ?? [])]);
    phase.commandsRun = [...phase.commandsRun, ...(args.commandsRun ?? [])];
    for (const evidence of args.validation ?? []) {
      validateWorkflowEvidence(evidence);
      next.validation.push(evidence);
      phase.validationResults.push(evidence);
    }
    const detectedDeviations = detectScopeDeviations(phase, args.config);
    phase.scopeDeviations = unique([...phase.scopeDeviations, ...(args.scopeDeviations ?? []), ...detectedDeviations]);

    const completion = buildCompletionRecord({
      state: next,
      phase,
      criteria: args.criteria,
      assumptions: args.assumptions,
      remainingRisks: args.remainingRisks,
      evidenceArtifact: args.evidenceArtifact,
      blockedReason: args.blockedReason,
      requestedRepairScope: args.requestedRepairScope,
      config: args.config,
      leaseOwnerId: ownerId
    });
    phase.completion = completion;
    phase.status = completion.decision;
    if (completion.decision === "completed") {
      const gitEvidence = await captureApprovedPhaseChange(next, phase, ownerId, args.config ?? defaultConfig());
      if (gitEvidence) {
        completion.gitEvidence = gitEvidence;
        phase.filesChanged = unique([...phase.filesChanged, ...gitEvidence.changedFiles]);
        completion.filesChanged = phase.filesChanged;
        if (next.git?.phaseWorkspaces[phase.id]) {
          next.git.phaseWorkspaces[phase.id] = { ...next.git.phaseWorkspaces[phase.id], status: "approved", updatedAt: timestamp() };
        }
      }
      phase.completedAt = timestamp();
      next.phaseLeases[phase.id] = { ...lease, releasedAt: timestamp() };
      if (next.git?.integration) next.git.integration.status = "integration_pending";
    }
    const repair = phase.repairAttempts.at(-1);
    if (repair && !repair.outcome) {
      repair.validation = phase.validationResults;
      repair.outcome = completion.decision;
    }
    appendEvent(
      next,
      "phase_completion_gate_evaluated",
      completion.decision === "completed"
        ? `Phase ${phase.id} completion gate passed. Phase accepted; integration has not completed.`
        : `Phase ${phase.id} completion gate did not pass: ${completion.decision}. ${completion.reason}`,
      phase.id
    );

    if (completion.decision === "blocked") {
      next.blockers = [completion.reason];
      return transition(next, "blocked", `Phase ${phase.id} is blocked.`);
    }
    if (completion.decision !== "completed") {
      setPendingDecision(next, {
        type: "execution-recovery",
        phaseId: phase.id,
        briefRevision: next.phaseBriefs?.[phase.id]?.briefRevision,
        question: completion.reason,
        allowedActions: ["view-details", "retry-execution", "revise-plan", "cancel-workflow"]
      });
      return next;
    }

    if (next.approval?.currentAuthorizedPhase === phase.id) {
      next.approval.currentAuthorizedPhase = undefined;
    }
    appendEvent(next, "phase_accepted", `Phase ${phase.id} accepted by the deterministic completion gate. Integration is pending.`, phase.id);
    if (!next.git && plan.phases.every((candidate) => candidate.status === "completed")) {
      return transition(next, "validating", "All phase completion gates passed without a configured integration workspace; final validation is required.");
    }
    return next;
  }, { ...args.mutation, operation: "phase_complete" });
}

export interface EvidenceTemplate {
  phaseId: string;
  objective: string;
  criteria: Array<{ criterion: string; status: string; evidence: string[] }>;
  filesChanged: string[];
  commandsRun: string[];
  validation: Array<{ command: string; exitStatus: number | null; result: string; status: string; skipped: boolean; skippedReason?: string; timestamp: string }>;
  scopeDeviations: string[];
  assumptions: string[];
  remainingRisks: string[];
  blockedReason?: string;
  requestedRepairScope?: string;
  modelDecision?: string;
  _instructions: Record<string, string>;
}

export function getEvidenceTemplate(phase: WorkflowPhase): EvidenceTemplate {
  return {
    phaseId: phase.id,
    objective: phase.objective,
    criteria: phase.acceptanceCriteria.map((criterion) => ({
      criterion,
      status: "met",
      evidence: ["<describe the concrete evidence that proves this criterion is satisfied>"]
    })),
    filesChanged: phase.filesChanged.length > 0 ? phase.filesChanged : ["<list every file changed in this phase>"],
    commandsRun: phase.validationCommands.length > 0 ? phase.validationCommands : ["<list every command run during this phase>"],
    validation: phase.validationCommands.length > 0
      ? phase.validationCommands.map((command) => ({
          command,
          exitStatus: 0,
          result: "<command output summary>",
          status: "passed",
          skipped: false,
          timestamp: new Date().toISOString()
        }))
      : [{
          command: "<validation command>",
          exitStatus: 0,
          result: "<command output summary>",
          status: "passed",
          skipped: false,
          timestamp: new Date().toISOString()
        }],
    scopeDeviations: ["<list any files changed outside expected areas, or remove this entry if none>"],
    assumptions: ["<list any assumptions made during execution, or remove this entry if none>"],
    remainingRisks: ["<list any remaining risks, or remove this entry if none>"],
    _instructions: {
      criteria: "Each acceptance criterion must have status 'met', 'not_met', 'uncertain', or 'not_applicable' with concrete evidence strings.",
      filesChanged: "List every file path changed. Required.",
      commandsRun: "List every command run. Required.",
      validation: "Each validation entry requires command, exitStatus (number or null if skipped), result, status ('passed'|'failed'|'skipped'), skipped (boolean), and timestamp (ISO string). Skipped entries require skippedReason.",
      scopeDeviations: "List any files changed outside the phase expected areas. Remove this entry if there are no scope deviations.",
      assumptions: "List assumptions introduced during execution. Remove this entry if none.",
      remainingRisks: "List risks that remain after this phase. Remove this entry if none."
    }
  };
}

export async function repairPhase(args: {
  root: string;
  workflowId: string;
  phaseId: string;
  reason: string;
  requestedScope?: string;
  config: LeanRigorConfig;
  mutation?: MutationOptions;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, (state) => {
    assertState(state, ["executing"]);
    if (!state.plan) throw new WorkflowStateError("Cannot repair a phase without a plan.");
    const next = structuredClone(state);
    const plan = next.plan;
    if (!plan) throw new WorkflowStateError("Cannot repair a phase without a plan.");
    const phase = phaseById(plan, args.phaseId);
    if (!phase) throw new WorkflowStateError(`Unknown phase: ${args.phaseId}`);
    if (phase.status !== "needs_repair") throw new InvalidTransitionError(`Phase ${phase.id} is ${phase.status}; only needs_repair can be repaired.`);
    const budget = args.config.completionGate.maxRepairAttempts[next.mode];
    if (phase.repairAttempts.length >= budget) {
      phase.status = "needs_review";
      if (phase.completion) {
        phase.completion.decision = "needs_review";
        phase.completion.dependentPhasesMayProceed = false;
        phase.completion.reason = `Repair budget exhausted after ${phase.repairAttempts.length} attempt(s).`;
      }
      appendEvent(next, "phase_repair_exhausted", `Phase ${phase.id} repair budget exhausted.`, phase.id);
      return next;
    }
    const attempt: PhaseRepairAttempt = {
      attempt: phase.repairAttempts.length + 1,
      reason: args.reason,
      requestedScope: args.requestedScope ?? phase.completion?.reason ?? "Repair the bounded completion-gate issue.",
      validation: [],
      timestamp: timestamp()
    };
    phase.repairAttempts.push(attempt);
    const ownerId = args.mutation?.ownerId ?? DEFAULT_OWNER_ID;
    phase.status = "running";
    phase.startedAt = timestamp();
    phase.completedAt = undefined;
    next.phaseLeases[phase.id] = phaseLease(phase, ownerId, args.mutation?.ownerType ?? "cli", next.revision, args.config.execution.phaseLeaseTimeoutSeconds);
    appendEvent(next, "phase_repair_started", `Phase ${phase.id} repair attempt ${attempt.attempt}/${budget} started.`, phase.id);
    return next;
  }, { ...args.mutation, operation: "repair_phase" });
}

export async function recordValidation(args: {
  root: string;
  workflowId: string;
  phaseId?: string;
  command: string;
  exitStatus?: number | null;
  result: string;
  skipped?: boolean;
  skippedReason?: string;
  mutation?: MutationOptions;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, (state) => {
    assertState(state, ["executing", "validating", "reviewing"]);
    const evidence: ValidationEvidence = {
      phaseId: args.phaseId,
      command: args.command,
      exitStatus: args.skipped ? null : args.exitStatus ?? 0,
      result: args.result,
      status: args.skipped ? "skipped" : (args.exitStatus ?? 0) === 0 ? "passed" : "failed",
      skipped: args.skipped ?? false,
      skippedReason: args.skippedReason,
      timestamp: timestamp()
    };
    validateWorkflowEvidence(evidence);
    const next = structuredClone(state);
    next.validation.push(evidence);
    const phase = args.phaseId && next.plan ? phaseById(next.plan, args.phaseId) : undefined;
    if (phase) phase.validationResults.push(evidence);
    appendEvent(next, "validation_recorded", `Validation recorded: ${evidence.command} (${evidence.status}).`, evidence.phaseId);
    return next;
  }, { ...args.mutation, operation: "record_validation" });
}

export async function recordReview(args: {
  root: string;
  workflowId: string;
  status: IntegratedReviewResult["status"];
  summary: string;
  findings?: string[];
  repairScope?: string;
  config: LeanRigorConfig;
  mutation?: MutationOptions;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, (state) => {
    assertState(state, ["validating", "reviewing"]);
    if (!state.plan || state.plan.phases.some((phase) => phase.status !== "completed")) {
      throw new InvalidTransitionError("Final review requires all phases to be completed.");
    }
    if (state.git) {
      const status = buildIntegrationStatus(state);
      if (!status.finalReviewEligible) {
        throw new InvalidTransitionError("Final review requires every completed phase to be integrated and combined validation to pass on the current integration head.");
      }
    }
    if (!hasValidationEvidence(state)) {
      throw new InvalidTransitionError("Final review requires persisted validation evidence or an explicit skipped-validation reason.");
    }
    const next = structuredClone(state);
    resolveDecisionAction(next, "record-review", args.mutation, "answered", "final-review");
    next.review = {
      status: args.status,
      summary: args.summary,
      findings: args.findings ?? [],
      repairScope: args.repairScope,
      reviewedAt: timestamp()
    };

    if (args.status === "passed") {
      next.commitPlan = buildCommitPlan(next);
      return transition(next, "awaiting_commit_approval", "Integrated review passed; commit proposal is ready.");
    }
    if (args.status === "needs_repair") {
      const budget = args.config.budgets.repairRounds;
      if (next.repairAttempts >= budget) {
        next.blockers = [`Repair budget exhausted after ${next.repairAttempts} repair attempt(s).`];
        return transition(next, "blocked", "Integrated review still needs repair and the repair budget is exhausted.");
      }
      next.repairAttempts += 1;
      appendRepairPhase(next, args.repairScope ?? "Address the integrated review findings.");
      return transition(next, "executing", "Integrated review requested repair; a repair phase is ready.");
    }
    if (args.status === "needs_replan") {
      next.blockers = ["Integrated review requires replanning before more execution."];
      return transition(next, "awaiting_plan_approval", "Integrated review requested replanning.");
    }
    next.blockers = args.findings?.length ? args.findings : [args.summary];
    return transition(next, "blocked", "Integrated review blocked the workflow.");
  }, { ...args.mutation, operation: "record_review" });
}

export async function getCommitPlan(root: string, workflowId: string): Promise<CommitPlan> {
  const state = await loadFlowState(root, workflowId);
  if (state.state !== "awaiting_commit_approval" || !state.commitPlan) {
    throw new InvalidTransitionError(`Workflow ${workflowId} is ${state.state}; commit proposal is available only after review passes.`);
  }
  return state.commitPlan;
}

export async function completeFlow(root: string, workflowId: string, mutation?: MutationOptions): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, (state) => {
    assertState(state, ["awaiting_commit_approval"]);
    const next = structuredClone(state);
    resolveDecisionAction(next, "complete-workflow", mutation, "approved", "final-completion");
    return transition(next, "completed", "Final integrated review passed and the user approved workflow completion. No commit was executed.");
  }, { ...mutation, operation: "complete_flow" });
}

export async function cancelFlow(root: string, workflowId: string, mutation?: MutationOptions): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, (state) => {
    if (["completed", "cancelled"].includes(state.state)) throw new InvalidTransitionError(`Workflow is already ${state.state}.`);
    const next = structuredClone(state);
    resolveDecisionAction(next, "cancel-workflow", mutation, "cancelled");
    return transition(next, "cancelled", "Workflow cancelled by user.");
  }, { ...mutation, operation: "cancel_flow" });
}

export async function resumeFlow(root: string, workflowId: string): Promise<SequentialWorkflowState> {
  return loadFlowState(root, workflowId);
}

export function readyPhases(state: SequentialWorkflowState, config?: LeanRigorConfig) {
  return calculateReadyPhases(state, config);
}

export async function gitPreflight(root: string, config: LeanRigorConfig): Promise<GitPreflightResult> {
  return preflightGitRepository(root, config);
}

export async function workspaceInit(args: {
  root: string;
  workflowId: string;
  config: LeanRigorConfig;
  mutation?: MutationOptions;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, async (state) => {
    const next = structuredClone(state);
    next.git = await ensureIntegrationWorkspace(next, args.config);
    appendEvent(next, "workspace_initialized", "LeanRigor integration worktree initialized.");
    return next;
  }, { ...args.mutation, operation: "workspace_init" });
}

export async function workspaceCreatePhase(args: {
  root: string;
  workflowId: string;
  phaseId: string;
  ownerId: string;
  config: LeanRigorConfig;
  mutation?: MutationOptions;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, async (state) => {
    const next = structuredClone(state);
    next.git = next.git ?? await ensureIntegrationWorkspace(next, args.config);
    next.git = await createPhaseWorkspace(next, args.phaseId, args.ownerId, args.config);
    const phase = next.plan?.phases.find((candidate) => candidate.id === args.phaseId);
    if (phase) {
      phase.workspace = next.git.phaseWorkspaces[args.phaseId];
      if (phase.status === "leased") phase.status = "running";
    }
    appendEvent(next, "phase_workspace_created", `Phase ${args.phaseId} workspace is ready for ${args.ownerId}.`, args.phaseId, args.ownerId);
    return next;
  }, { ...args.mutation, ownerId: args.mutation?.ownerId ?? args.ownerId, operation: "workspace_create_phase" });
}

export async function workspaceStatus(root: string, workflowId: string, config: LeanRigorConfig): Promise<WorkspaceStatus> {
  return buildWorkspaceStatus(await loadFlowState(root, workflowId), config);
}

export async function integratePhase(args: {
  root: string;
  workflowId: string;
  phaseId: string;
  ownerId: string;
  config?: LeanRigorConfig;
  briefProvider?: PhaseBriefPlanningProvider;
  mutation?: MutationOptions;
}): Promise<IntegrationOperationResult> {
  let operation: Omit<IntegrationOperationResult, "state"> | undefined;
  const state = await updateFlowState(args.root, args.workflowId, async (current) => {
    const applied = await applyApprovedPhaseToIntegration(current, args.phaseId);
    operation = applied.result;
    if (applied.result.code === "already_integrated") return current;
    const next = applied.state;
    appendEvent(
      next,
      applied.result.ok ? "phase_integrated" : "phase_integration_conflict",
      applied.result.ok
        ? `Phase ${args.phaseId} integrated into the LeanRigor integration worktree.`
        : `Phase ${args.phaseId} integration conflict detected.`,
      args.phaseId,
      args.ownerId
    );
    if (applied.result.ok && next.plan && next.git) {
      const integratedIds = new Set(next.git.integration.integratedPhaseIds);
      const nextPhase = next.plan.phases.find((phase) =>
        ["planned", "ready"].includes(phase.status)
        && dependencyIds(phase).every((id) => phaseById(next.plan!, id)?.status === "completed" && integratedIds.has(id)));
      if (nextPhase && (!next.phaseBriefs?.[nextPhase.id] || !briefIsCurrent(next, nextPhase.id))) {
        const outcome = await generateInspectedPhaseExecutionBrief({
          state: next,
          phase: nextPhase,
          config: args.config ?? defaultConfig(),
          provider: args.briefProvider
        });
        const requiresApproval = next.approval?.policy === "phase-by-phase"
          || !next.approval?.history.some((entry) => entry.action === "phase-approved");
        persistPhaseBriefOutcome(next, nextPhase, outcome, requiresApproval);
        next.approval!.recommendation = approvalRecommendation(next, nextPhase.id);
        appendEvent(next, "next_phase_preflight_created", `Phase ${nextPhase.id} brief was generated after dependency integration completed.`, nextPhase.id, args.ownerId);
      }
    }
    return next;
  }, { ...args.mutation, ownerId: args.mutation?.ownerId ?? args.ownerId, operation: "integrate_phase" });
  return { ...(operation ?? { ok: false, code: "integration_rejected", phaseId: args.phaseId }), state } as IntegrationOperationResult;
}

export function integrationStatus(state: SequentialWorkflowState) {
  return buildIntegrationStatus(state);
}

export async function validateIntegration(args: {
  root: string;
  workflowId: string;
  mutation?: MutationOptions;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, async (state) => {
    let current = state;
    if (current.state === "executing" && current.plan && current.git) {
      const integrated = new Set(current.git.integration.integratedPhaseIds);
      const allAcceptedAndIntegrated = current.plan.phases.length > 0
        && current.plan.phases.every((phase) => phase.status === "completed" && integrated.has(phase.id));
      if (allAcceptedAndIntegrated) {
        current = transition(current, "validating", "All accepted phases are integrated; final integrated validation is running.");
      }
    }
    const next = await runIntegrationValidation(current);
    next.validation.push(...(next.git?.integrationValidation?.commands ?? []));
    appendEvent(next, "integration_validation_recorded", `Combined integration validation ${next.git?.integrationValidation?.status ?? "recorded"}.`);
    if (next.git?.integrationValidation?.status === "passed" && next.state === "validating") return transition(next, "reviewing", "Combined integration validation passed; final integrated review is ready.");
    if (next.git?.integrationValidation?.status === "failed") {
      setPendingDecision(next, {
        type: "execution-recovery",
        question: `Combined integration validation failed (${next.git.integrationValidation.failureOwnership ?? "validation_failure"}). An identical retry is disabled until the repository, environment, or validation strategy changes.`,
        allowedActions: ["view-details", "revise-plan", "cancel-workflow"]
      });
    }
    return next;
  }, { ...args.mutation, operation: "validate_integration" });
}

export async function workspaceCleanup(args: {
  root: string;
  workflowId: string;
  mode?: "safe" | "force-owned" | "archive";
  mutation?: MutationOptions;
}): Promise<WorkspaceCleanupReport> {
  let report: WorkspaceCleanupReport | undefined;
  await updateFlowState(args.root, args.workflowId, async (current) => {
    report = await cleanupOwnedWorkspaces(current, args.mode ?? "safe");
    const next = structuredClone(current);
    if (next.git) {
      const removed = new Set(report.removedWorktrees);
      for (const [phaseId, workspace] of Object.entries(next.git.phaseWorkspaces)) {
        if (!removed.has(workspace.path)) continue;
        delete next.git.phaseWorkspaces[phaseId];
        const phase = next.plan?.phases.find((candidate) => candidate.id === phaseId);
        if (phase) phase.workspace = undefined;
      }
    }
    appendEvent(next, "workspace_cleanup", `Workspace cleanup removed ${report.removedWorktrees.length} worktree(s).`);
    return next;
  }, { ...args.mutation, operation: "workspace_cleanup" });
  return report ?? { workflowId: args.workflowId, mode: args.mode ?? "safe", removedWorktrees: [], retainedWorktrees: [], removedBranches: [], needsReview: [] };
}

export async function workspaceRecover(args: {
  root: string;
  workflowId: string;
  mutation?: MutationOptions;
}): Promise<WorkspaceRecoveryReport> {
  let report: WorkspaceRecoveryReport | undefined;
  const state = await updateFlowState(args.root, args.workflowId, async (current) => {
    report = await recoverWorkspaceState(current);
    for (const fact of report.facts) appendEvent(report.state, "workspace_recovery_fact", fact);
    return report.state;
  }, { ...args.mutation, operation: "workspace_recover" });
  return { ...(report ?? { workflowId: args.workflowId, facts: [], needsReview: [], state }), state };
}

export async function leasePhase(args: {
  root: string;
  workflowId: string;
  phaseId: string;
  ownerId: string;
  ownerType?: WorkflowLockOwnerType;
  config?: LeanRigorConfig;
  mutation?: MutationOptions;
  internalCapability?: symbol;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, (state) => {
    assertState(state, ["executing"]);
    if (!state.plan) throw new WorkflowStateError("Cannot lease a phase without a plan.");
    const phase = phaseById(state.plan, args.phaseId);
    if (!phase) throw new WorkflowStateError(`Unknown phase: ${args.phaseId}`);
    const existing = state.phaseLeases[phase.id];
    if (existing && !existing.releasedAt && Date.parse(existing.expiresAt) > Date.now()) {
      throw new InvalidTransitionError(`Phase ${phase.id} already has an active lease held by ${existing.ownerId}.`);
    }
    const preparationLease = args.internalCapability === PHASE_PREPARATION_CAPABILITY;
    const eligibility = evaluatePhaseDispatchEligibility(state, phase.id, args.config, {
      stage: preparationLease ? "preparation" : "dispatch",
      explicitlySelected: true,
      ownerId: args.ownerId
    });
    if (!eligibility.eligible) throw new InvalidTransitionError(formatDispatchBlockers(eligibility.blockers));
    if (!["planned", "ready"].includes(phase.status)) throw new InvalidTransitionError(`Phase ${phase.id} is ${phase.status}; only an unstarted eligible phase can be leased.`);
    phase.status = "leased";
    state.phaseLeases[phase.id] = phaseLease(phase, args.ownerId, args.ownerType ?? "cli", state.revision, args.config?.execution.phaseLeaseTimeoutSeconds ?? DEFAULT_PHASE_LEASE_TIMEOUT_SECONDS);
    appendEvent(state, "phase_lease_acquired", `Phase ${phase.id} leased by ${args.ownerId}.`, phase.id, args.ownerId);
    return state;
  }, { ...args.mutation, ownerId: args.mutation?.ownerId ?? args.ownerId, ownerType: args.ownerType ?? args.mutation?.ownerType, operation: "lease_phase" });
}

export async function heartbeatPhase(args: {
  root: string;
  workflowId: string;
  phaseId: string;
  ownerId: string;
  config?: LeanRigorConfig;
  mutation?: MutationOptions;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, (state) => {
    const lease = state.phaseLeases[args.phaseId];
    if (!lease || lease.releasedAt) throw new InvalidTransitionError(`Phase ${args.phaseId} has no active lease.`);
    if (lease.ownerId !== args.ownerId) throw new InvalidTransitionError(`Phase ${args.phaseId} lease is owned by ${lease.ownerId}, not ${args.ownerId}.`);
    const now = timestamp();
    lease.heartbeatAt = now;
    lease.expiresAt = new Date(Date.parse(now) + (args.config?.execution.phaseLeaseTimeoutSeconds ?? DEFAULT_PHASE_LEASE_TIMEOUT_SECONDS) * 1000).toISOString();
    appendEvent(state, "phase_lease_refreshed", `Phase ${args.phaseId} lease refreshed by ${args.ownerId}.`, args.phaseId, args.ownerId);
    return state;
  }, { ...args.mutation, ownerId: args.mutation?.ownerId ?? args.ownerId, operation: "heartbeat_phase" });
}

export async function releasePhase(args: {
  root: string;
  workflowId: string;
  phaseId: string;
  ownerId: string;
  mutation?: MutationOptions;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, (state) => {
    if (!state.plan) throw new WorkflowStateError("Cannot release a phase without a plan.");
    const phase = phaseById(state.plan, args.phaseId);
    if (!phase) throw new WorkflowStateError(`Unknown phase: ${args.phaseId}`);
    const lease = state.phaseLeases[args.phaseId];
    if (!lease || lease.releasedAt) throw new InvalidTransitionError(`Phase ${args.phaseId} has no active lease.`);
    if (lease.ownerId !== args.ownerId) throw new InvalidTransitionError(`Phase ${args.phaseId} lease is owned by ${lease.ownerId}, not ${args.ownerId}.`);
    state.phaseLeases[args.phaseId] = { ...lease, releasedAt: timestamp() };
    if (phase.status === "leased" || phase.status === "running") phase.status = "ready";
    appendEvent(state, "phase_lease_released", `Phase ${args.phaseId} lease released by ${args.ownerId}.`, args.phaseId, args.ownerId);
    return state;
  }, { ...args.mutation, ownerId: args.mutation?.ownerId ?? args.ownerId, operation: "release_phase" });
}

export async function recoverLeases(args: {
  root: string;
  workflowId: string;
  now?: Date;
  mutation?: MutationOptions;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, (state) => {
    if (!state.plan) return state;
    const nowMs = (args.now ?? new Date()).getTime();
    for (const phase of state.plan.phases) {
      const lease = state.phaseLeases[phase.id];
      if (!lease || lease.releasedAt || Date.parse(lease.expiresAt) > nowMs) continue;
      const recoveredAt = new Date(nowMs).toISOString();
      state.phaseLeases[phase.id] = { ...lease, releasedAt: recoveredAt };
      if (phase.completion && phase.status !== "completed") {
        phase.status = "needs_review";
        appendEvent(state, "phase_lease_expired", `Expired lease from ${lease.ownerId} recovered with completion evidence; phase needs review.`, phase.id);
      } else if (phase.status === "running" || phase.status === "leased" || phase.status === "completion_pending") {
        phase.status = state.state === "executing" && state.blockers.length === 0 && dependencyIds(phase).every((id) => phaseById(state.plan!, id)?.status === "completed")
          ? "ready"
          : "needs_replan";
        appendEvent(state, "phase_lease_expired", `Expired lease from ${lease.ownerId} recovered at ${recoveredAt}; phase moved to ${phase.status}.`, phase.id);
      }
    }
    refreshPhaseReadiness(state);
    return state;
  }, { ...args.mutation, operation: "recover_leases" });
}

export function workflowEvents(state: SequentialWorkflowState): WorkflowEvent[] {
  return state.events;
}

export async function listFlows(root: string): Promise<Array<{ id: string; state: WorkflowLifecycleState; mode: WorkflowMode; request: string; updatedAt: string }>> {
  const dir = path.join(path.resolve(root), WORKFLOW_DIR);
  let entries: string[];
  try {
    const fs = await import("node:fs/promises");
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const flows = await Promise.all(entries
    .filter((entry) => entry.endsWith(".json"))
    .map(async (entry) => {
      const state = await loadFlowState(root, entry.replace(/\.json$/, ""));
      return { id: state.id, state: state.state, mode: state.mode, request: state.request, updatedAt: state.updatedAt };
    }));
  return flows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadLatestFlow(root: string): Promise<SequentialWorkflowState | undefined> {
  const flows = await listFlows(root);
  if (flows.length === 0) return undefined;
  return loadFlowState(root, flows[0].id);
}

export async function loadFlowState(root: string, workflowId: string): Promise<SequentialWorkflowState> {
  const file = workflowPath(root, workflowId);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkflowNotFoundError(`Workflow not found: ${workflowId}`);
    throw error;
  }
  try {
    return workflowStateSchema.parse(migrateWorkflowState(JSON.parse(raw), root, workflowId)) as SequentialWorkflowState;
  } catch (error) {
    throw new CorruptedWorkflowError(`Workflow state is corrupted: ${file}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveFlowState(root: string, state: SequentialWorkflowState, options: { create?: boolean; expectedRevision?: number } = {}): Promise<void> {
  const parsed = workflowStateSchema.parse(migrateWorkflowState({ ...state, updatedAt: state.updatedAt }, root, state.id)) as SequentialWorkflowState;
  const dir = path.join(path.resolve(root), WORKFLOW_DIR);
  await mkdir(dir, { recursive: true });
  const target = workflowPath(root, parsed.id);

  if (options.create) {
    try {
      await readFile(target, "utf8");
      throw new StaleWorkflowError(`Workflow already exists: ${parsed.id}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  if (options.expectedRevision !== undefined) {
    const current = await loadFlowState(root, parsed.id);
    if (current.revision !== options.expectedRevision) {
      throw new RevisionConflictError(options.expectedRevision, current.revision);
    }
  }

  await atomicWriteJson(target, parsed);
}

export async function updateFlowState(
  root: string,
  workflowId: string,
  mutate: (state: SequentialWorkflowState) => SequentialWorkflowState | Promise<SequentialWorkflowState>,
  options: MutationOptions = {}
): Promise<SequentialWorkflowState> {
  const ownerId = options.ownerId ?? DEFAULT_OWNER_ID;
  const lock = await acquireWorkflowLock({
    root,
    workflowId,
    ownerId,
    ownerType: options.ownerType ?? "cli",
    operation: options.operation ?? "state_transition",
    timeoutSeconds: options.lockTimeoutSeconds ?? DEFAULT_LOCK_TIMEOUT_SECONDS
  });
  try {
    const current = await loadFlowState(root, workflowId);
    if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
      throw new RevisionConflictError(options.expectedRevision, current.revision);
    }
    const mutated = await mutate(structuredClone(current));
    refreshPhaseReadiness(mutated);
    const next = workflowStateSchema.parse({
      ...mutated,
      revision: current.revision + 1,
      updatedAt: timestamp(),
      events: boundEvents(mutated.events)
    }) as SequentialWorkflowState;
    await saveFlowState(root, next, { expectedRevision: current.revision });
    return next;
  } finally {
    await releaseWorkflowLock(root, workflowId, lock.ownerId).catch(() => undefined);
  }
}

export function nextActions(state: SequentialWorkflowState): string[] {
  const id = state.id;
  switch (state.state) {
    case "awaiting_clarification":
      return [`leanrigor flow answer ${id} "<answer>" --root "${state.root}"`];
    case "awaiting_approach_approval":
      return [
        `leanrigor flow approve-approach ${id} --root "${state.root}"`,
        `leanrigor flow reject-approach ${id} --reason "<reason>" --root "${state.root}"`
      ];
    case "awaiting_plan_approval":
      return [
        `leanrigor flow approve-plan ${id} --root "${state.root}"`,
        `leanrigor flow revise-plan ${id} "<feedback>" --root "${state.root}"`
      ];
    case "executing": {
      const decision = state.approval?.pendingDecision;
      if (decision?.type === "phase-brief-approval" && decision.status === "pending") {
        return [
          `leanrigor flow approve-phase ${id} ${decision.phaseId} --brief-revision ${decision.briefRevision} --workflow-revision ${decision.workflowRevision} --root "${state.root}"`,
          `leanrigor flow phase-brief-show ${id} ${decision.phaseId} --root "${state.root}"`
        ];
      }
      if (decision?.type === "workspace-bootstrap-approval" && decision.status === "pending") {
        return [
          `leanrigor flow approve-bootstrap ${id} ${decision.phaseId} --brief-revision ${decision.briefRevision} --preparation-revision ${decision.preparationRevision} --workspace-identity "${decision.workspaceIdentity}" --command "${decision.command}" --root "${state.root}"`,
          `leanrigor flow status ${id} --root "${state.root}"`
        ];
      }
      const active = state.plan?.phases.find((phase) => phase.status === "running" || phase.status === "leased" || phase.status === "completion_pending");
      const repair = state.plan?.phases.find((phase) => phase.status === "needs_repair");
      const review = state.plan?.phases.find((phase) => phase.status === "needs_review");
      const replan = state.plan?.phases.find((phase) => phase.status === "needs_replan");
      if (repair) return [`leanrigor flow repair ${id} ${repair.id} --reason "<reason>" --root "${state.root}"`];
      if (review) return [`leanrigor flow phase-status ${id} ${review.id} --root "${state.root}"`, `leanrigor flow revise-plan ${id} "<feedback>" --root "${state.root}"`];
      if (replan) return [`leanrigor flow revise-plan ${id} "<feedback>" --root "${state.root}"`];
      return active
        ? [
          `leanrigor flow execution-poll ${id} --provider auto --root "${state.root}"`
        ]
        : [
          `leanrigor flow execute-next ${id} --provider auto --root "${state.root}"`,
          `leanrigor flow execution-status ${id} --provider auto --root "${state.root}"`
        ];
    }
    case "validating":
      return [
        ...(state.git ? [`leanrigor flow integration-status ${id} --root "${state.root}"`, `leanrigor flow validate-integration ${id} --root "${state.root}"`] : [`leanrigor flow record-validation ${id} --command "<command>" --exit 0 --result "<summary>" --root "${state.root}"`]),
        `leanrigor flow record-review ${id} --status passed --summary "<summary>" --root "${state.root}"`
      ];
    case "reviewing":
      return [`leanrigor flow record-review ${id} --status passed --summary "<summary>" --root "${state.root}"`];
    case "awaiting_commit_approval":
      return [
        `leanrigor flow commit-plan ${id} --root "${state.root}"`,
        `leanrigor flow complete ${id} --root "${state.root}"`
      ];
    case "blocked":
      return [`leanrigor flow status ${id} --root "${state.root}"`, `leanrigor flow cancel ${id} --root "${state.root}"`];
    case "cancelled":
    case "completed":
      return [];
    default:
      return [`leanrigor flow status ${id} --root "${state.root}"`];
  }
}

async function applyTriageResult(
  state: SequentialWorkflowState,
  triageRun: TriageRunResult,
  config: LeanRigorConfig,
  options: { clarificationAlreadyAnswered?: boolean; planningProvider?: PlanningProvider; providerSelection?: TriageProviderSelection } = {}
): Promise<SequentialWorkflowState> {
  const next = structuredClone(state);
  const triage = enforceOneClarification(triageRun.output, options.clarificationAlreadyAnswered ?? false);
  next.triage = triage;
  next.triageRun = {
    source: triageRun.source,
    provider: triageRun.provider,
    model: triageRun.model,
    attempts: triageRun.attempts,
    fallbackReason: triageRun.fallbackReason,
    warnings: triageRun.warnings,
    evidence: triageRun.evidence,
    recommendation: triageRun.recommendation,
    policyDecision: triageRun.policyDecision,
    inspection: triageRun.inspection
  };
  next.constraints = initialiseWorkflowConstraints(triage, config, next.revision, "triage_completed");
  next.mode = triage.workflow.finalMode;
  next.blockers = [];
  appendEvent(next, "triage_completed", `Triage completed in ${next.mode} mode.`);

  if (triage.clarification.required && !options.clarificationAlreadyAnswered) {
    next.clarification = {
      question: triage.clarification.question ?? "What specific behaviour or outcome should change?",
      reason: triage.clarification.reason ?? "The request requires one blocking clarification."
    };
    return transition(next, "awaiting_clarification", "One blocking clarification is required before planning.");
  }

  next.approach = buildApproach(triage, config);
  if (next.approach.required) return transition(next, "awaiting_approach_approval", "Approach recommendation is awaiting approval.");
  return withPlan(next, config, { provider: options.planningProvider, providerSelection: options.providerSelection });
}

function enforceOneClarification(triage: TriageOutput, clarificationAlreadyAnswered: boolean): TriageOutput {
  if (!clarificationAlreadyAnswered || !triage.clarification.required) return triage;
  const next = structuredClone(triage);
  next.clarification = { required: false, question: null, reason: null };
  next.assumptions = unique([...next.assumptions, "A blocking clarification was already answered; no further clarification question is permitted."]).slice(0, 3);
  return next;
}

function initialiseWorkflowConstraints(triage: TriageOutput, config: LeanRigorConfig, workflowRevision: number, transitionName: string): WorkflowConstraints {
  const createdAt = timestamp();
  const original = unique(triage.constraints.mustNot).map((text) => constraintRecord(text, "triage", createdAt, workflowRevision, transitionName));
  const policy = unique(config.instructions).map((text) => constraintRecord(text, "policy", createdAt, workflowRevision, transitionName));
  return recomputeConstraints({
    original,
    policy,
    userAdditions: [],
    userRemovals: [],
    userOverrides: [],
    audit: [],
    effective: []
  });
}

function applyApprovalConstraintChanges(state: SequentialWorkflowState, config: LeanRigorConfig, changes?: ApprovalConstraintChanges): WorkflowConstraints {
  if (!state.triage) throw new WorkflowStateError("Cannot approve approach before triage completes.");
  const base = state.constraints ?? initialiseWorkflowConstraints(state.triage, config, state.revision, "legacy_state_loaded");
  const next: WorkflowConstraints = structuredClone(base);
  const now = timestamp();
  const revision = state.revision;

  for (const text of changes?.remove ?? []) {
    const clean = cleanConstraint(text);
    if (!clean) throw new WorkflowStateError("Cannot remove an empty constraint.");
    const change = constraintChange("remove", clean, undefined, now, revision);
    next.userRemovals.push(change);
    next.audit.push(change);
  }
  for (const override of changes?.override ?? []) {
    const target = cleanConstraint(override.target);
    const text = cleanConstraint(override.text);
    if (!target || !text) throw new WorkflowStateError("Constraint overrides require both target and replacement text.");
    const change = constraintChange("override", text, target, now, revision);
    next.userOverrides.push(change);
    next.userAdditions.push(constraintRecord(text, "user", now, revision, "approve_approach"));
    next.audit.push(change);
  }
  for (const text of changes?.add ?? []) {
    const clean = cleanConstraint(text);
    if (!clean) throw new WorkflowStateError("Cannot add an empty constraint.");
    const change = constraintChange("add", clean, undefined, now, revision);
    next.userAdditions.push(constraintRecord(clean, "user", now, revision, "approve_approach"));
    next.audit.push(change);
  }
  return recomputeConstraints(next);
}

function recomputeConstraints(model: WorkflowConstraints): WorkflowConstraints {
  const removals = model.userRemovals.map((change) => change.text);
  const overrideTargets = model.userOverrides.map((change) => change.target).filter((target): target is string => Boolean(target));
  const compatibilityWaivers = [
    ...model.userAdditions.map((record) => record.text),
    ...model.userOverrides.map((change) => change.text)
  ].filter(isBackwardCompatibilityNotRequired);
  const policyCompatibilityRequirements = model.policy.filter((record) => requiresBackwardCompatibility(record.text));
  if (compatibilityWaivers.length > 0 && policyCompatibilityRequirements.length > 0) {
    throw new WorkflowStateError(`Cannot waive backward compatibility because policy-owned constraint(s) still require it: ${policyCompatibilityRequirements.map((record) => record.text).join("; ")}`);
  }
  const effective = uniqueRecords([...model.policy, ...model.original, ...model.userAdditions])
    .filter((record) => record.source === "policy" || record.source === "user" || !removals.some((target) => constraintMatches(record.text, target)))
    .filter((record) => record.source === "policy" || record.source === "user" || !overrideTargets.some((target) => constraintMatches(record.text, target)))
    .filter((record) => record.source !== "triage" || compatibilityWaivers.length === 0 || !requiresBackwardCompatibility(record.text));
  return {
    ...model,
    original: uniqueRecords(model.original),
    policy: uniqueRecords(model.policy),
    userAdditions: uniqueRecords(model.userAdditions),
    effective: uniqueRecords(effective)
  };
}

function constraintRecord(text: string, source: ConstraintSource, createdAt: string, workflowRevision: number, transitionName: string): WorkflowConstraintRecord {
  const clean = cleanConstraint(text);
  return {
    id: `${source}:${hashText(clean).slice(0, 16)}`,
    text: clean,
    source,
    createdAt,
    workflowRevision,
    transition: transitionName
  };
}

function constraintChange(action: ConstraintAction, text: string, target: string | undefined, timestampValue: string, workflowRevision: number): WorkflowConstraintChange {
  return {
    source: "user",
    action,
    text,
    target,
    timestamp: timestampValue,
    workflowRevision,
    transition: "approve_approach"
  };
}

function effectiveConstraintTexts(state: SequentialWorkflowState, triage: TriageOutput, config: LeanRigorConfig): string[] {
  const constraints = state.constraints ?? initialiseWorkflowConstraints(triage, config, state.revision, "legacy_state_loaded");
  return constraints.effective.map((constraint) => constraint.text);
}

function effectiveConstraintSet(state: SequentialWorkflowState, triage: TriageOutput, config: LeanRigorConfig): NonNullable<PlanningProviderInput["effectiveConstraintSet"]> {
  const constraints = state.constraints ?? initialiseWorkflowConstraints(triage, config, state.revision, "legacy_state_loaded");
  return {
    policy: constraints.policy.map((constraint) => constraint.text),
    triage: constraints.original.map((constraint) => constraint.text),
    userAdditions: constraints.userAdditions.map((constraint) => constraint.text),
    userRemovals: constraints.userRemovals.map((change) => ({ target: change.target, text: change.text })),
    userOverrides: constraints.userOverrides.map((change) => ({ target: change.target, text: change.text })),
    finalEffective: constraints.effective.map((constraint) => constraint.text)
  };
}

function approvalConstraintSummary(constraints: WorkflowConstraints): string {
  const changes = constraints.audit.filter((change) => change.transition === "approve_approach");
  if (changes.length === 0) return "Approach approved.";
  return `Approach approved with ${changes.length} constraint change${changes.length === 1 ? "" : "s"}.`;
}

function cleanConstraint(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normaliseConstraint(text: string): string {
  return cleanConstraint(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(the|a|an|must|should|shall|to|be|is|are)\b/g, " ").replace(/\s+/g, " ").trim();
}

function constraintMatches(candidate: string, target: string): boolean {
  const left = normaliseConstraint(candidate);
  const right = normaliseConstraint(target);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left) || compatibilityConstraint(left) && compatibilityConstraint(right);
}

function compatibilityConstraint(normalised: string): boolean {
  return /\bbackward compatibility\b|\bbackwards compatibility\b|\bbackward compatible\b|\bbackwards compatible\b/.test(normalised);
}

function uniqueRecords(records: WorkflowConstraintRecord[]): WorkflowConstraintRecord[] {
  const seen = new Set<string>();
  const result: WorkflowConstraintRecord[] = [];
  for (const record of records) {
    const key = `${record.source}:${normaliseConstraint(record.text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(record);
  }
  return result;
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

async function withPlan(state: SequentialWorkflowState, config?: LeanRigorConfig, planningOptions?: { provider?: PlanningProvider; providerSelection?: TriageProviderSelection }): Promise<SequentialWorkflowState> {
  if (!state.triage) throw new WorkflowStateError("Cannot plan before triage completes.");
  const planning = transition(state, "planning", "Sequential plan generation started.");
  const planningRun = await generatePlan({
    request: planning.request,
    root: planning.root,
    triage: state.triage,
    evidence: planning.triageRun?.evidence,
    config,
    constraints: effectiveConstraintTexts(planning, state.triage, config ?? defaultConfig()),
    constraintSet: effectiveConstraintSet(planning, state.triage, config ?? defaultConfig()),
    constraintAudit: planning.constraints?.audit ?? [],
    revisionRequests: [...(planning.approach?.revisionRequests ?? []), ...(planning.plan?.revisionRequests ?? [])],
    provider: planningOptions?.provider,
    providerSelection: planningOptions?.providerSelection
  });
  planning.plan = planningRun.plan;
  planning.planningRun = planningRunMetadata(planningRun);
  planning.phaseBriefs = {};
  planning.phaseBriefFailures = {};
  supersedePendingPhaseApproval(planning);
  planning.approval = {
    ...(planning.approval ?? { history: [], decisionHistory: [] }),
    currentAuthorizedPhase: undefined,
    pendingDecision: undefined,
    recommendation: approvalRecommendation(planning)
  };
  appendEvent(planning, "planning_completed", planningEventSummary(planningRun));
  if (planningRun.approvalBlockedReason) {
    planning.blockers = unique([...planning.blockers, planningRun.approvalBlockedReason]);
    return transition(planning, "blocked", "Plan approval disabled because deterministic fallback was too generic; revise the plan before continuing.");
  }
  return transition(planning, "awaiting_plan_approval", "Sequential plan is awaiting explicit approval.");
}

function buildApproach(triage: TriageOutput, config: LeanRigorConfig): ApproachRecommendation {
  const mode = triage.workflow.finalMode;
  const required = mode !== "fast" || !canSkipApproachGate(triage);
  const routing = mode === "rigorous"
    ? `${config.routing.rigorousPlanning} planning and ${config.routing.rigorousImplementation} implementation`
    : mode === "standard"
      ? `${config.routing.standardPlanning} planning and ${config.routing.standardImplementation} implementation`
      : `${config.routing.fastImplementation} implementation`;
  return {
    required,
    approved: !required,
    proposed: `${label(mode)} sequential workflow using ${routing}; no parallel agents, worktrees, commits, or pushes.`,
    preferredBecause: preferredBecause(triage),
    alternatives: mode === "rigorous"
      ? ["A Standard workflow would reduce ceremony but is not appropriate for the identified safety or blast-radius triggers."]
      : mode === "standard"
        ? ["A Fast workflow would be lighter but would under-validate a behavioral or medium-risk change."]
        : [],
    primaryRisks: primaryRisks(triage),
    validationStrategy: validationStrategy(mode, triage)
  };
}

function buildPlan(request: string, triage: TriageOutput, root: string, config?: LeanRigorConfig, options?: { revisionRequests?: ExecutionPlan["revisionRequests"]; constraints?: string[]; evidence?: TriageEvidencePacket }): ExecutionPlan {
  const mode = triage.workflow.finalMode;
  const validationCommands = defaultValidationCommands(root, mode, triage);
  const proposedTargets = triage.inspection.targets.length > 0 ? triage.inspection.targets : ["relevant implementation boundary", "nearby tests"];
  const targets = discoverPlanningTargets(root, planningEvidenceText(request, options?.evidence), proposedTargets);
  const revisionNote = options?.revisionRequests?.at(-1)?.feedback;
  const boundaries = inferBoundaries(request, triage, targets);
  const phases = mode === "fast"
    ? fastPhases(targets, validationCommands)
    : mode === "standard"
      ? standardPhases(targets, validationCommands, boundaries)
      : rigorousPhases(targets, validationCommands, boundaries);
  applyEnrichedAcceptanceCriteria(phases, options?.evidence);
  for (const plannedPhase of phases) {
    plannedPhase.acceptanceCriteria = synthesizeObservableAcceptanceCriteria(plannedPhase.acceptanceCriteria, {
      validationCommands: plannedPhase.validationCommands,
      documentationOnly: plannedPhase.expectedWriteAreas.every((area) => /(^|\/)(docs?|readme)/i.test(area))
    });
  }

  const plan: ExecutionPlan = {
    version: 1,
    summary: revisionNote
      ? `Sequential plan for: ${request.trim()} (revised for: ${revisionNote})`
      : `Sequential plan for: ${request.trim()}`,
    principles: planningPrinciples(triage, options?.constraints),
    phases,
    revisionRequests: options?.revisionRequests ?? []
  };
  const issues = validatePlanQuality(plan, mode, config);
  const constraintIssues = validatePlanConstraintConsistency(plan, options?.constraints ?? triage.constraints.mustNot);
  if (constraintIssues.length > 0) throw new WorkflowStateError(`Generated plan contradicted approved constraints: ${constraintIssues.map((issue) => issue.message).join("; ")}`);
  if (issues.length > 0) throw new WorkflowStateError(`Generated plan did not satisfy phase-sizing rules: ${issues.join("; ")}`);
  return plan;
}

async function generatePlan(args: {
  request: string;
  root: string;
  triage: TriageOutput;
  evidence?: TriageEvidencePacket;
  config?: LeanRigorConfig;
  constraints?: string[];
  constraintSet?: PlanningProviderInput["effectiveConstraintSet"];
  constraintAudit?: WorkflowConstraintChange[];
  revisionRequests: ExecutionPlan["revisionRequests"];
  provider?: PlanningProvider;
  providerSelection?: TriageProviderSelection;
}): Promise<PlanningRunResult> {
  const config = args.config ?? defaultConfig();
  const deterministicPlan = buildPlan(args.request, args.triage, args.root, config, {
    constraints: args.constraints,
    revisionRequests: args.revisionRequests,
    evidence: args.evidence
  });
  return runPlanning({
    input: {
      request: args.request,
      root: args.root,
      config,
      triage: args.triage,
      effectiveConstraints: args.constraints ?? args.triage.constraints.mustNot,
      effectiveConstraintSet: args.constraintSet ?? {
        policy: [],
        triage: args.triage.constraints.mustNot,
        userAdditions: [],
        userRemovals: [],
        userOverrides: [],
        finalEffective: args.constraints ?? args.triage.constraints.mustNot
      },
      constraintChanges: args.constraintAudit ?? [],
      deterministicPlan,
      revisionRequests: args.revisionRequests
    },
    provider: args.provider,
    providerSelection: args.providerSelection,
    validate: (raw) => validateModelPlan(raw, args.triage.workflow.finalMode, config, args.revisionRequests, args.constraints ?? args.triage.constraints.mustNot),
    normalise: (raw, diagnostics) => normaliseModelPlan(raw, diagnostics, deterministicPlan)
  });
}

function validateModelPlan(raw: unknown, mode: WorkflowMode, config: LeanRigorConfig, revisionRequests: ExecutionPlan["revisionRequests"], constraints: string[]): ExecutionPlan {
  const parsedResult = modelPlanSchema.safeParse(raw);
  if (!parsedResult.success) throw new PlanningValidationError(zodDiagnostics(parsedResult.error, "schema"));
  const parsed = parsedResult.data;
  const plan: ExecutionPlan = {
    version: 1,
    summary: parsed.summary,
    principles: parsed.principles && parsed.principles.length > 0 ? parsed.principles : planningPrinciples(),
    phases: parsed.phases.map((candidate) => {
      const areas = candidate.expectedFilesOrAreas ?? candidate.expectedWriteAreas;
      if (!areas || areas.length === 0) throw new WorkflowStateError(`Model plan phase ${candidate.id} did not declare expected files or areas.`);
      return phase({
        id: candidate.id,
        objective: candidate.objective,
        rationale: candidate.rationale,
        dependencies: unique([...candidate.dependencies, ...candidate.dependsOn ?? []]),
        areas,
        readAreas: candidate.expectedReadAreas ?? areas,
        acceptance: candidate.acceptanceCriteria,
        validationCommands: candidate.validationCommands,
        riskLevel: candidate.riskLevel,
        modelTier: candidate.modelTier
      });
    }),
    revisionRequests
  };
  const checkedResult = planSchema.safeParse(plan);
  if (!checkedResult.success) throw new PlanningValidationError(zodDiagnostics(checkedResult.error, "schema"));
  const checked = checkedResult.data as ExecutionPlan;
  const diagnostics = validatePlanQualityDetailed(checked, mode, config);
  diagnostics.push(...validatePlanConstraintConsistency(checked, constraints));
  if (diagnostics.length > 0) throw new PlanningValidationError(diagnostics);
  return checked;
}

function normaliseModelPlan(
  raw: unknown,
  diagnostics: PlanDiagnostic[],
  deterministicPlan: ExecutionPlan
): { raw: unknown; changed: boolean; warnings?: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { raw, changed: false };
  const mutable = structuredClone(raw) as Record<string, unknown>;
  let changed = false;
  if (Array.isArray(mutable.phases)) {
    mutable.phases = mutable.phases.map((phase, index) => {
      if (!phase || typeof phase !== "object" || Array.isArray(phase)) return phase;
      const next = { ...phase } as Record<string, unknown>;
      const deterministicPhase = deterministicPlan.phases[index];
      if (!Array.isArray(next.expectedFilesOrAreas) && Array.isArray(next.expectedWriteAreas)) {
        next.expectedFilesOrAreas = next.expectedWriteAreas;
        changed = true;
      }
      if (!Array.isArray(next.expectedWriteAreas) && Array.isArray(next.expectedFilesOrAreas)) {
        next.expectedWriteAreas = next.expectedFilesOrAreas;
        changed = true;
      }
      if (
        deterministicPhase
        && diagnostics.some((diagnostic) =>
          diagnostic.code === "scope.non_path_write_area"
          && diagnostic.path.includes(index))
      ) {
        next.expectedFilesOrAreas = replaceNonPathAreas(next.expectedFilesOrAreas, deterministicPhase.expectedFilesOrAreas);
        next.expectedWriteAreas = replaceNonPathAreas(next.expectedWriteAreas, deterministicPhase.expectedWriteAreas);
        next.expectedReadAreas = replaceNonPathAreas(next.expectedReadAreas, deterministicPhase.expectedReadAreas);
        changed = true;
      }
      return next;
    });
  }
  const parsed = modelPlanSchema.safeParse(mutable);
  const graphRepairRequested = diagnostics.some((diagnostic) => diagnostic.code === "dependency.write_boundary_overlap");
  if (parsed.success && graphRepairRequested) {
    const graphRepair = repairPhaseGraphDependencies({
      version: 1,
      summary: parsed.data.summary,
      principles: parsed.data.principles ?? [],
      phases: parsed.data.phases.map((candidate) => {
        const areas = candidate.expectedFilesOrAreas ?? candidate.expectedWriteAreas ?? [];
        return phase({
          id: candidate.id,
          objective: candidate.objective,
          rationale: candidate.rationale,
          dependencies: unique([...candidate.dependencies, ...(candidate.dependsOn ?? [])]),
          areas,
          readAreas: candidate.expectedReadAreas ?? areas,
          acceptance: candidate.acceptanceCriteria,
          validationCommands: candidate.validationCommands,
          riskLevel: candidate.riskLevel,
          modelTier: candidate.modelTier
        });
      }),
      revisionRequests: []
    });
    if (graphRepair.changed) {
      const dependencies = new Map(graphRepair.plan.phases.map((candidate) => [candidate.id, candidate.dependencies]));
      mutable.phases = (mutable.phases as Array<Record<string, unknown>>).map((candidate) => ({
        ...candidate,
        dependencies: dependencies.get(String(candidate.id)) ?? candidate.dependencies,
        dependsOn: dependencies.get(String(candidate.id)) ?? candidate.dependsOn
      }));
      changed = true;
    }
  }
  return {
    raw: mutable,
    changed,
    warnings: changed ? [`Applied safe deterministic planning normalisation for ${diagnostics.length} diagnostic(s).`] : undefined
  };
}

function zodDiagnostics(error: z.ZodError, stage: PlanDiagnostic["stage"]): PlanDiagnostic[] {
  return error.issues.map((issue) => ({
    stage,
    path: issue.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number"),
    code: issue.code,
    message: issue.message
  }));
}

function planningPrinciples(triage?: TriageOutput, constraints?: string[]): string[] {
  const principles = [
    "Execute one phase at a time; do not unlock a later phase until dependencies complete.",
    "Keep phases as small functional outcomes with one objective, a deliverable, criteria, bounded expected areas, and validation expectations.",
    "Run or explicitly skip declared validation, then submit criterion evidence for the completion gate.",
    "Record changed files, commands, validation evidence, assumptions, risks, and scope deviations before moving on.",
    "Phase execution is dispatched through the configured execution coordinator unless manual execution was explicitly selected."
  ];
  return unique([
    ...principles,
    ...((constraints ?? triage?.constraints.mustNot ?? []).map((constraint) => `Constraint: ${constraint}`))
  ]);
}

function validatePlanConstraintConsistency(plan: ExecutionPlan, constraints: string[]): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = [];
  const effective = constraints.map(cleanConstraint).filter(Boolean);
  if (effective.length === 0) return diagnostics;
  const planText = planConstraintText(plan).normalised;

  const waivedCompatibility = effective.find(isBackwardCompatibilityNotRequired);
  if (waivedCompatibility) {
    for (const [index, phase] of plan.phases.entries()) {
      if (!phaseRequiresBackwardCompatibility(phase)) continue;
      diagnostics.push(planDiagnostic(
        "quality",
        ["phases", index, "objective"],
        "constraint.contradiction.backward_compatibility",
        `Phase ${phase.id} contradicts the approved constraint: ${waivedCompatibility}`,
        {
          contradictionType: "backward_compatibility_required_after_waiver",
          affectedPhase: phase.id,
          effectiveConstraint: waivedCompatibility
        }
      ));
    }
  }
  for (const constraint of effective) {
    const semantic = constraintSemantics(constraint);
    if (semantic.testsUpdatedRequired && !planTextIncludes(planText, ["test", "coverage", "regression"])) {
      diagnostics.push(planDiagnostic("quality", ["plan"], "constraint.missing.tests", "Plan does not reflect the approved constraint that tests must be updated.", {
        contradictionType: "missing_required_tests",
        effectiveConstraint: constraint
      }));
    }
    if (semantic.allChecksMustPass && (plan.phases.every((phase) => phase.validationCommands.length === 0) || !planTextIncludes(planText, ["check", "validation", "typecheck", "test", "lint", "build"]))) {
      diagnostics.push(planDiagnostic("quality", ["plan"], "constraint.missing.checks", "Plan does not reflect the approved constraint that all checks must pass.", {
        contradictionType: "missing_required_validation",
        effectiveConstraint: constraint
      }));
    }
    if (semantic.excludedScope) {
      for (const [index, phase] of plan.phases.entries()) {
        const phaseAreas = [...phase.expectedWriteAreas, ...phase.expectedFilesOrAreas].map(normaliseConstraint).join("\n");
        if (!phaseAreas.includes(normaliseConstraint(semantic.excludedScope))) continue;
        diagnostics.push(planDiagnostic("quality", ["phases", index, "expectedWriteAreas"], "constraint.contradiction.excluded_scope", `Phase ${phase.id} includes excluded scope '${semantic.excludedScope}'.`, {
          contradictionType: "excluded_scope_in_phase",
          affectedPhase: phase.id,
          effectiveConstraint: constraint
        }));
      }
    }
    if (semantic.policySafetyGate && !planTextIncludes(planText, ["gate", "evidence", "validation", "review"])) {
      diagnostics.push(planDiagnostic("quality", ["plan"], "constraint.missing.policy_gate", "Plan omits a policy-owned safety gate.", {
        contradictionType: "missing_policy_safety_gate",
        effectiveConstraint: constraint
      }));
    }
  }
  return diagnostics;
}

function isBackwardCompatibilityNotRequired(constraint: string): boolean {
  return /backward[s]? compatibility .*not required|backward-compatible .*not required|compatibility .*not required/i.test(constraint)
    || /not require .*backward[s]? compatibility/i.test(constraint);
}

function phaseRequiresBackwardCompatibility(phase: WorkflowPhase): boolean {
  const text = [
    phase.objective,
    phase.rationale,
    ...phase.acceptanceCriteria,
    ...phase.validationCommands
  ].join("\n").toLowerCase();
  const mentionsCompatibility = /\bbackward-compatible\b|\bbackwards-compatible\b|\bbackward compatibility\b|\bbackwards compatibility\b|\bcompatibility migration\b|\bcompatibility-preserving\b/.test(text);
  if (!mentionsCompatibility) return false;
  return !/\bnot required\b|\bnot needed\b|\bnot necessary\b|\bno backward[s]? compatibility\b|\bwithout backward[s]? compatibility\b/.test(text);
}

function requiresBackwardCompatibility(text: string): boolean {
  const normalised = text.toLowerCase();
  const mentionsCompatibility = /\bbackward-compatible\b|\bbackwards-compatible\b|\bbackward compatibility\b|\bbackwards compatibility\b|\bcompatibility migration\b|\bcompatibility-preserving\b/.test(normalised);
  if (!mentionsCompatibility) return false;
  return !/\bnot required\b|\bnot needed\b|\bnot necessary\b|\bno backward[s]? compatibility\b|\bwithout backward[s]? compatibility\b/.test(normalised);
}

function planTextIncludes(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function planConstraintText(plan: ExecutionPlan): { normalised: string } {
  return {
    normalised: [
      plan.summary,
      ...plan.principles,
      ...plan.phases.flatMap((phase) => [
        phase.objective,
        phase.rationale,
        ...phase.expectedReadAreas,
        ...phase.expectedWriteAreas,
        ...phase.expectedFilesOrAreas,
        ...phase.acceptanceCriteria,
        ...phase.validationCommands
      ])
    ].join("\n").toLowerCase()
  };
}

function constraintSemantics(constraint: string): {
  testsUpdatedRequired: boolean;
  allChecksMustPass: boolean;
  excludedScope?: string;
  policySafetyGate: boolean;
} {
  const normalised = normaliseConstraint(constraint);
  const excludedScope = constraint.match(/\b(?:exclude|excluding|do not touch|do not modify|out of scope|must not touch|must not modify)\b[:\s-]*(.+)$/i)?.[1]?.trim();
  return {
    testsUpdatedRequired: /\btests? (updated|added|required)\b|\bupdate tests?\b|\btest coverage\b/.test(normalised),
    allChecksMustPass: /\ball configured checks pass\b|\ball checks pass\b|\ball checks must pass\b/.test(normalised),
    excludedScope,
    policySafetyGate: /\bsafety gate\b|\bcompletion gate\b|\breview gate\b|\bmandatory evidence\b/.test(normalised)
  };
}

function planningRunMetadata(run: PlanningRunResult): SequentialWorkflowState["planningRun"] {
  return {
    source: run.source,
    provider: run.provider,
    model: run.model,
    attempts: run.attempts,
    fallbackReason: run.fallbackReason,
    warnings: run.warnings,
    diagnostics: run.diagnostics,
    attemptRecords: run.attemptRecords,
    syntaxRepairApplied: run.syntaxRepairApplied,
    semanticRepairApplied: run.semanticRepairApplied,
    approvalBlockedReason: run.approvalBlockedReason
  };
}

function planningEventSummary(run: PlanningRunResult): string {
  if (run.source === "model") {
    return `Plan generated by ${run.provider}${run.model ? ` (${run.model})` : ""} after ${run.attempts} attempt${run.attempts === 1 ? "" : "s"}.`;
  }
  return `Deterministic planning fallback used: ${run.fallbackReason ?? "reason unavailable"}.`;
}

function fastPhases(targets: string[], validationCommands: string[]): WorkflowPhase[] {
  return [phase({
    id: "phase-1",
    objective: "Apply the small low-risk requested change.",
    rationale: "Fast mode keeps ceremony compact when triage found low ambiguity, low blast radius, and no material safety risk.",
    dependencies: [],
    areas: targets,
    acceptance: ["The requested change is implemented without unrelated edits.", "A targeted sanity check or explicit skipped-validation reason is recorded."],
    validationCommands,
    riskLevel: "low",
    modelTier: "inherit"
  })];
}

function standardPhases(targets: string[], validationCommands: string[], boundaries: BoundarySet): WorkflowPhase[] {
  if (boundaries.backend && boundaries.frontend) {
    return [
      phase({
        id: "phase-1",
        objective: "Add the backend behavior or public contract for the requested outcome.",
        rationale: "The backend boundary is an independently reviewable dependency for the frontend consumer.",
        dependencies: [],
        areas: filterAreas(targets, ["backend", "api", "service", "server", "src"]),
        acceptance: ["The backend outcome is implemented without unrelated refactoring.", "The contract or behavior can be inspected independently of UI changes."],
        validationCommands: validationCommands.slice(0, 1),
        riskLevel: "medium",
        modelTier: "medium"
      }),
      phase({
        id: "phase-2",
        objective: "Update the frontend consumer for the approved behavior.",
        rationale: "The consumer depends on the backend behavior or contract from phase-1.",
        dependencies: ["phase-1"],
        areas: filterAreas(targets, ["frontend", "ui", "client", "component", "app"]),
        acceptance: ["The frontend path uses the approved backend behavior or contract.", "No database, migration, or production configuration changes are introduced."],
        validationCommands: validationCommands.slice(0, 1),
        riskLevel: "medium",
        modelTier: "medium"
      }),
      phase({
        id: "phase-3",
        objective: "Add focused regression coverage for the changed behavior.",
        rationale: "Regression evidence should be reviewable separately from implementation edits.",
        dependencies: ["phase-2"],
        areas: targets,
        acceptance: ["A focused regression check records the changed behavior.", "Any skipped check has a concise reason accepted by the completion policy."],
        validationCommands,
        riskLevel: "medium",
        modelTier: "medium"
      })
    ];
  }
  const phases = [
    phase({
      id: "phase-1",
      objective: boundaries.publicContract
        ? "Add the public contract for the requested behavior."
        : "Implement the primary behavior for the requested outcome.",
      rationale: boundaries.publicContract
        ? "The public contract must be reviewable before any consumer or coverage updates."
        : "Standard mode keeps implementation focused on the primary functional outcome.",
      dependencies: [],
      areas: targets,
      acceptance: boundaries.publicContract
        ? ["The public contract is explicit and compatible with the approved request.", "No unrelated consumer or documentation edits are mixed into the contract change."]
        : ["The requested behavior follows nearby patterns.", "Scope remains limited to the approved request."],
      validationCommands: validationCommands.slice(0, 1),
      riskLevel: "medium",
      modelTier: "medium"
    }),
    phase({
      id: "phase-2",
      objective: "Add focused regression coverage for the changed behavior.",
      rationale: "Coverage is materially distinct from implementation and proves the behavior under review.",
      dependencies: ["phase-1"],
      areas: targets,
      acceptance: ["A focused regression check records the changed behavior.", "Any skipped check has a concise reason accepted by the completion policy."],
      validationCommands,
      riskLevel: "medium",
      modelTier: "medium"
    })
  ];
  if (boundaries.documentation) {
    phases.push(phase({
      id: "phase-3",
      objective: "Update user-facing documentation for the changed behavior.",
      rationale: "Documentation can be reviewed after behavior and regression evidence are in place.",
      dependencies: ["phase-2"],
      areas: ["README.md", "docs/**", "commands/**"],
      acceptance: ["Documentation reflects verified behavior.", "No runtime behavior changes are introduced in the documentation phase."],
      validationCommands: ["git diff --check"],
      riskLevel: "low",
      modelTier: "small"
    }));
  }
  return phases;
}

function rigorousPhases(targets: string[], validationCommands: string[], boundaries: BoundarySet): WorkflowPhase[] {
  const firstObjective = boundaries.migration
    ? "Isolate the migration contract and rollback-sensitive assumptions."
    : boundaries.security
      ? "Isolate the security-sensitive contract and invariants."
      : boundaries.publicContract
        ? "Isolate the public contract and compatibility expectations."
        : "Isolate the high-risk boundary and safety assumptions.";
  return [
    phase({
      id: "phase-1",
      objective: firstObjective,
      rationale: "Rigorous work establishes the high-risk contract together with any required consumers when separating them would violate independently valid repository-state closure; the cross-boundary dependency is explicit.",
      dependencies: [],
      areas: targets,
      acceptance: ["A focused contract check records the high-risk boundary and applicable compatibility result.", "A scope check records that the approved paths still match the original request."],
      validationCommands: validationCommands.slice(0, 1),
      riskLevel: "high",
      modelTier: "large"
    }),
    phase({
      id: "phase-2",
      objective: "Implement the approved high-risk behavior change.",
      rationale: "The implementation phase depends on the established risk boundary and keeps required producer-consumer wiring together when needed for an independently valid repository state.",
      dependencies: ["phase-1"],
      areas: targets,
      acceptance: ["A focused behavior check records the preserved contracts and invariants.", "Any scope deviation is recorded before continuing."],
      validationCommands,
      riskLevel: "high",
      modelTier: "large"
    }),
    phase({
      id: "phase-3",
      objective: "Add high-risk regression and integration validation evidence.",
      rationale: "Rigorous mode keeps integration evidence with every required producer and consumer boundary so the completed phase is independently valid before final review.",
      dependencies: ["phase-2"],
      areas: targets,
      acceptance: ["Targeted and broader checks are recorded or explicitly skipped with reasons.", "The full configured validation set passes before deep integrated review."],
      validationCommands,
      riskLevel: "high",
      modelTier: "large"
    })
  ];
}

interface BoundarySet {
  backend: boolean;
  frontend: boolean;
  migration: boolean;
  security: boolean;
  publicContract: boolean;
  documentation: boolean;
}

function inferBoundaries(request: string, triage: TriageOutput, targets: string[]): BoundarySet {
  const text = `${request} ${targets.join(" ")} ${triage.escalationReasons.join(" ")}`.toLowerCase();
  return {
    backend: /\b(api|backend|server|service|database|db|persistence|schema)\b/.test(text),
    frontend: /\b(frontend|front-end|ui|client|consumer|component|editor|page|view)\b/.test(text),
    migration: /\b(migration|migrations|rollback|forward[- ]?fix|database migration)\b/.test(text),
    security: /\b(auth|authentication|authorization|permission|credential|secret|security)\b/.test(text),
    publicContract: /\b(api|contract|schema|openapi|graphql|proto|public)\b/.test(text),
    documentation: /\b(doc|docs|documentation|readme)\b/.test(text)
  };
}

function filterAreas(targets: string[], keywords: string[]): string[] {
  const filtered = targets.filter((target) => keywords.some((keyword) => target.toLowerCase().includes(keyword)));
  return filtered.length > 0 ? filtered : targets;
}

export function discoverPlanningTargets(root: string, requestEvidence: string, proposed: string[]): string[] {
  const explicit = unique(proposed.filter((area) => isRepositoryPlanningTarget(root, area)));
  if (explicit.length > 0) return explicit;
  const glob = require("fast-glob") as typeof import("fast-glob");
  const files = glob.sync([
    "src/**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,kt,rb,php}",
    "tests/**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,kt,rb,php}",
    "test/**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,kt,rb,php}",
    "**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,py}",
    "README.md",
    "docs/**/*.md"
  ], {
    cwd: root,
    onlyFiles: true,
    unique: true,
    ignore: ["**/node_modules/**", "dist/**", "runtime/**", ".git/**", ".leanrigor/**"]
  }).slice(0, 240);
  const tokens = planningSearchTokens(requestEvidence);
  const scored = files.map((file) => {
    const pathText = file.toLowerCase().replace(/[^a-z0-9]+/g, " ");
    let score = tokens.reduce((total, token) => total + (pathText.includes(token) ? 5 : 0), 0);
    if (score === 0 && existsSync(path.join(root, file))) {
      try {
        const content = readFileSync(path.join(root, file), "utf8").slice(0, 96_000).toLowerCase();
        score += tokens.reduce((total, token) => total + (content.includes(token) ? 1 : 0), 0);
      } catch {
        // Unreadable candidates remain unselected; deterministic fallback never expands permissions.
      }
    }
    if (/^(src|lib|app)\//.test(file)) score += 1;
    if (/\.(test|spec)\./.test(file) || /^(tests?|__tests__)\//.test(file)) score += 1;
    return { file, score };
  }).filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));
  const selected = unique(scored.slice(0, 7).map((candidate) => candidate.file));
  if (selected.length > 0) return selected;
  const conservative = files.filter((file) => /^(src|lib|app|tests?)\//.test(file)).slice(0, 4);
  if (conservative.length > 0) return conservative;
  return unique([
    "src/**",
    "tests/**",
    ...(/\b(doc|docs|documentation|readme)\b/i.test(requestEvidence) ? ["docs/**", "README.md"] : [])
  ]);
}

function isRepositoryPlanningTarget(root: string, area: string): boolean {
  const normalized = normaliseRepositoryPath(area);
  if (!isRepositoryPathPattern(normalized)) return false;
  const repositoryRoot = path.resolve(root);
  const absolute = path.resolve(repositoryRoot, normalized);
  const relative = path.relative(repositoryRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  if (existsSync(absolute)) return true;
  if (["*", "?", "[", "]", "{", "}", "(", ")"].some((character) => normalized.includes(character))) {
    const glob = require("fast-glob") as typeof import("fast-glob");
    return glob.sync(normalized, {
      cwd: repositoryRoot,
      onlyFiles: false,
      unique: true,
      ignore: ["**/node_modules/**", ".git/**", ".leanrigor/**"]
    }).length > 0;
  }
  return isPotentialRepositoryFile(normalized);
}

function replaceNonPathAreas(value: unknown, fallback: string[]): string[] {
  const current = Array.isArray(value) ? value.filter((area): area is string => typeof area === "string") : [];
  const concrete = current.filter(isPathLikeArea);
  return unique(concrete.length > 0 ? concrete : fallback);
}

function planningEvidenceText(request: string, evidence?: TriageEvidencePacket): string {
  const workItems = evidence?.referencedWorkItems ?? [];
  return [
    request,
    ...workItems.flatMap((item) => [
      item.title ?? "",
      item.body ?? "",
      ...(item.acceptanceCriteria ?? [])
    ])
  ].join("\n").slice(0, 96_000);
}

function applyEnrichedAcceptanceCriteria(phases: WorkflowPhase[], evidence?: TriageEvidencePacket): void {
  if (phases.length === 0) return;
  const criteria = unique((evidence?.referencedWorkItems ?? []).flatMap((item) => item.acceptanceCriteria ?? []));
  if (criteria.length === 0) return;
  for (const criterion of criteria) {
    const category = classifyAcceptanceOutcome(criterion);
    const index = acceptancePhaseIndex(category, phases.length);
    phases[index]!.acceptanceCriteria = unique([...phases[index]!.acceptanceCriteria, criterion]);
  }
}

function acceptancePhaseIndex(category: ReturnType<typeof classifyAcceptanceOutcome>, phaseCount: number): number {
  if (phaseCount === 1) return 0;
  if (["persistence", "compatibility", "schema", "public-contract", "migration"].includes(category)) return 0;
  if (["documentation", "validation", "integration"].includes(category)) return phaseCount - 1;
  return Math.min(1, phaseCount - 1);
}

function planningSearchTokens(request: string): string[] {
  const stop = new Set(["about", "after", "against", "change", "current", "from", "implement", "into", "issue", "request", "require", "should", "that", "their", "these", "this", "through", "using", "with", "without"]);
  return unique((request.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])
    .map((token) => token.replace(/(?:ing|ed|s)$/, ""))
    .filter((token) => token.length >= 4 && !stop.has(token)))
    .slice(0, 24);
}

export function validatePlanQuality(plan: ExecutionPlan, mode?: WorkflowMode, config?: LeanRigorConfig): string[] {
  return validatePlanQualityDetailed(plan, mode, config).map((diagnostic) => diagnostic.message);
}

function validatePlanQualityDetailed(plan: ExecutionPlan, mode?: WorkflowMode, config?: LeanRigorConfig): PlanDiagnostic[] {
  const issues: PlanDiagnostic[] = [];
  const ids = new Set<string>();
  for (const [index, phase] of plan.phases.entries()) {
    const phasePath = ["phases", index];
    if (ids.has(phase.id)) issues.push(planDiagnostic("quality", phasePath.concat("id"), "phase.duplicate_id", `Phase ${phase.id} is duplicated.`));
    ids.add(phase.id);
    if (!phase.objective.trim()) issues.push(planDiagnostic("quality", phasePath.concat("objective"), "objective.missing", `Phase ${phase.id} is missing an objective.`));
    if (isBroadContainer(phase.objective)) issues.push(planDiagnostic("quality", phasePath.concat("objective"), "objective.generic_container", `Phase ${phase.id} is a vague or overly broad container.`));
    if (phase.acceptanceCriteria.length === 0) issues.push(planDiagnostic("quality", phasePath.concat("acceptanceCriteria"), "acceptance.missing", `Phase ${phase.id} has no acceptance criteria.`));
    if (phase.validationCommands.length === 0) issues.push(planDiagnostic("quality", phasePath.concat("validationCommands"), "validation.missing", `Phase ${phase.id} has no validation command or check expectation.`));
    if (phase.expectedFilesOrAreas.length === 0) issues.push(planDiagnostic("quality", phasePath.concat("expectedFilesOrAreas"), "scope.missing_write_area", `Phase ${phase.id} has no bounded expected write area.`));
    if (phase.expectedFilesOrAreas.some((area) => !isPathLikeArea(area))) {
      issues.push(planDiagnostic("quality", phasePath.concat("expectedFilesOrAreas"), "scope.non_path_write_area", `Phase ${phase.id} contains a write area that is not a repository-relative path or glob.`));
    }
    if (phase.expectedFilesOrAreas.length >= (config?.taskSizing.reviewSplitThresholdFiles ?? 8) && mode !== "fast") {
      issues.push(planDiagnostic("quality", phasePath.concat("expectedFilesOrAreas"), "scope.too_many_write_areas", `Phase ${phase.id} lists many expected write areas and should be reviewed for splitting.`));
    }
    const mixedBoundary = mixedArchitecturalBoundary(phase, mode);
    if (mixedBoundary) {
      issues.push(planDiagnostic("quality", phasePath.concat("expectedWriteAreas"), "scope.mixed_architectural_boundaries", mixedBoundary));
    }
  }
  for (const phase of plan.phases) {
    for (const dependency of phase.dependencies) {
      if (!ids.has(dependency)) issues.push(planDiagnostic("quality", ["phases", phase.id, "dependencies"], "dependency.missing", `Phase ${phase.id} depends on missing phase ${dependency}.`));
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.phases.map((phase) => [phase.id, phase]));
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      issues.push(planDiagnostic("quality", ["phases"], "dependency.cycle", `Dependency cycle detected at ${id}.`));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const phase of plan.phases) visit(phase.id);
  issues.push(...validatePhaseGraphQuality(plan));
  return uniqueDiagnostics(issues);
}

function isBroadContainer(objective: string): boolean {
  return /\b(whole feature|backend, frontend|frontend, tests|tests and docs|some related|various|everything|all changes|whole task)\b/i.test(objective);
}

function mixedArchitecturalBoundary(phase: WorkflowPhase, mode?: WorkflowMode): string | undefined {
  if (mode === "fast") return undefined;
  const productionGroups = unique((phase.expectedWriteAreas.length > 0 ? phase.expectedWriteAreas : phase.expectedFilesOrAreas)
    .map(areaBoundary)
    .filter((group): group is string => Boolean(group) && group !== "tests" && group !== "docs" && group !== "risk"));
  if (productionGroups.length <= 1) return undefined;
  if (/\b(independently valid|repository-state closure|producer-consumer|cross-boundary dependency|required producer and consumer)\b/i.test(phase.rationale)) {
    return undefined;
  }
  return `Phase ${phase.id} writes multiple architectural boundaries (${productionGroups.join(", ")}); split the phase or make the dependency boundary explicit.`;
}

function areaBoundary(area: string): string | undefined {
  const normalized = area.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (!normalized || normalized.startsWith("risk:")) return "risk";
  if (/^(tests?|__tests__|test)\//.test(normalized) || normalized.includes("/__tests__/") || normalized.endsWith(".test.ts") || normalized.endsWith(".spec.ts")) return "tests";
  if (/^(docs?|readme\.md|contributing\.md|changelog\.md)/.test(normalized)) return "docs";
  if (/^(src\/core)\//.test(normalized)) return "src/core";
  if (/^(src\/config)\//.test(normalized)) return "src/config";
  if (/^(src\/cli)\//.test(normalized)) return "src/cli";
  if (/^(src\/adapters\/[^/]+)/.test(normalized)) return normalized.match(/^(src\/adapters\/[^/]+)/)?.[1];
  if (/^(src|lib|app)\/[^/]+\.[a-z0-9]+$/.test(normalized)) return normalized.split("/")[0];
  if (/^(src\/[^/]+)/.test(normalized)) return normalized.match(/^(src\/[^/]+)/)?.[1];
  if (/^([^/]+\/[^/]+)/.test(normalized) && isPathLikeArea(normalized)) return normalized.match(/^([^/]+\/[^/]+)/)?.[1];
  return undefined;
}

function planDiagnostic(
  stage: PlanDiagnostic["stage"],
  pathParts: Array<string | number>,
  code: string,
  message: string,
  details: Omit<PlanDiagnostic, "stage" | "path" | "code" | "message"> = {}
): PlanDiagnostic {
  return { stage, path: pathParts, code, message, ...details };
}

function uniqueDiagnostics(diagnostics: PlanDiagnostic[]): PlanDiagnostic[] {
  const seen = new Set<string>();
  const out: PlanDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.stage}:${diagnostic.code}:${diagnostic.path.join(".")}:${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(diagnostic);
  }
  return out;
}

function phase(args: {
  id: string;
  objective: string;
  rationale: string;
  dependencies: string[];
  areas: string[];
  readAreas?: string[];
  acceptance: string[];
  validationCommands: string[];
  riskLevel: RiskLevel;
  modelTier: ModelProfile;
}): WorkflowPhase {
  const areas = unique(args.areas);
  const readAreas = unique(args.readAreas ?? areas);
  return {
    id: args.id,
    objective: args.objective,
    rationale: args.rationale,
    dependencies: args.dependencies,
    dependsOn: args.dependencies,
    expectedReadAreas: readAreas,
    expectedWriteAreas: areas,
    expectedFilesOrAreas: areas,
    acceptanceCriteria: args.acceptance,
    validationCommands: args.validationCommands,
    riskLevel: args.riskLevel,
    modelTier: args.modelTier,
    status: "planned",
    ownershipUncertain: !areas.some(isPathLikeArea),
    filesChanged: [],
    commandsRun: [],
    validationResults: [],
    scopeDeviations: [],
    repairAttempts: []
  };
}

function defaultValidationCommands(root: string, mode: WorkflowMode, triage: TriageOutput): string[] {
  const packageJson = readPackageJsonSync(root);
  const scripts = packageJson?.scripts ?? {};
  const commands: string[] = [];
  if (triage.task.type === "documentation") {
    if (scripts.lint) commands.push("npm run lint");
    commands.push("git diff --check");
    return unique(commands);
  }
  if (mode === "fast") {
    if (scripts.typecheck) commands.push("npm run typecheck");
    if (scripts.test) commands.push("npm test -- --runInBand");
    commands.push("git diff --check");
    return unique(commands);
  }
  if (scripts.test) commands.push("npm test");
  if (scripts.typecheck) commands.push("npm run typecheck");
  if (scripts.lint) commands.push("npm run lint");
  if (mode === "rigorous" && scripts.build) commands.push("npm run build");
  commands.push("git diff --check");
  return unique(commands);
}

function readPackageJsonSync(root: string): { scripts?: Record<string, string> } | undefined {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  } catch {
    return undefined;
  }
}

function appendRepairPhase(state: SequentialWorkflowState, repairScope: string): void {
  if (!state.plan) throw new WorkflowStateError("Cannot append a repair phase without a plan.");
  for (const phase of state.plan.phases) {
    if (phase.status === "running" || phase.status === "leased") phase.status = "blocked";
  }
  const previous = state.plan.phases.at(-1)?.id;
  const id = `repair-${state.repairAttempts}`;
  state.plan.phases.push(phase({
    id,
    objective: repairScope,
    rationale: "Integrated review found the smallest necessary repair scope.",
    dependencies: previous ? [previous] : [],
    areas: ["review findings", "current diff"],
    acceptance: ["The review finding is repaired without unrelated scope expansion.", "Validation evidence is updated after the repair."],
    validationCommands: state.plan.phases.at(-1)?.validationCommands ?? ["git diff --check"],
    riskLevel: state.mode === "rigorous" ? "high" : "medium",
    modelTier: state.mode === "rigorous" ? "large" : "medium"
  }));
  const repair = state.plan.phases.at(-1);
  if (repair) {
    repair.status = "ready";
  }
}

function buildCommitPlan(state: SequentialWorkflowState): CommitPlan {
  if (!state.plan) throw new WorkflowStateError("Cannot propose commits without a plan.");
  const graph: ExecutionGraph = {
    version: 1,
    tasks: state.plan.phases.map((phase) => ({
      id: phase.id,
      objective: phase.objective,
      reads: [],
      writes: phase.filesChanged,
      dependsOn: phase.dependencies,
      validation: phase.validationCommands,
      status: "completed"
    }))
  };
  const proposals = proposeCommits(graph);
  const groups = proposals.length > 0 ? proposals.map((proposal) => ({
    message: proposal.message,
    files: proposal.files,
    rationale: `Cohesive changes from ${proposal.taskIds.join(", ")}.`,
    commands: commitCommands(proposal)
  })) : [{
    message: "chore: record leanrigor workflow result",
    files: [],
    rationale: "No changed files were recorded in workflow state; inspect `git diff HEAD` before committing.",
    commands: ["git diff HEAD", "git status --short"]
  }];
  return {
    generatedAt: timestamp(),
    groups,
    note: "Proposal only. LeanRigor never runs git commit or git push automatically."
  };
}

function buildCompletionRecord(args: {
  state: SequentialWorkflowState;
  phase: WorkflowPhase;
  criteria?: CriterionCompletionEvidence[];
  assumptions?: string[];
  remainingRisks?: string[];
  evidenceArtifact?: PhaseCompletionRecord["evidenceArtifact"];
  blockedReason?: string;
  requestedRepairScope?: string;
  config?: LeanRigorConfig;
  leaseOwnerId?: string;
}): PhaseCompletionRecord {
  const criteria = normaliseCriteria(args.phase, args.criteria);
  const validation = summarisePhaseValidation(args.phase, args.state.mode, args.config);
  const approvedConstraints = args.state.constraints?.effective.map((constraint) => constraint.text) ?? args.state.triage?.constraints.mustNot ?? [];
  const policy = decideCompletionGate({
    phase: args.phase,
    criteria,
    validationStatus: validation.status,
    blockedReason: args.blockedReason,
    remainingRisks: args.remainingRisks ?? [],
    approvedConstraints,
    config: args.config,
    mode: args.state.mode
  });
  const decision = policy.decision;
  return {
    phaseId: args.phase.id,
    objective: args.phase.objective,
    criteria,
    filesChanged: args.phase.filesChanged,
    validation,
    scopeDeviations: args.phase.scopeDeviations,
    assumptions: unique(args.assumptions ?? []),
    remainingRisks: unique(args.remainingRisks ?? []),
    dependentPhasesMayProceed: decision === "completed",
    decision,
    reason: args.blockedReason ?? policy.reason ?? args.requestedRepairScope ?? "Completion gate evaluated.",
    repairAttempt: args.phase.repairAttempts.length,
    timestamp: timestamp(),
    workflowRevision: args.state.revision,
    leaseOwnerId: args.leaseOwnerId,
    approvedConstraints,
    evidenceArtifact: args.evidenceArtifact
  };
}

function normaliseCriteria(phase: WorkflowPhase, supplied?: CriterionCompletionEvidence[]): CriterionCompletionEvidence[] {
  const byCriterion = new Map((supplied ?? []).map((criterion) => [criterion.criterion, criterion]));
  return phase.acceptanceCriteria.map((criterion) => {
    const suppliedCriterion = byCriterion.get(criterion);
    return {
      criterion,
      status: suppliedCriterion?.status ?? "uncertain",
      evidence: unique(suppliedCriterion?.evidence ?? [])
    };
  });
}

function summarisePhaseValidation(phase: WorkflowPhase, mode: WorkflowMode, config?: LeanRigorConfig): PhaseCompletionRecord["validation"] {
  const activeRepair = phase.repairAttempts.find((attempt) => !attempt.outcome);
  const commands = activeRepair
    ? phase.validationResults.filter((evidence) => evidence.timestamp >= activeRepair.timestamp)
    : phase.validationResults;
  const skipped = commands.filter((evidence) => evidence.skipped).map((evidence) => ({
    command: evidence.command,
    reason: evidence.skippedReason ?? "No reason recorded."
  }));
  if (commands.some((evidence) => evidence.status === "failed" || (evidence.exitStatus ?? 0) !== 0 && !evidence.skipped)) {
    return { status: "failed", commands, skipped };
  }
  const expected = phase.validationCommands;
  const missing = missingRequiredValidationCommands(expected, commands.map((evidence) => evidence.command));
  if (commands.length === 0 || missing.length > 0) {
    if (!gateRequiresValidation(config)) return { status: "passed", commands, skipped };
    return { status: "missing", commands, skipped };
  }
  if (commands.every((evidence) => evidence.status === "skipped")) {
    return { status: allowSkippedValidation(mode, config) ? "skipped" : "failed", commands, skipped };
  }
  if (commands.some((evidence) => evidence.status === "skipped" && !allowSkippedValidation(mode, config))) {
    return { status: "failed", commands, skipped };
  }
  return { status: "passed", commands, skipped };
}

function decideCompletionGate(args: {
  phase: WorkflowPhase;
  criteria: CriterionCompletionEvidence[];
  validationStatus: PhaseCompletionRecord["validation"]["status"];
  blockedReason?: string;
  remainingRisks: string[];
  approvedConstraints: string[];
  config?: LeanRigorConfig;
  mode: WorkflowMode;
}): { decision: CompletionGateDecision; reason?: string } {
  if (!args.config?.completionGate.enabled && args.criteria.every((criterion) => criterion.status === "met" || criterion.status === "not_applicable")) {
    return { decision: "completed", reason: "Completion gate is disabled by configuration." };
  }
  if (args.blockedReason) return { decision: "blocked", reason: args.blockedReason };
  const contradictoryEvidence = completionEvidenceContradiction(args.criteria, args.approvedConstraints);
  if (contradictoryEvidence) return { decision: "needs_review", reason: contradictoryEvidence };
  const materialDeviation = args.phase.scopeDeviations.find((deviation) => isMaterialScopeDeviation(deviation));
  if (materialDeviation) return { decision: "needs_replan", reason: materialDeviation };
  const highRiskDeviation = args.phase.scopeDeviations.find((deviation) => isReviewScopeDeviation(deviation));
  if (highRiskDeviation) return { decision: "needs_review", reason: highRiskDeviation };
  const notMet = args.criteria.find((criterion) => criterion.status === "not_met");
  if (notMet) return { decision: "needs_repair", reason: `Criterion not met: ${notMet.criterion}` };
  const uncertain = args.criteria.find((criterion) => criterion.status === "uncertain");
  if (uncertain) return { decision: "needs_review", reason: `Criterion uncertain: ${uncertain.criterion}` };
  if (gateRequiresEvidence(args.config)) {
    const missingEvidence = args.criteria.find((criterion) => criterion.status === "met" && criterion.evidence.length === 0);
    if (missingEvidence) return { decision: "needs_review", reason: `Evidence missing for criterion: ${missingEvidence.criterion}` };
  }
  if (args.validationStatus === "failed") return { decision: "needs_repair", reason: "Validation failed or skipped validation is not allowed in this mode." };
  if (args.validationStatus === "missing") return { decision: "needs_repair", reason: "Declared validation evidence is missing." };
  const criticalRisk = args.remainingRisks.find((risk) => /\b(critical|severe|data loss|security|unsafe)\b/i.test(risk));
  if (criticalRisk) return { decision: "needs_review", reason: `Critical remaining risk: ${criticalRisk}` };
  return { decision: "completed", reason: "All required criteria and validation expectations are satisfied." };
}

function completionEvidenceContradiction(criteria: CriterionCompletionEvidence[], approvedConstraints: string[]): string | undefined {
  if (!approvedConstraints.some(isBackwardCompatibilityNotRequired)) return undefined;
  const evidenceText = criteria.flatMap((criterion) => [criterion.criterion, ...criterion.evidence]).join("\n").toLowerCase();
  if (requiresBackwardCompatibility(evidenceText) || /\boptional\(\).*compat|\bcompat.*optional\(\)|all new fields .*optional/i.test(evidenceText)) {
    return "Completion evidence contradicts the approved override that backward compatibility is not required.";
  }
  return undefined;
}

export type FileClassification = "documentation" | "runtime" | "config" | "test" | "other";

export function classifyFilePath(raw: string): FileClassification {
  const file = raw
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\s*\((modified|added|deleted|renamed|new file|untracked)\)\s*$/i, "")
    .trim();
  const lower = file.toLowerCase();
  const base = lower.split("/").pop() ?? lower;

  // Explicit documentation files
  if (["readme.md", "readme.txt", "readme.rst", "readme", "changelog.md", "contributing.md", "code_of_conduct.md", "security.md", "license", "license.md", "license.txt"].includes(base)) {
    return "documentation";
  }
  if (lower.startsWith("docs/")) return "documentation";
  if (/\.(md|mdx|txt|rst)$/.test(lower)) return "documentation";

  // Test files
  if (lower.includes("/tests/") || lower.includes("/__tests__/") || lower.includes("/test/")) return "test";
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lower)) return "test";

  // Config files (but not in docs/)
  if (!lower.startsWith("docs/")) {
    if (/\.(json|ya?ml|toml)$/.test(lower)) return "config";
    if (lower.startsWith(".env") || lower.endsWith(".env") || lower.includes("/.env")) return "config";
    if (["dockerfile", ".dockerignore", ".gitignore", ".gitattributes", ".editorconfig"].includes(base)) return "config";
  }

  // Everything else is runtime
  return "runtime";
}

function detectScopeDeviations(phase: WorkflowPhase, config?: LeanRigorConfig): string[] {
  const deviations: string[] = [];
  const expected = phase.expectedFilesOrAreas.filter(isPathLikeArea);
  if (expected.length > 0) {
    for (const file of phase.filesChanged) {
      if (!expected.some((area) => areaMatchesFile(area, file))) deviations.push(`changed file outside expected scope: ${file}`);
    }
  }
  const objective = phase.objective.toLowerCase();
  // Explicit expected paths are the approved scope.  A mixed implementation
  // phase often includes documentation and tests alongside source changes;
  // the presence of one docs/ path must not turn that entire phase into a
  // documentation-only phase.
  const isDocumentationOnlyPhase = expected.length > 0
    ? expected.every((area) => classifyFilePath(area) === "documentation")
    : /\b(readme|docs?|documentation)\b/.test(objective);

  for (const file of phase.filesChanged) {
    const lower = file.toLowerCase();
    if ((lower === "package.json" || lower === "package-lock.json" || lower.endsWith("/package.json")) && !/\b(dependency|package|build|tooling)\b/.test(objective)) {
      deviations.push(`production dependency or package manifest changed outside approved phase scope: ${file}`);
    }
    if (lower.includes("migration") && !/\bmigration|database|schema\b/.test(objective)) {
      deviations.push(`migration introduced outside approved phase scope: ${file}`);
    }
    if (/\b(api|schema|openapi|graphql|proto)\b/.test(lower) && !/\b(test|spec)\b/.test(lower) && !/\b(api|contract|schema|public|coverage|validation)\b/.test(objective)) {
      deviations.push(`public contract changed outside approved phase scope: ${file}`);
    }
    if (matchesConfiguredPath(file, config?.risk.rigorousPaths ?? []) && phase.riskLevel !== "high") {
      deviations.push(`sensitive path touched by non-rigorous phase: ${file}`);
    }

    if (isDocumentationOnlyPhase) {
      const classification = classifyFilePath(file);
      if (classification !== "documentation") {
        deviations.push(`scope deviation: '${file}' classified as ${classification}. Phase expected documentation changes only. Expected areas: ${phase.expectedFilesOrAreas.filter(isPathLikeArea).join(", ") || "(none)"}.`);
      }
    }
  }
  return unique(deviations);
}

function gateRequiresEvidence(config?: LeanRigorConfig): boolean {
  return config?.completionGate.requireEvidence ?? true;
}

function gateRequiresValidation(config?: LeanRigorConfig): boolean {
  return config?.completionGate.requireValidation ?? true;
}

function allowSkippedValidation(mode: WorkflowMode, config?: LeanRigorConfig): boolean {
  return config?.completionGate.allowSkippedValidation[mode] ?? mode === "fast";
}

function isPathLikeArea(area: string): boolean {
  return isRepositoryPathPattern(area);
}

function areaMatchesFile(area: string, file: string): boolean {
  const normalArea = area.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalArea.endsWith("/**")) return normalFile.startsWith(normalArea.slice(0, -3));
  if (normalArea.endsWith("/*")) {
    const prefix = normalArea.slice(0, -1);
    return normalFile.startsWith(prefix) && !normalFile.slice(prefix.length).includes("/");
  }
  if (normalArea.includes("*")) {
    const pattern = `^${normalArea.split("*").map(escapeRegex).join(".*")}$`;
    return new RegExp(pattern).test(normalFile);
  }
  if (!path.posix.extname(normalArea)) return normalFile === normalArea || normalFile.startsWith(`${normalArea}/`);
  return normalFile === normalArea;
}

function matchesConfiguredPath(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => areaMatchesFile(pattern, file));
}

function isMaterialScopeDeviation(deviation: string): boolean {
  return /outside expected scope|production dependency|migration introduced|public contract changed|documentation phase changed runtime|scope deviation/.test(deviation);
}

function isReviewScopeDeviation(deviation: string): boolean {
  return /sensitive path touched/.test(deviation);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selectStartablePhase(state: SequentialWorkflowState, phaseId?: string): WorkflowPhase {
  if (!state.plan) throw new WorkflowStateError("Cannot start a phase without a plan.");
  const plan = state.plan;
  if (plan.phases.some((phase) => phase.status === "running" || phase.status === "leased" || phase.status === "completion_pending")) {
    throw new InvalidTransitionError("A phase is already leased or running; complete or release it before starting another sequential phase.");
  }
  const phase = phaseId
    ? plan.phases.find((candidate) => candidate.id === phaseId)
    : plan.phases.find((candidate) => candidate.status === "ready" && dependencyIds(candidate).every((id) => phaseById(plan, id)?.status === "completed"));
  if (!phase) throw new WorkflowStateError("No startable phase found.");
  if (!["planned", "ready"].includes(phase.status)) throw new InvalidTransitionError(`Phase ${phase.id} is ${phase.status}; only an unstarted eligible phase can be started.`);
  const blockedDependency = dependencyIds(phase).find((id) => phaseById(plan, id)?.status !== "completed");
  if (blockedDependency) throw new InvalidTransitionError(`Phase ${phase.id} depends on incomplete phase ${blockedDependency}.`);
  return phase;
}

function phaseById(plan: ExecutionPlan, id: string): WorkflowPhase | undefined {
  return plan.phases.find((phase) => phase.id === id);
}

function validateWorkflowEvidence(evidence: ValidationEvidence): void {
  validationEvidenceSchema.parse(evidence);
}

function hasValidationEvidence(state: SequentialWorkflowState): boolean {
  return state.validation.some((evidence) => evidence.status === "passed" || evidence.status === "skipped");
}

function canSkipApproachGate(triage: TriageOutput): boolean {
  return triage.workflow.finalMode === "fast"
    && triage.assessment.ambiguity === "low"
    && triage.assessment.blastRadius === "low"
    && triage.assessment.architecturalImpact === "low"
    && triage.assessment.securityRisk === "none"
    && triage.assessment.dataIntegrityRisk === "none"
    && triage.assessment.operationalRisk === "none";
}

function preferredBecause(triage: TriageOutput): string {
  if (triage.workflow.finalMode === "fast") return "Triage found a narrow low-risk change with enough clarity for a compact workflow.";
  if (triage.workflow.finalMode === "standard") return "Triage found a behavioral or medium-risk change that needs explicit planning and targeted evidence.";
  return triage.workflow.overrideReason ?? triage.escalationReasons[0] ?? "Triage identified high-risk or broad-impact work requiring stronger gates.";
}

function primaryRisks(triage: TriageOutput): string[] {
  const risks = [
    triage.assessment.securityRisk === "high" ? "security-sensitive behavior" : undefined,
    triage.assessment.dataIntegrityRisk === "high" ? "data integrity or migration risk" : undefined,
    triage.assessment.operationalRisk === "high" ? "production or operational risk" : undefined,
    triage.assessment.blastRadius !== "low" ? `${triage.assessment.blastRadius} blast radius` : undefined,
    triage.assessment.ambiguity !== "low" ? `${triage.assessment.ambiguity} ambiguity` : undefined
  ].filter((value): value is string => value !== undefined);
  return risks.length > 0 ? risks : ["unintended scope expansion"];
}

function validationStrategy(mode: WorkflowMode, triage: TriageOutput): string[] {
  if (mode === "fast") return ["syntax/type sanity where relevant", "targeted command or skipped-validation reason", "diff sanity check"];
  if (mode === "standard") return ["targeted tests", "package/module checks where available", "integrated review"];
  return [
    "targeted and broader tests",
    "security, migration, API, data, or production checks where relevant",
    `${triage.workflow.reviewLevel} integrated review`
  ];
}

function phaseLease(phase: WorkflowPhase, ownerId: string, ownerType: WorkflowLockOwnerType, workflowRevisionAtAcquire: number, timeoutSeconds: number) {
  const now = timestamp();
  return {
    phaseId: phase.id,
    ownerId,
    ownerType,
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: new Date(Date.parse(now) + timeoutSeconds * 1000).toISOString(),
    workflowRevisionAtAcquire,
    allowedWriteAreas: phase.expectedWriteAreas.length > 0 ? phase.expectedWriteAreas : phase.expectedFilesOrAreas
  };
}

function appendEvent(state: SequentialWorkflowState, type: string, summary: string, phaseId?: string, actorId = DEFAULT_OWNER_ID): void {
  state.events.push(workflowEvent({
    type,
    actorId,
    before: state.revision,
    after: state.revision + 1,
    summary,
    phaseId
  }));
  state.events = boundEvents(state.events);
}

function workflowEvent(args: {
  type: string;
  actorId: string;
  before: number;
  after: number;
  summary: string;
  phaseId?: string;
  at?: string;
}): WorkflowEvent {
  return {
    eventId: `evt-${randomUUID().slice(0, 12)}`,
    timestamp: args.at ?? timestamp(),
    actorId: args.actorId,
    type: args.type,
    workflowRevisionBefore: args.before,
    workflowRevisionAfter: args.after,
    phaseId: args.phaseId,
    summary: args.summary
  };
}

function boundEvents(events: WorkflowEvent[]): WorkflowEvent[] {
  return events.slice(-MAX_EVENTS);
}

function boundDiagnosticObject(value: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(value);
  if (json.length <= 64_000) return value;
  return {
    truncated: true,
    bytes: json.length,
    summary: json.slice(0, 8000)
  };
}

function migrateWorkflowState(raw: unknown, root: string, workflowId: string): unknown {
  const value = raw as Record<string, unknown>;
  if (value.version === 1 && "currentPhase" in value) {
    const now = typeof value.updatedAt === "string" ? value.updatedAt : timestamp();
    return {
      version: STATE_VERSION,
      id: workflowId,
      revision: 0,
      state: "created",
      request: typeof value.request === "string" ? value.request : "Migrated legacy workflow",
      root: path.resolve(root),
      mode: value.mode === "fast" || value.mode === "rigorous" ? value.mode : "standard",
      createdAt: now,
      updatedAt: now,
      validation: [],
      phaseLeases: {},
      execution: { records: {} },
      repairAttempts: 0,
      blockers: [],
      events: [workflowEvent({ type: "legacy_workflow_loaded", actorId: "system", before: 0, after: 0, summary: "Legacy workflow loaded with safe defaults.", at: now })]
    };
  }
  const migrated = { ...value };
  migrated.version = STATE_VERSION;
  migrated.id = typeof migrated.id === "string" ? migrated.id : workflowId;
  migrated.revision = typeof migrated.revision === "number" ? migrated.revision : 0;
  migrated.root = typeof migrated.root === "string" ? migrated.root : path.resolve(root);
  migrated.updatedAt = typeof migrated.updatedAt === "string" ? migrated.updatedAt : timestamp();
  migrated.createdAt = typeof migrated.createdAt === "string" ? migrated.createdAt : migrated.updatedAt;
  migrated.validation = Array.isArray(migrated.validation) ? migrated.validation : [];
  migrated.phaseLeases = migrated.phaseLeases && typeof migrated.phaseLeases === "object" ? migrated.phaseLeases : {};
  migrated.execution = migrated.execution && typeof migrated.execution === "object" ? migrated.execution : { records: {} };
  migrated.repairAttempts = typeof migrated.repairAttempts === "number" ? migrated.repairAttempts : 0;
  migrated.blockers = Array.isArray(migrated.blockers) ? migrated.blockers : [];
  migrated.events = migrateEvents(migrated.events, migrated.revision as number);
  if (migrated.plan && typeof migrated.plan === "object") {
    const plan = migrated.plan as { phases?: unknown[] };
    plan.phases = (plan.phases ?? []).map((phase, index) => migratePhase(phase, index));
  }
  if (!migrated.approval) {
    const mode = migrated.mode === "rigorous" ? "rigorous" : migrated.mode === "fast" ? "fast" : "standard";
    migrated.approval = {
      ...(migrated.state === "executing" ? {
        policy: defaultApprovalPolicy(mode),
        source: "legacy-default",
        selectedAt: migrated.updatedAt,
        workflowPlanRevision: migrated.revision
      } : {}),
      history: [],
      decisionHistory: []
    };
  }
  if (migrated.approval && typeof migrated.approval === "object") {
    const approval = migrated.approval as Record<string, unknown>;
    approval.history = Array.isArray(approval.history) ? approval.history : [];
    const decisionHistory = Array.isArray(approval.decisionHistory)
      ? approval.decisionHistory.map((decision, index) => migrateWorkflowDecision(decision, index))
      : [];
    approval.decisionHistory = decisionHistory;
    if (approval.pendingDecision) {
      approval.pendingDecision = migrateWorkflowDecision(approval.pendingDecision, decisionHistory.length);
    } else {
      const pending = legacyPendingDecision(migrated);
      if (pending) approval.pendingDecision = migrateWorkflowDecision(pending, decisionHistory.length);
    }
  }
  migrated.phaseBriefs = migrated.phaseBriefs && typeof migrated.phaseBriefs === "object" ? migrated.phaseBriefs : {};
  migrated.phaseBriefFailures = migrated.phaseBriefFailures && typeof migrated.phaseBriefFailures === "object" ? migrated.phaseBriefFailures : {};
  normalizeLegacyMaterialBriefDecision(migrated);
  normalizeLegacyExecutionQuarantineDecision(migrated);
  normalizeLegacyPlanningFallbackDecision(migrated);
  normalizeLegacyMaxTurnRecoveryDecision(migrated);
  normalizeLegacyUnavailableProviderSession(migrated);
  return migrated;
}

function normalizeLegacyExecutionQuarantineDecision(state: Record<string, unknown>): void {
  const approval = state.approval as Record<string, unknown> | undefined;
  const decision = approval?.pendingDecision as Record<string, unknown> | undefined;
  if (!decision || decision.status !== "pending" || decision.type !== "material-drift-review" || typeof decision.phaseId !== "string") return;
  const execution = state.execution as { records?: Record<string, Record<string, unknown>> } | undefined;
  const record = execution?.records?.[decision.phaseId];
  if (!record) return;
  const diagnostics = (record.diagnostics && typeof record.diagnostics === "object"
    ? record.diagnostics
    : {}) as Record<string, unknown>;
  record.diagnostics = diagnostics;
  const identityRejected = Array.isArray(diagnostics?.identityIssues)
    || (typeof record.resultSummary === "string" && record.resultSummary.startsWith("Provider result identity rejected:"));
  const briefs = state.phaseBriefs as Record<string, Record<string, unknown>> | undefined;
  const brief = briefs?.[decision.phaseId];
  const writeAreas = Array.isArray(brief?.writeAreas) ? brief.writeAreas.filter((value): value is string => typeof value === "string") : [];
  const checkpoint = record.checkpoint as { changedFiles?: unknown[] } | undefined;
  const unexpectedWrites = (checkpoint?.changedFiles ?? [])
    .filter((value): value is string => typeof value === "string")
    .filter((file) => !writeAreas.some((area) => areaMatchesFile(area, file)));
  const scopeOnly = !identityRejected
    && unexpectedWrites.length > 0
    && (!Array.isArray(diagnostics.reportedScopeExpansion) || diagnostics.reportedScopeExpansion.length === 0)
    && (!Array.isArray(diagnostics.discoveredMaterialChanges) || diagnostics.discoveredMaterialChanges.length === 0);
  if (!identityRejected && !scopeOnly) return;
  const terminalReason = identityRejected ? "provider_protocol_error" : "provider_scope_violation";
  diagnostics.terminalReason = terminalReason;
  diagnostics.unexpectedWrites = unexpectedWrites;
  diagnostics.disposition = "needs_review";
  const providerSession = record.providerSession as Record<string, unknown> | undefined;
  if (providerSession) {
    providerSession.status = "failed";
    providerSession.resumePermitted = false;
    providerSession.replacementReason = "The prior provider session cannot be trusted for this retry; use a fresh compact session.";
  }
  const plan = state.plan as { phases?: Array<Record<string, unknown>> } | undefined;
  const phase = plan?.phases?.find((candidate) => candidate.id === decision.phaseId);
  if (phase?.status === "needs_replan") phase.status = "needs_review";
  decision.type = "execution-recovery";
  decision.question = identityRejected
    ? `The provider returned a result with the wrong execution identity. Its result was rejected and no work was accepted.${unexpectedWrites.length > 0 ? " Discard the out-of-scope changes and retry, or revise the plan if those files are genuinely required." : " Retry in a fresh compact provider session."}`
    : `The provider wrote outside the approved phase scope: ${unexpectedWrites.join(", ")}. Discard those writes and retry, or revise the plan if they are genuinely required.`;
  decision.allowedActions = [
    ...(unexpectedWrites.length > 0 ? ["discard-out-of-scope-and-retry"] : []),
    ...(unexpectedWrites.length === 0 ? ["retry-execution"] : ["revise-phase-brief"]),
    "view-details",
    "revise-plan",
    "cancel-workflow"
  ];
}

function normalizeLegacyUnavailableProviderSession(state: Record<string, unknown>): void {
  const execution = state.execution as { records?: Record<string, Record<string, unknown>> } | undefined;
  for (const [phaseId, record] of Object.entries(execution?.records ?? {})) {
    const diagnostics = record.diagnostics as Record<string, unknown> | undefined;
    const stderrExcerpt = typeof diagnostics?.stderrExcerpt === "string" ? diagnostics.stderrExcerpt : "";
    if (!/no conversation found with session id/i.test(stderrExcerpt)) continue;
    diagnostics!.terminalReason = "provider_session_unavailable";
    record.resultSummary = "Claude provider session was unavailable. Partial work was preserved in the phase worktree but not accepted; retrying will use a fresh compact session.";
    const providerSession = record.providerSession as Record<string, unknown> | undefined;
    if (providerSession) {
      providerSession.status = "unavailable";
      providerSession.resumePermitted = false;
      providerSession.replacementReason = "Persisted Claude conversation is unavailable; use a fresh compact session.";
    }
    const budget = record.executionBudget as { attempts?: Array<Record<string, unknown>> } | undefined;
    const latestAttempt = budget?.attempts?.find((attempt) => attempt.providerExecutionId === record.providerExecutionId);
    if (latestAttempt && typeof latestAttempt.terminalReason !== "string") latestAttempt.terminalReason = "provider_session_unavailable";
    const approval = state.approval as Record<string, unknown> | undefined;
    const decision = approval?.pendingDecision as Record<string, unknown> | undefined;
    if (decision?.type === "execution-recovery" && decision.phaseId === phaseId && decision.status === "pending") {
      decision.question = "The persisted Claude conversation is no longer available. Partial work remains preserved and unaccepted. Retry with a fresh compact provider session?";
      decision.allowedActions = ["retry-execution", "view-details", "revise-plan", "cancel-workflow"];
    }
  }
}

function normalizeLegacyMaxTurnRecoveryDecision(state: Record<string, unknown>): void {
  const approval = state.approval as Record<string, unknown> | undefined;
  const decision = approval?.pendingDecision as Record<string, unknown> | undefined;
  if (!decision || decision.status !== "pending" || decision.type !== "execution-recovery" || typeof decision.phaseId !== "string") return;
  const execution = state.execution as { records?: Record<string, Record<string, unknown>> } | undefined;
  const record = execution?.records?.[decision.phaseId];
  const diagnostics = record?.diagnostics as Record<string, unknown> | undefined;
  if (diagnostics?.terminalReason !== "error_max_turns") return;
  const mode = state.mode === "fast" ? "fast" : state.mode === "rigorous" ? "rigorous" : "standard";
  const initialTurnLimit = mode === "fast" ? 16 : mode === "rigorous" ? 48 : 24;
  const extensionTurnLimit = mode === "fast" ? 8 : mode === "rigorous" ? 24 : 12;
  const budget = record?.executionBudget as Record<string, unknown> | undefined;
  const extensionApprovals = typeof budget?.extensionApprovals === "number" ? budget.extensionApprovals : 0;
  if (extensionApprovals >= 1) return;
  decision.additionalTurns = extensionTurnLimit;
  decision.allowedActions = ["continue-execution", "view-details", "revise-plan", "cancel-workflow"];
  const configuredTurns = typeof diagnostics.maxTurns === "number" ? diagnostics.maxTurns : initialTurnLimit;
  const reportedTurns = typeof diagnostics.turnCount === "number" ? ` after reporting ${diagnostics.turnCount} turns` : "";
  decision.question = `The provider reached the ${configuredTurns}-turn execution limit${reportedTurns} before returning the required final result. Partial changes were preserved but not accepted. Allow up to ${extensionTurnLimit} additional turns to continue from the existing work?`;
}

function normalizeLegacyPlanningFallbackDecision(state: Record<string, unknown>): void {
  if (state.state !== "blocked") return;
  const planningRun = state.planningRun as Record<string, unknown> | undefined;
  if (typeof planningRun?.approvalBlockedReason !== "string" || !planningRun.approvalBlockedReason) return;
  const approval = state.approval as Record<string, unknown> | undefined;
  const decision = approval?.pendingDecision as Record<string, unknown> | undefined;
  if (!decision || decision.status !== "pending") return;
  decision.type = "planning-fallback-review";
  decision.question = planningRun.approvalBlockedReason;
  decision.allowedActions = ["retry-planning", "revise-plan", "view-details", "cancel-workflow"];
}

function normalizeLegacyMaterialBriefDecision(state: Record<string, unknown>): void {
  const approval = state.approval as Record<string, unknown> | undefined;
  const decision = approval?.pendingDecision as Record<string, unknown> | undefined;
  if (!decision || decision.type !== "phase-brief-approval" || typeof decision.phaseId !== "string") return;
  const briefs = state.phaseBriefs as Record<string, Record<string, unknown>> | undefined;
  const brief = briefs?.[decision.phaseId];
  const changes = Array.isArray(brief?.materialChangesFromWorkflowPlan)
    ? brief.materialChangesFromWorkflowPlan as Array<Record<string, unknown>>
    : [];
  if (!changes.some((change) => change.material === true)) return;
  decision.type = "material-drift-review";
  decision.question = `Phase ${decision.phaseId} Execution Brief revision ${String(decision.briefRevision)} contains material changes from the approved Workflow Plan. Revise the plan or revise the brief to remain within it.`;
  decision.allowedActions = ["revise-plan", "revise-phase-brief", "view-details", "cancel-workflow"];
}

function legacyPendingDecision(state: Record<string, unknown>): Record<string, unknown> | undefined {
  const revision = typeof state.revision === "number" ? state.revision : 0;
  const createdAt = typeof state.updatedAt === "string" ? state.updatedAt : timestamp();
  const base = { workflowRevision: revision, stateRevision: revision, status: "pending", createdAt, source: "legacy-migration" };
  if (state.state === "awaiting_clarification") {
    const clarification = state.clarification as Record<string, unknown> | undefined;
    return { ...base, type: "clarification", question: clarification?.question ?? "Answer the persisted clarification question.", allowedActions: ["answer", "cancel-workflow"] };
  }
  if (state.state === "awaiting_approach_approval") {
    return { ...base, type: "approach-approval", question: "Approve the persisted approach before planning?", allowedActions: ["approve-approach", "revise-approach", "view-details", "cancel-workflow"] };
  }
  if (state.state === "awaiting_plan_approval") {
    return { ...base, type: "workflow-plan-approval", question: "Approve the persisted Workflow Plan structure and policy?", allowedActions: ["approve-plan", "revise-plan", "view-details", "cancel-workflow"] };
  }
  if (state.state === "reviewing") {
    return { ...base, type: "final-review", question: "Record the final integrated review?", allowedActions: ["record-review", "view-details", "cancel-workflow"] };
  }
  if (state.state === "awaiting_commit_approval") {
    return { ...base, type: "final-completion", question: "Complete the workflow after final integrated review?", allowedActions: ["complete-workflow", "view-details", "cancel-workflow"] };
  }
  if (state.state === "blocked") {
    const blockers = Array.isArray(state.blockers) ? state.blockers : [];
    const planningRun = state.planningRun as Record<string, unknown> | undefined;
    if (typeof planningRun?.approvalBlockedReason === "string" && planningRun.approvalBlockedReason) {
      return { ...base, type: "planning-fallback-review", question: planningRun.approvalBlockedReason, allowedActions: ["retry-planning", "revise-plan", "view-details", "cancel-workflow"] };
    }
    return { ...base, type: "execution-recovery", question: blockers[0] ?? "Choose a safe recovery action.", allowedActions: ["view-details", "retry-execution", "revise-plan", "cancel-workflow"] };
  }
  const briefs = state.phaseBriefs && typeof state.phaseBriefs === "object" ? Object.values(state.phaseBriefs as Record<string, unknown>) : [];
  const pendingBrief = briefs.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).approvalStatus === "pending") as Record<string, unknown> | undefined;
  if (pendingBrief) {
    return {
      ...base,
      type: "phase-brief-approval",
      workflowRevision: typeof pendingBrief.workflowRevision === "number" ? pendingBrief.workflowRevision : revision,
      phaseId: pendingBrief.phaseId,
      briefRevision: pendingBrief.briefRevision,
      question: `Review and approve ${String(pendingBrief.phaseId)} Execution Brief revision ${String(pendingBrief.briefRevision)}?`,
      allowedActions: ["approve-phase", "revise-phase-brief", "view-details", "cancel-workflow"]
    };
  }
  return undefined;
}

function migratePhase(raw: unknown, index: number): unknown {
  const phase = { ...(raw as Record<string, unknown>) };
  phase.id = typeof phase.id === "string" && phase.id.trim() ? phase.id : `phase-${index + 1}`;
  phase.dependencies = Array.isArray(phase.dependencies) ? phase.dependencies : Array.isArray(phase.dependsOn) ? phase.dependsOn : [];
  phase.dependsOn = Array.isArray(phase.dependsOn) ? phase.dependsOn : phase.dependencies;
  phase.expectedFilesOrAreas = Array.isArray(phase.expectedFilesOrAreas) ? phase.expectedFilesOrAreas : Array.isArray(phase.expectedWriteAreas) ? phase.expectedWriteAreas : [];
  phase.expectedWriteAreas = Array.isArray(phase.expectedWriteAreas) && phase.expectedWriteAreas.length > 0 ? phase.expectedWriteAreas : phase.expectedFilesOrAreas;
  phase.expectedReadAreas = Array.isArray(phase.expectedReadAreas) && phase.expectedReadAreas.length > 0 ? phase.expectedReadAreas : phase.expectedFilesOrAreas;
  if (phase.status === "pending") phase.status = "planned";
  if (phase.status === "active") phase.status = "running";
  phase.ownershipUncertain = typeof phase.ownershipUncertain === "boolean" ? phase.ownershipUncertain : !(phase.expectedWriteAreas as string[]).some(isPathLikeArea);
  phase.filesChanged = Array.isArray(phase.filesChanged) ? phase.filesChanged : [];
  phase.commandsRun = Array.isArray(phase.commandsRun) ? phase.commandsRun : [];
  phase.validationResults = Array.isArray(phase.validationResults) ? phase.validationResults : [];
  phase.scopeDeviations = Array.isArray(phase.scopeDeviations) ? phase.scopeDeviations : [];
  phase.repairAttempts = Array.isArray(phase.repairAttempts) ? phase.repairAttempts : [];
  return phase;
}

function migrateEvents(raw: unknown, revision: number): WorkflowEvent[] {
  if (!Array.isArray(raw)) return [];
  return boundEvents(raw.map((event, index) => {
    const item = event as Record<string, unknown>;
    if (typeof item.eventId === "string") return item as unknown as WorkflowEvent;
    return {
      eventId: `evt-migrated-${index}`,
      timestamp: typeof item.timestamp === "string" ? item.timestamp : timestamp(),
      actorId: "system",
      type: "legacy_event",
      workflowRevisionBefore: revision,
      workflowRevisionAfter: revision,
      summary: typeof item.message === "string" ? item.message : "Legacy workflow event."
    };
  }));
}

function transition(state: SequentialWorkflowState, nextState: WorkflowLifecycleState, message: string): SequentialWorkflowState {
  const next = structuredClone(state);
  next.state = nextState;
  next.updatedAt = timestamp();
  appendEvent(next, "workflow_state_changed", message);
  syncLifecycleDecision(next, nextState);
  return next;
}

function syncLifecycleDecision(state: SequentialWorkflowState, lifecycle: WorkflowLifecycleState): void {
  if (lifecycle === "awaiting_clarification") {
    setPendingDecision(state, {
      type: "clarification",
      question: state.clarification?.question ?? "What specific behaviour should change?",
      allowedActions: ["answer", "cancel-workflow"]
    });
    return;
  }
  if (lifecycle === "awaiting_approach_approval") {
    setPendingDecision(state, {
      type: "approach-approval",
      question: "Approve the persisted approach before Workflow Plan generation?",
      allowedActions: ["approve-approach", "revise-approach", "view-details", "cancel-workflow"]
    });
    return;
  }
  if (lifecycle === "awaiting_plan_approval") {
    setPendingDecision(state, {
      type: "workflow-plan-approval",
      question: "Approve the Workflow Plan structure and approval policy?",
      allowedActions: ["approve-plan", "revise-plan", "view-details", "cancel-workflow"]
    });
    return;
  }
  if (lifecycle === "reviewing") {
    setPendingDecision(state, {
      type: "final-review",
      integrationRevision: state.revision + 1,
      question: "Record the final integrated review against the persisted validation evidence?",
      allowedActions: ["record-review", "view-details", "cancel-workflow"]
    });
    return;
  }
  if (lifecycle === "awaiting_commit_approval") {
    setPendingDecision(state, {
      type: "final-completion",
      integrationRevision: state.revision + 1,
      question: "Complete the workflow after the passed final integrated review?",
      allowedActions: ["complete-workflow", "view-details", "cancel-workflow"]
    });
    return;
  }
  if (lifecycle === "blocked") {
    if (state.planningRun?.approvalBlockedReason) {
      setPendingDecision(state, {
        type: "planning-fallback-review",
        question: state.planningRun.approvalBlockedReason,
        allowedActions: ["retry-planning", "revise-plan", "view-details", "cancel-workflow"]
      });
      return;
    }
    setPendingDecision(state, {
      type: "execution-recovery",
      question: state.blockers[0] ?? "Choose a safe recovery action for the blocked workflow.",
      allowedActions: ["view-details", "retry-execution", "revise-plan", "cancel-workflow"]
    });
    return;
  }
  if (lifecycle === "completed" || lifecycle === "cancelled") {
    resolvePendingDecision(state, lifecycle === "completed" ? "approved" : "cancelled", lifecycle === "completed" ? "complete-workflow" : "cancel-workflow", "user");
  }
}

function assertState(state: SequentialWorkflowState, allowed: WorkflowLifecycleState[]): void {
  if (!allowed.includes(state.state)) {
    throw new InvalidTransitionError(`Invalid transition from ${state.state}. Allowed state(s): ${allowed.join(", ")}.`);
  }
}

function workflowPath(root: string, workflowId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(workflowId)) throw new WorkflowNotFoundError(`Invalid workflow ID: ${workflowId}`);
  return path.join(path.resolve(root), WORKFLOW_DIR, `${workflowId}.json`);
}

function workflowId(): string {
  return `lr-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function label(mode: WorkflowMode): string {
  return mode[0].toUpperCase() + mode.slice(1);
}

function timestamp(): string {
  return new Date().toISOString();
}

const PHASE_APPROVAL_ACTIONS: PhaseApprovalDecision["allowedActions"] = [
  "approve-phase",
  "revise-phase-brief",
  "view-details",
  "cancel-workflow"
];

function persistPhaseBriefOutcome(
  state: SequentialWorkflowState,
  phase: WorkflowPhase,
  outcome: PhaseBriefGenerationOutcome,
  requiresApproval: boolean
): void {
  state.phaseBriefs ??= {};
  state.phaseBriefFailures ??= {};
  const blockerPrefix = `Phase brief ${phase.id}:`;
  state.blockers = state.blockers.filter((blocker) => !blocker.startsWith(blockerPrefix));

  if (outcome.status === "blocked") {
    const current = state.phaseBriefs[phase.id];
    if (current) current.approvalStatus = "stale";
    state.phaseBriefFailures[phase.id] = outcome.failure;
    state.blockers = unique([...state.blockers, `${blockerPrefix} ${outcome.failure.message}`]);
    supersedePendingPhaseApproval(state);
    const planningFailure = outcome.failure.failureOwnership === "leanrigor_generation_failure";
    const planInsufficiency = outcome.failure.diagnostics.some((item) =>
      item.code.startsWith("dependency.") || item.code.startsWith("scope."));
    const allowedActions = [
      ...(!planningFailure && outcome.failure.recoveryAttempts?.at(-1)?.disposition !== "skipped-identical" ? ["retry-brief"] : []),
      ...(planInsufficiency ? ["revise-plan"] : []),
      "view-details",
      "cancel-workflow"
    ];
    const question = planningFailure
      ? "LeanRigor could not produce a valid phase brief from the available evidence. This is a LeanRigor planning failure, not a rejected user decision. The approved Workflow Plan remains intact."
      : outcome.failure.message;
    setPendingDecision(state, {
      type: "execution-recovery",
      phaseId: phase.id,
      question,
      allowedActions
    });
    appendEvent(state, "phase_brief_blocked", `${outcome.failure.message} ${outcome.failure.diagnostics.map((item) => item.message).join(" ")}`, phase.id);
    return;
  }

  const brief = outcome.brief;
  const material = brief.materialChangesFromWorkflowPlan.filter((change) => change.material);
  delete state.phaseBriefFailures[phase.id];
  brief.approvalStatus = requiresApproval || material.length > 0 ? "pending" : "approved";
  state.phaseBriefs[phase.id] = brief;
  appendEvent(state, "phase_brief_generated", `Phase ${phase.id} detailed execution brief revision ${brief.briefRevision} generated from ${brief.inspectionResult.filesRead.length} bounded reads.`, phase.id);
  appendEvent(state, "phase_brief_validated", `Phase ${phase.id} brief revision ${brief.briefRevision} passed deterministic quality validation.`, phase.id);
  if (material.length > 0) {
    appendEvent(state, "phase_brief_material_drift", `Phase ${phase.id} brief records ${material.length} material change candidate(s).`, phase.id);
    setPendingMaterialDriftReview(state, brief);
    appendEvent(state, "phase_material_drift_review_required", `Phase ${phase.id} brief revision ${brief.briefRevision} requires Workflow Plan revision or a scope-preserving brief revision.`, phase.id);
    return;
  }
  if (requiresApproval) {
    setPendingPhaseApproval(state, brief);
    appendEvent(state, "phase_approval_required", `Phase ${phase.id} brief revision ${brief.briefRevision} requires explicit approval.`, phase.id);
  }
}

function setPendingPhaseApproval(state: SequentialWorkflowState, brief: NonNullable<SequentialWorkflowState["phaseBriefs"]>[string]): void {
  if (!state.approval) throw new WorkflowStateError("Cannot request phase approval before the Workflow Plan is approved.");
  setPendingDecision(state, {
    type: "phase-brief-approval",
    workflowRevision: brief.workflowRevision,
    stateRevision: state.revision + 1,
    phaseId: brief.phaseId,
    briefRevision: brief.briefRevision,
    question: `Review and approve ${brief.phaseId} Execution Brief revision ${brief.briefRevision}?`,
    allowedActions: [...PHASE_APPROVAL_ACTIONS],
    source: "system"
  });
}

function setPendingMaterialDriftReview(state: SequentialWorkflowState, brief: NonNullable<SequentialWorkflowState["phaseBriefs"]>[string]): void {
  if (!state.approval) throw new WorkflowStateError("Cannot request material drift review before the Workflow Plan is approved.");
  setPendingDecision(state, {
    type: "material-drift-review",
    workflowRevision: brief.workflowRevision,
    stateRevision: state.revision + 1,
    phaseId: brief.phaseId,
    briefRevision: brief.briefRevision,
    question: `Phase ${brief.phaseId} Execution Brief revision ${brief.briefRevision} contains material changes from the approved Workflow Plan. Revise the plan or revise the brief to remain within it.`,
    allowedActions: ["revise-plan", "revise-phase-brief", "view-details", "cancel-workflow"],
    source: "system"
  });
}

function supersedePendingPhaseApproval(state: SequentialWorkflowState): void {
  resolvePendingPhaseApproval(state, "superseded");
}

function resolvePendingPhaseApproval(state: SequentialWorkflowState, status: "superseded" | "cancelled"): void {
  resolvePendingDecision(state, status, undefined, "system");
}

function resolveDecisionAction(
  state: SequentialWorkflowState,
  action: string,
  mutation: MutationOptions | undefined,
  status: "approved" | "answered" | "superseded" | "cancelled",
  expectedType?: WorkflowDecisionType
): void {
  const current = state.approval?.pendingDecision;
  if (!current) {
    if (mutation?.decisionId) resolvePendingDecision(state, status, action, "controller", mutation.decisionId);
    return;
  }
  if (expectedType && current.type !== expectedType && !mutation?.decisionId) {
    resolvePendingDecision(state, "superseded", undefined, "system");
    return;
  }
  if (expectedType) requirePendingDecision(state, expectedType, action, mutation?.decisionId);
  else if (!(current.allowedActions as string[]).includes(action)) {
    throw new InvalidTransitionError(`Action ${action} is not allowed for decision ${current.id}. Refresh the workflow before answering.`);
  }
  resolvePendingDecision(state, status, action, mutation?.decisionId ? "controller" : "user", mutation?.decisionId);
}

function formatDispatchBlockers(blockers: Array<{ code: string; message: string }>): string {
  return blockers.length > 0
    ? `Phase dispatch blocked: ${blockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join("; ")}`
    : "Phase dispatch blocked.";
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function assertModelTierAvailable(tier: ModelTier, config: LeanRigorConfig, adapter: "claude" = "claude"): void {
  const resolved = resolveModelTier(tier, adapter, config);
  if (config.models.failIfUnavailable && tier !== "inherit" && !resolved.model) {
    throw new WorkflowStateError(`Model tier '${tier}' is unavailable for ${adapter}. Configure it with 'leanrigor models'.`);
  }
}
