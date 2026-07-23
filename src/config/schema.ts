import { z } from "zod";

export const modelTierSchema = z.enum(["small", "medium", "large", "inherit"]);
const workflowMode = z.enum(["adaptive", "fast", "standard", "rigorous"]);
const adapterModelMap = z.object({
  claude: z.string().min(1).optional(),
  opencode: z.string().min(1).optional()
});

export const leanRigorConfigSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1).default(1),
  workflow: z.object({
    defaultMode: workflowMode.default("adaptive"),
    allowUserOverride: z.boolean().default(true),
    automaticTriage: z.boolean().default(true)
  }).prefault({}),
  models: z.object({
    tiers: z.object({
      small: adapterModelMap.default({ claude: "haiku" }),
      medium: adapterModelMap.default({ claude: "sonnet" }),
      large: adapterModelMap.default({ claude: "opus" }),
      inherit: adapterModelMap.default({})
    }).prefault({}),
    failIfUnavailable: z.boolean().default(true),
    fallback: z.object({
      small: z.array(modelTierSchema).default(["medium", "inherit"]),
      medium: z.array(modelTierSchema).default(["large", "inherit"]),
      large: z.array(modelTierSchema).default(["inherit"])
    }).prefault({})
  }).prefault({}),
  routing: z.object({
    triage: modelTierSchema.default("small"),
    repositoryInspection: modelTierSchema.default("small"),
    clarification: modelTierSchema.default("small"),
    fastImplementation: modelTierSchema.default("inherit"),
    standardPlanning: modelTierSchema.default("medium"),
    standardImplementation: modelTierSchema.default("medium"),
    rigorousPlanning: modelTierSchema.default("large"),
    rigorousImplementation: modelTierSchema.default("large"),
    integratedReview: modelTierSchema.default("medium"),
    highRiskReview: modelTierSchema.default("large"),
    commitPlanning: modelTierSchema.default("small")
  }).prefault({}),
  instructions: z.array(z.string()).default([]),
  risk: z.object({
    rigorousPaths: z.array(z.string()).default(["auth/**", "payments/**", "migrations/**", "infrastructure/production/**"]),
    protectedPaths: z.array(z.string()).default([".git/**", ".env", "secrets/**"])
  }).prefault({}),
  testing: z.object({
    bugFixes: z.enum(["optional", "recommended", "regression-required"]).default("regression-required"),
    publicApi: z.enum(["optional", "recommended", "contract-required"]).default("contract-required"),
    uiCopy: z.enum(["optional", "recommended"]).default("optional")
  }).prefault({}),
  completionGate: z.object({
    enabled: z.boolean().default(true),
    requireEvidence: z.boolean().default(true),
    requireValidation: z.boolean().default(true),
    allowSkippedValidation: z.object({
      fast: z.boolean().default(true),
      standard: z.boolean().default(false),
      rigorous: z.boolean().default(false)
    }).prefault({}),
    maxRepairAttempts: z.object({
      fast: z.number().int().min(0).default(1),
      standard: z.number().int().min(0).default(2),
      rigorous: z.number().int().min(0).default(2)
    }).prefault({})
  }).prefault({}),
  taskSizing: z.object({
    maxPrimaryObjectives: z.number().int().min(1).default(1),
    preferredWriteFiles: z.number().int().min(1).default(5),
    reviewSplitThresholdFiles: z.number().int().min(1).default(8),
    requireSplitWhen: z.array(z.string()).default([
      "multiple architectural boundaries",
      "independent backend and frontend outcomes",
      "database migration plus application behaviour",
      "public contract plus consumer updates",
      "implementation mixed with unrelated refactoring"
    ])
  }).prefault({}),
  introspection: z.object({
    preflight: z.enum(["always", "mode-based", "manual"]).default("always"),
    deepReflection: z.enum(["triggered", "always", "manual"]).default("triggered"),
    triggerAfterFailedRepairs: z.number().int().min(1).max(10).default(2),
    triggerOnScopeExpansion: z.boolean().default(true),
    triggerOnArchitectureChange: z.boolean().default(true)
  }).prefault({}),
  review: z.object({
    fast: z.enum(["sanity", "integrated", "deep"]).default("sanity"),
    standard: z.enum(["sanity", "integrated", "deep"]).default("integrated"),
    rigorous: z.enum(["integrated", "deep", "specialist"]).default("deep"),
    multiAgent: z.enum(["integrated", "deep", "specialist"]).default("integrated"),
    highRiskPaths: z.enum(["deep", "specialist"]).default("deep"),
    allowUserOverride: z.boolean().default(true)
  }).prefault({}),
  triage: z.object({
    chooseLowestSafeMode: z.boolean().default(true),
    requireExplicitRigorousTrigger: z.boolean().default(true),
    fastRequiresPositiveEvidence: z.boolean().default(true),
    highConfidenceThreshold: z.number().min(0).max(1).default(0.8),
    mediumConfidenceThreshold: z.number().min(0).max(1).default(0.55),
    maxEscalationReasons: z.number().int().min(1).max(5).default(3),
    maxAssumptions: z.number().int().min(0).max(5).default(3),
    maxInspectionTargets: z.number().int().min(0).max(10).default(5),
    fallbackMode: z.enum(["standard", "rigorous"]).default("standard")
  }).prefault({}),
  parallelism: z.object({
    enabled: z.boolean().default(true),
    maxAgents: z.number().int().min(1).max(16).default(3),
    isolation: z.enum(["shared-worktree", "isolated-worktrees"]).default("shared-worktree"),
    forbidSharedWrites: z.boolean().default(true)
  }).prefault({}),
  execution: z.object({
    maxParallelPhases: z.number().int().min(1).max(16).default(1),
    workflowLockTimeoutSeconds: z.number().int().min(1).max(3600).default(30),
    phaseLeaseTimeoutSeconds: z.number().int().min(5).max(86400).default(900),
    writeReadConflictsBlock: z.boolean().default(true),
    sensitivePaths: z.array(z.string().min(1)).default([]),
    workspaceStrategy: z.enum(["none", "git-worktree"]).default("git-worktree"),
    workspaceRoot: z.string().min(1).nullable().default(null),
    retainCompletedPhaseWorktrees: z.boolean().default(true),
    retainIntegrationWorktree: z.boolean().default(true),
    integrationTransferStrategy: z.enum(["internal-commit"]).default("internal-commit"),
    workspaceBranchPrefix: z.string().regex(/^[A-Za-z0-9._/-]+$/).default("leanrigor"),
    maxWorkspacePathLength: z.number().int().min(80).max(1024).default(220),
    internalCommitSigning: z.enum(["disabled", "git-config"]).default("disabled")
  }).prefault({}),
  git: z.object({
    autoCommit: z.boolean().default(false),
    requireConfirmation: z.boolean().default(true),
    commitStyle: z.enum(["conventional", "plain"]).default("conventional")
  }).prefault({}),
  budgets: z.object({
    clarificationQuestions: z.number().int().min(0).default(3),
    options: z.number().int().min(1).max(5).default(3),
    reviewRounds: z.number().int().min(0).default(1),
    repairRounds: z.number().int().min(0).default(2),
    triageCalls: z.number().int().min(1).max(3).default(2)
  }).prefault({})
});

export type LeanRigorConfig = z.infer<typeof leanRigorConfigSchema>;
export type ModelTier = z.infer<typeof modelTierSchema>;
