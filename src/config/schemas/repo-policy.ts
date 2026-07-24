import { z } from "zod";
import { modelTierSchema } from "../schema.js";

const workflowMode = z.enum(["adaptive", "fast", "standard", "rigorous"]);
const reviewLevel = z.enum(["sanity", "integrated", "deep", "specialist"]);

/**
 * Shareable repository policy schema.
 * Stored at <repo>/leanrigor.config.json — may be committed.
 *
 * Contains project safety policy, minimum capability tiers,
 * risk escalation rules, required validation, workflow constraints,
 * and mandatory approvals. Must not contain machine-specific paths,
 * credentials, or concrete vendor model IDs.
 */
export const repoPolicyConfigSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1).default(1),

  /** Workflow behaviour defaults and safety constraints. */
  workflow: z.object({
    defaultMode: workflowMode.optional(),
    allowUserOverride: z.boolean().optional(),
    automaticTriage: z.boolean().optional()
  }).prefault({}),

  /**
   * Minimum capability tiers required for each task class.
   * The strongest (highest) tier requirement wins — user/local
   * preferences cannot downgrade these.
   */
  minimumTiers: z.object({
    triage: modelTierSchema.optional(),
    planning: modelTierSchema.optional(),
    implementation: modelTierSchema.optional(),
    review: modelTierSchema.optional()
  }).prefault({}),

  /** Tier fallback chain when the preferred tier is unavailable. */
  modelFallback: z.object({
    small: z.array(modelTierSchema).default(["medium", "inherit"]),
    medium: z.array(modelTierSchema).default(["large", "inherit"]),
    large: z.array(modelTierSchema).default(["inherit"])
  }).prefault({}),

  /** Routing — which tier to use for each workflow step. */
  routing: z.object({
    triage: modelTierSchema.optional(),
    repositoryInspection: modelTierSchema.optional(),
    clarification: modelTierSchema.optional(),
    fastImplementation: modelTierSchema.optional(),
    standardPlanning: modelTierSchema.optional(),
    standardImplementation: modelTierSchema.optional(),
    rigorousPlanning: modelTierSchema.optional(),
    rigorousImplementation: modelTierSchema.optional(),
    integratedReview: modelTierSchema.optional(),
    highRiskReview: modelTierSchema.optional(),
    commitPlanning: modelTierSchema.optional()
  }).prefault({}),

  /** Safety and risk policy. */
  safety: z.object({
    /** Path patterns that trigger Rigorous mode automatically. */
    rigorousPaths: z.array(z.string()).optional(),
    /** Path patterns that must never be modified. */
    protectedPaths: z.array(z.string()).optional(),
    /** Require completion evidence before phase gates pass. */
    requireEvidence: z.boolean().optional(),
    /** Require validation commands to run and pass. */
    requireValidation: z.boolean().optional(),
    /** Maximum repair attempts per mode (policy caps). */
    maxRepairAttempts: z.object({
      fast: z.number().int().min(0).optional(),
      standard: z.number().int().min(0).optional(),
      rigorous: z.number().int().min(0).optional()
    }).prefault({})
  }).prefault({}),

  /** Maximum permitted parallelism — caps user/local values. */
  parallelism: z.object({
    maxPhases: z.number().int().min(1).max(16).optional(),
    maxAgents: z.number().int().min(1).max(16).optional()
  }).prefault({}),

  /** Review policy per workflow mode. */
  review: z.object({
    fast: reviewLevel.optional(),
    standard: reviewLevel.optional(),
    rigorous: reviewLevel.optional(),
    multiAgent: reviewLevel.optional(),
    highRiskPaths: reviewLevel.optional(),
    allowUserOverride: z.boolean().optional()
  }).prefault({}),

  /** Testing requirements per change category. */
  testing: z.object({
    bugFixes: z.enum(["optional", "recommended", "regression-required"]).optional(),
    publicApi: z.enum(["optional", "recommended", "contract-required"]).optional(),
    uiCopy: z.enum(["optional", "recommended"]).optional()
  }).prefault({}),

  /** Completion gate policy. */
  completionGate: z.object({
    enabled: z.boolean().optional(),
    requireEvidence: z.boolean().optional(),
    requireValidation: z.boolean().optional(),
    allowSkippedValidation: z.object({
      fast: z.boolean().optional(),
      standard: z.boolean().optional(),
      rigorous: z.boolean().optional()
    }).prefault({})
  }).prefault({}),

  /** Task sizing constraints. */
  taskSizing: z.object({
    maxPrimaryObjectives: z.number().int().min(1).optional(),
    preferredWriteFiles: z.number().int().min(1).optional(),
    reviewSplitThresholdFiles: z.number().int().min(1).optional()
  }).prefault({}),

  /** Introspection settings. */
  introspection: z.object({
    preflight: z.enum(["always", "mode-based", "manual"]).optional(),
    deepReflection: z.enum(["triggered", "always", "manual"]).optional(),
    triggerAfterFailedRepairs: z.number().int().min(1).max(10).optional(),
    triggerOnScopeExpansion: z.boolean().optional(),
    triggerOnArchitectureChange: z.boolean().optional()
  }).prefault({}),

  /** Triage policy. */
  triage: z.object({
    chooseLowestSafeMode: z.boolean().optional(),
    requireExplicitRigorousTrigger: z.boolean().optional(),
    fastRequiresPositiveEvidence: z.boolean().optional(),
    highConfidenceThreshold: z.number().min(0).max(1).optional(),
    mediumConfidenceThreshold: z.number().min(0).max(1).optional(),
    maxEscalationReasons: z.number().int().min(1).max(5).optional(),
    maxAssumptions: z.number().int().min(0).max(5).optional(),
    maxInspectionTargets: z.number().int().min(0).max(10).optional(),
    fallbackMode: z.enum(["standard", "rigorous"]).optional()
  }).prefault({}),

  /** Git safety constraints. */
  git: z.object({
    autoCommit: z.literal(false).optional(),
    requireConfirmation: z.boolean().optional(),
    commitStyle: z.enum(["conventional", "plain"]).optional()
  }).prefault({}),

  /** Budget constraints. */
  budgets: z.object({
    clarificationQuestions: z.number().int().min(0).optional(),
    options: z.number().int().min(1).max(5).optional(),
    reviewRounds: z.number().int().min(0).optional(),
    repairRounds: z.number().int().min(0).optional(),
    triageCalls: z.number().int().min(1).max(3).optional()
  }).prefault({})
});

export type RepoPolicyConfig = z.infer<typeof repoPolicyConfigSchema>;
