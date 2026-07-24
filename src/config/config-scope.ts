import path from "node:path";
import { homedir } from "node:os";

/** Configuration scope — where a value originates in the precedence chain. */
export const ConfigScope = {
  /** CLI flags (highest precedence) */
  Cli: "cli",
  /** Environment variables: LEANRIGOR_*, ANTHROPIC_DEFAULT_* */
  Env: "env",
  /** Private per-repository config: .leanrigor/config.json */
  Local: "local",
  /** Shareable committed repository policy: leanrigor.config.json */
  RepoPolicy: "repo",
  /** User-wide preferences: ~/.config/leanrigor/config.json */
  User: "user",
  /** Adapter-derived defaults (Claude: ANTHROPIC_DEFAULT_* → alias) */
  Adapter: "adapter",
  /** Hard-coded built-in defaults */
  Builtin: "builtin"
} as const;

export type ConfigScope = (typeof ConfigScope)[keyof typeof ConfigScope];

/** Ordered from lowest to highest precedence. */
export const PRECEDENCE: readonly ConfigScope[] = [
  ConfigScope.Builtin,
  ConfigScope.Adapter,
  ConfigScope.User,
  ConfigScope.RepoPolicy,
  ConfigScope.Local,
  ConfigScope.Env,
  ConfigScope.Cli
];

/** Return the path for a given scope and repository root. */
export function scopePath(scope: ConfigScope, root: string): string {
  switch (scope) {
    case ConfigScope.User:
      return path.join(homedir(), ".config", "leanrigor", "config.json");
    case ConfigScope.RepoPolicy:
      return path.join(root, "leanrigor.config.json");
    case ConfigScope.Local:
      return path.join(root, ".leanrigor", "config.json");
    default:
      throw new Error(`Scope ${scope} does not have a file path.`);
  }
}

/** Scope names used in user-facing output. */
export function scopeLabel(scope: ConfigScope): string {
  switch (scope) {
    case ConfigScope.Cli: return "CLI flag";
    case ConfigScope.Env: return "environment variable";
    case ConfigScope.Local: return "repository-local config";
    case ConfigScope.RepoPolicy: return "committed repository policy";
    case ConfigScope.User: return "user config (~/.config/leanrigor/config.json)";
    case ConfigScope.Adapter: return "adapter-derived default";
    case ConfigScope.Builtin: return "built-in default";
  }
}

/**
 * Settings that must not appear in committed repository policy.
 * These trigger a validation error if found in leanrigor.config.json.
 */
export const REPO_POLICY_FORBIDDEN_KEYS: readonly string[] = [
  "$schema",
  "version",
  "models.tiers.small.claude",
  "models.tiers.medium.claude",
  "models.tiers.large.claude",
  "models.tiers.small.opencode",
  "models.tiers.medium.opencode",
  "models.tiers.large.opencode",
  "execution.workspaceRoot",
  "execution.maxWorkspacePathLength",
  "execution.workspaceBranchPrefix",
  "execution.internalCommitSigning",
  "instructions"
];

/**
 * Settings that represent safety constraints. The strongest (most restrictive)
 * value wins regardless of precedence.
 */
export const SAFETY_CONSTRAINT_KEYS: readonly string[] = [
  "parallelism.maxPhases",
  "parallelism.maxAgents",
  "completionGate.requireEvidence",
  "completionGate.requireValidation",
  "completionGate.enabled",
  "safety.requireEvidence",
  "safety.requireValidation"
];

/**
 * Minimum-tier settings. The highest tier requirement wins.
 */
export const MINIMUM_TIER_KEYS: readonly string[] = [
  "minimumTiers.triage",
  "minimumTiers.planning",
  "minimumTiers.implementation",
  "minimumTiers.review"
];

/** Tier ordering for minimum comparison. */
const TIER_ORDER: Record<string, number> = {
  inherit: 0,
  small: 1,
  medium: 2,
  large: 3
};

export function strongerTier(a: string, b: string): string {
  return (TIER_ORDER[a] ?? 0) >= (TIER_ORDER[b] ?? 0) ? a : b;
}
