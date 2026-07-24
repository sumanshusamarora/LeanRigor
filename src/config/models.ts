import type { LeanRigorConfig, ModelTier } from "./schema.js";

export type Harness = "claude" | "opencode";

/**
 * Adapter-specific environment variables checked before generic env vars.
 * Claude adapter uses the official ANTHROPIC_DEFAULT_* aliases.
 */
const CLAUDE_ADAPTER_ENV: Record<string, string> = {
  SMALL: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  MEDIUM: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  LARGE: "ANTHROPIC_DEFAULT_OPUS_MODEL"
};

/**
 * Claude alias fallbacks used when no environment or config provides a model.
 * These are the portable Claude model aliases, not concrete backend models.
 */
const CLAUDE_ALIAS_DEFAULTS: Record<string, string> = {
  SMALL: "haiku",
  MEDIUM: "sonnet",
  LARGE: "opus"
};

const ENV_PREFIX: Record<Harness, string> = {
  claude: "LEANRIGOR_CLAUDE_MODEL_",
  opencode: "LEANRIGOR_OPENCODE_MODEL_"
};

export interface ResolvedModel {
  tier: ModelTier;
  model?: string;
  source: "inherit" | "adapter-env" | "platform-env" | "generic-env" | "config" | "adapter-default";
}

export class ModelConfigurationError extends Error {}

/**
 * Resolve a portable model tier to a concrete model name for a given harness.
 *
 * Resolution order (first match wins):
 *   1. If tier is "inherit" → omit model (undefined)
 *   2. Adapter-specific environment (ANTHROPIC_DEFAULT_* for Claude)
 *   3. Platform-specific environment (LEANRIGOR_CLAUDE_MODEL_*, etc.)
 *   4. Generic LEANRIGOR_MODEL_* environment
 *   5. Configured model in LeanRigor config
 *   6. Adapter-derived default (haiku/sonnet/opus for Claude)
 *   7. If failIfUnavailable → throw; otherwise → inherit
 */
export function resolveModelTier(tier: ModelTier, harness: Harness, config: LeanRigorConfig): ResolvedModel {
  if (tier === "inherit") return { tier, source: "inherit" };
  const suffix = tier.toUpperCase();

  // 1. Platform-specific environment (LEANRIGOR_CLAUDE_MODEL_*, etc.)
  const platform = process.env[`${ENV_PREFIX[harness]}${suffix}`]?.trim();
  if (platform) return { tier, model: platform, source: "platform-env" };

  // 2. Generic LEANRIGOR_MODEL_* environment
  const generic = process.env[`LEANRIGOR_MODEL_${suffix}`]?.trim();
  if (generic) return { tier, model: generic, source: "generic-env" };

  // 3. Configured model in config (user/local)
  const configured = config.models.tiers[tier][harness]?.trim();
  if (configured) return { tier, model: configured, source: "config" };

  // 4. Adapter-specific environment (Claude: ANTHROPIC_DEFAULT_*)
  if (harness === "claude") {
    const adapterEnvKey = CLAUDE_ADAPTER_ENV[suffix];
    if (adapterEnvKey) {
      const adapterEnv = process.env[adapterEnvKey]?.trim();
      if (adapterEnv) return { tier, model: adapterEnv, source: "adapter-env" };
    }
  }

  // 5. Adapter-derived default (Claude aliases: haiku/sonnet/opus)
  if (harness === "claude") {
    const adapterDefault = CLAUDE_ALIAS_DEFAULTS[suffix];
    if (adapterDefault) return { tier, model: adapterDefault, source: "adapter-default" };
  }

  // 6. No resolution — fail or inherit
  if (config.models.failIfUnavailable) {
    throw new ModelConfigurationError(
      `No ${harness} model is configured for tier '${tier}'. Run 'leanrigor models' (or legacy 'leanrigor init models') or set ` +
      `LEANRIGOR_${harness.toUpperCase()}_MODEL_${suffix}.`
    );
  }
  return { tier, source: "inherit" };
}

export function isClaudeAlias(model: string): boolean {
  return ["haiku", "sonnet", "opus", "default"].includes(model);
}
