import type { LeanRigorConfig } from "./schema.js";
import type { RepoPolicyConfig } from "./schemas/repo-policy.js";
import type { UserConfig } from "./schemas/user.js";

/**
 * Merge rule categories for precedence and constraint enforcement.
 *
 * - `preference`: higher-precedence value wins (standard override)
 * - `minimum_tier`: strongest (highest tier) requirement wins
 * - `maximum`: lowest permitted maximum wins (safety cap)
 * - `mandatory`: boolean — true from any source means enabled; repo policy
 *    true cannot be overridden to false by lower-precedence sources
 * - `union`: arrays are concatenated (union)
 */

export type MergeRule = "preference" | "minimum_tier" | "maximum" | "mandatory" | "union";

/**
 * Merge two values based on the rule.
 * `lower` is from the lower-precedence source.
 * `higher` is from the higher-precedence source.
 */
export function mergeValue<T>(
  lower: T | undefined,
  higher: T | undefined,
  rule: MergeRule
): T | undefined {
  if (higher !== undefined && lower === undefined) return higher;
  if (lower !== undefined && higher === undefined) return lower;
  if (lower === undefined && higher === undefined) return undefined;

  switch (rule) {
    case "preference":
      return higher !== undefined ? higher : lower;

    case "maximum":
      // For numeric caps: the lowest permitted maximum wins
      if (typeof lower === "number" && typeof higher === "number") {
        return (Math.min(lower, higher) as unknown as T);
      }
      return higher !== undefined ? higher : lower;

    case "minimum_tier": {
      const tierOrder: Record<string, number> = {
        inherit: 0, small: 1, medium: 2, large: 3
      };
      const l = typeof lower === "string" ? (tierOrder[lower] ?? 0) : 0;
      const h = typeof higher === "string" ? (tierOrder[higher] ?? 0) : 0;
      return (h >= l ? higher : lower) as unknown as T;
    }

    case "mandatory":
      // true wins; if repo says true, it stays true
      return ((lower as unknown as boolean) || (higher as unknown as boolean)) as unknown as T;

    case "union":
      if (Array.isArray(lower) && Array.isArray(higher)) {
        return [...new Set([...lower, ...higher])] as unknown as T;
      }
      return higher !== undefined ? higher : lower;

    default:
      return higher !== undefined ? higher : lower;
  }
}

/**
 * Merge a RepoPolicyConfig over a UserConfig (or built-in defaults)
 * producing a partial LeanRigorConfig with constraint enforcement.
 *
 * The repo policy acts as a safety filter: it can require higher minimums
 * and lower maximums but cannot be weakened by user preferences.
 */
export function applyRepoPolicy(
  base: LeanRigorConfig,
  policy: RepoPolicyConfig
): { config: LeanRigorConfig; constraints: string[] } {
  const constraints: string[] = [];
  const config = structuredClone(base);

  // --- Minimum tiers (strongest requirement wins) ---
  if (policy.minimumTiers?.triage) {
    const baseTier = config.routing.triage;
    const policyTier = policy.minimumTiers.triage;
    const resolved = mergeValue(baseTier, policyTier, "minimum_tier");
    if (resolved !== baseTier) {
      constraints.push(`routing.triage: repo policy requires minimum tier ${policyTier} (was ${baseTier})`);
      config.routing.triage = resolved!;
    }
  }

  // --- Maximum parallelism (lowest cap wins) ---
  if (policy.parallelism?.maxPhases !== undefined) {
    const cap = policy.parallelism.maxPhases;
    if (config.execution.maxParallelPhases > cap) {
      constraints.push(`execution.maxParallelPhases: capped at ${cap} by repo policy (was ${config.execution.maxParallelPhases})`);
      config.execution.maxParallelPhases = cap;
    }
  }
  if (policy.parallelism?.maxAgents !== undefined) {
    const cap = policy.parallelism.maxAgents;
    if (config.parallelism.maxAgents > cap) {
      constraints.push(`parallelism.maxAgents: capped at ${cap} by repo policy (was ${config.parallelism.maxAgents})`);
      config.parallelism.maxAgents = cap;
    }
  }

  // --- Safety constraints: mandatory gates ---
  if (policy.safety?.requireEvidence === true) {
    config.completionGate.requireEvidence = true;
    constraints.push("completionGate.requireEvidence: forced enabled by repo policy");
  }
  if (policy.safety?.requireValidation === true) {
    config.completionGate.requireValidation = true;
    constraints.push("completionGate.requireValidation: forced enabled by repo policy");
  }
  if (policy.safety?.maxRepairAttempts) {
    for (const mode of ["fast", "standard", "rigorous"] as const) {
      const cap = policy.safety.maxRepairAttempts[mode];
      if (cap !== undefined && config.completionGate.maxRepairAttempts[mode] > cap) {
        constraints.push(`completionGate.maxRepairAttempts.${mode}: capped at ${cap} by repo policy`);
        config.completionGate.maxRepairAttempts[mode] = cap;
      }
    }
  }

  // --- Mandatory completion gate ---
  if (policy.completionGate?.enabled === true && !config.completionGate.enabled) {
    config.completionGate.enabled = true;
    constraints.push("completionGate.enabled: forced enabled by repo policy");
  }

  // --- Copy policy settings into config where they provide values ---
  if (policy.workflow?.defaultMode) config.workflow.defaultMode = policy.workflow.defaultMode;
  if (policy.workflow?.allowUserOverride !== undefined) config.workflow.allowUserOverride = policy.workflow.allowUserOverride;
  if (policy.workflow?.automaticTriage !== undefined) config.workflow.automaticTriage = policy.workflow.automaticTriage;

  if (policy.safety?.rigorousPaths) config.risk.rigorousPaths = policy.safety.rigorousPaths;
  if (policy.safety?.protectedPaths) config.risk.protectedPaths = policy.safety.protectedPaths;

  if (policy.completionGate?.allowSkippedValidation) {
    if (policy.completionGate.allowSkippedValidation.fast !== undefined)
      config.completionGate.allowSkippedValidation.fast = policy.completionGate.allowSkippedValidation.fast;
    if (policy.completionGate.allowSkippedValidation.standard !== undefined)
      config.completionGate.allowSkippedValidation.standard = policy.completionGate.allowSkippedValidation.standard;
    if (policy.completionGate.allowSkippedValidation.rigorous !== undefined)
      config.completionGate.allowSkippedValidation.rigorous = policy.completionGate.allowSkippedValidation.rigorous;
  }

  if (policy.review) {
    if (policy.review.fast) config.review.fast = policy.review.fast as typeof config.review.fast;
    if (policy.review.standard) config.review.standard = policy.review.standard as typeof config.review.standard;
    if (policy.review.rigorous) config.review.rigorous = policy.review.rigorous as typeof config.review.rigorous;
    if (policy.review.multiAgent) config.review.multiAgent = policy.review.multiAgent as typeof config.review.multiAgent;
    if (policy.review.highRiskPaths) config.review.highRiskPaths = policy.review.highRiskPaths as typeof config.review.highRiskPaths;
    if (policy.review.allowUserOverride !== undefined) config.review.allowUserOverride = policy.review.allowUserOverride;
  }

  if (policy.testing) {
    if (policy.testing.bugFixes) config.testing.bugFixes = policy.testing.bugFixes;
    if (policy.testing.publicApi) config.testing.publicApi = policy.testing.publicApi;
    if (policy.testing.uiCopy) config.testing.uiCopy = policy.testing.uiCopy;
  }

  if (policy.taskSizing) {
    if (policy.taskSizing.maxPrimaryObjectives !== undefined) config.taskSizing.maxPrimaryObjectives = policy.taskSizing.maxPrimaryObjectives;
    if (policy.taskSizing.preferredWriteFiles !== undefined) config.taskSizing.preferredWriteFiles = policy.taskSizing.preferredWriteFiles;
    if (policy.taskSizing.reviewSplitThresholdFiles !== undefined) config.taskSizing.reviewSplitThresholdFiles = policy.taskSizing.reviewSplitThresholdFiles;
  }

  if (policy.introspection) {
    if (policy.introspection.preflight) config.introspection.preflight = policy.introspection.preflight;
    if (policy.introspection.deepReflection) config.introspection.deepReflection = policy.introspection.deepReflection;
    if (policy.introspection.triggerAfterFailedRepairs !== undefined) config.introspection.triggerAfterFailedRepairs = policy.introspection.triggerAfterFailedRepairs;
    if (policy.introspection.triggerOnScopeExpansion !== undefined) config.introspection.triggerOnScopeExpansion = policy.introspection.triggerOnScopeExpansion;
    if (policy.introspection.triggerOnArchitectureChange !== undefined) config.introspection.triggerOnArchitectureChange = policy.introspection.triggerOnArchitectureChange;
  }

  if (policy.triage) {
    if (policy.triage.chooseLowestSafeMode !== undefined) config.triage.chooseLowestSafeMode = policy.triage.chooseLowestSafeMode;
    if (policy.triage.requireExplicitRigorousTrigger !== undefined) config.triage.requireExplicitRigorousTrigger = policy.triage.requireExplicitRigorousTrigger;
    if (policy.triage.fallbackMode) config.triage.fallbackMode = policy.triage.fallbackMode;
    if (policy.triage.highConfidenceThreshold !== undefined) config.triage.highConfidenceThreshold = policy.triage.highConfidenceThreshold;
    if (policy.triage.mediumConfidenceThreshold !== undefined) config.triage.mediumConfidenceThreshold = policy.triage.mediumConfidenceThreshold;
    if (policy.triage.maxEscalationReasons !== undefined) config.triage.maxEscalationReasons = policy.triage.maxEscalationReasons;
    if (policy.triage.maxAssumptions !== undefined) config.triage.maxAssumptions = policy.triage.maxAssumptions;
    if (policy.triage.maxInspectionTargets !== undefined) config.triage.maxInspectionTargets = policy.triage.maxInspectionTargets;
    if (policy.triage.fastRequiresPositiveEvidence !== undefined) config.triage.fastRequiresPositiveEvidence = policy.triage.fastRequiresPositiveEvidence;
  }

  if (policy.git) {
    if (policy.git.requireConfirmation !== undefined) config.git.requireConfirmation = policy.git.requireConfirmation;
    if (policy.git.commitStyle) config.git.commitStyle = policy.git.commitStyle;
  }

  if (policy.budgets) {
    if (policy.budgets.clarificationQuestions !== undefined) config.budgets.clarificationQuestions = policy.budgets.clarificationQuestions;
    if (policy.budgets.options !== undefined) config.budgets.options = policy.budgets.options;
    if (policy.budgets.reviewRounds !== undefined) config.budgets.reviewRounds = policy.budgets.reviewRounds;
    if (policy.budgets.repairRounds !== undefined) config.budgets.repairRounds = policy.budgets.repairRounds;
    if (policy.budgets.triageCalls !== undefined) config.budgets.triageCalls = policy.budgets.triageCalls;
  }

  if (policy.routing) {
    for (const key of Object.keys(policy.routing) as Array<keyof typeof policy.routing>) {
      const val = policy.routing[key];
      if (val !== undefined) {
        (config.routing as Record<string, unknown>)[key] = val;
      }
    }
  }

  return { config, constraints };
}

/**
 * Apply user config preferences over the base config.
 * User prefs are simple preference overrides — no safety enforcement.
 */
export function applyUserConfig(
  base: LeanRigorConfig,
  user: UserConfig
): LeanRigorConfig {
  const config = structuredClone(base);

  // Model mappings
  if (user.models?.claude?.small) config.models.tiers.small.claude = user.models.claude.small;
  if (user.models?.claude?.medium) config.models.tiers.medium.claude = user.models.claude.medium;
  if (user.models?.claude?.large) config.models.tiers.large.claude = user.models.claude.large;

  // Execution preferences
  if (user.execution?.pollIntervalSeconds !== undefined)
    config.execution.pollIntervalSeconds = user.execution.pollIntervalSeconds;
  if (user.execution?.workerTimeoutSeconds !== undefined)
    config.execution.workerTimeoutSeconds = user.execution.workerTimeoutSeconds;
  if (user.execution?.heartbeatGraceSeconds !== undefined)
    config.execution.heartbeatGraceSeconds = user.execution.heartbeatGraceSeconds;
  if (user.execution?.phaseLeaseTimeoutSeconds !== undefined)
    config.execution.phaseLeaseTimeoutSeconds = user.execution.phaseLeaseTimeoutSeconds;
  if (user.execution?.workflowLockTimeoutSeconds !== undefined)
    config.execution.workflowLockTimeoutSeconds = user.execution.workflowLockTimeoutSeconds;
  if (user.execution?.parallelism !== undefined)
    config.execution.maxParallelPhases = user.execution.parallelism;
  if (user.paths?.workspaceRoot !== undefined)
    config.execution.workspaceRoot = user.paths.workspaceRoot;

  return config;
}
