import type { LeanRigorConfig, ModelTier } from "./schema.js";

export type Harness = "claude" | "opencode";

const ENV_PREFIX: Record<Harness, string> = {
  claude: "LEANRIGOR_CLAUDE_MODEL_",
  opencode: "LEANRIGOR_OPENCODE_MODEL_"
};

export interface ResolvedModel {
  tier: ModelTier;
  model?: string;
  source: "inherit" | "platform-env" | "generic-env" | "config";
}

export class ModelConfigurationError extends Error {}

export function resolveModelTier(tier: ModelTier, harness: Harness, config: LeanRigorConfig): ResolvedModel {
  if (tier === "inherit") return { tier, source: "inherit" };
  const suffix = tier.toUpperCase();
  const platform = process.env[`${ENV_PREFIX[harness]}${suffix}`]?.trim();
  if (platform) return { tier, model: platform, source: "platform-env" };
  const generic = process.env[`LEANRIGOR_MODEL_${suffix}`]?.trim();
  if (generic) return { tier, model: generic, source: "generic-env" };
  const configured = config.models.tiers[tier][harness]?.trim();
  if (configured) return { tier, model: configured, source: "config" };
  if (config.models.failIfUnavailable) {
    throw new ModelConfigurationError(
      `No ${harness} model is configured for tier '${tier}'. Run 'leanrigor init models' or set ` +
      `LEANRIGOR_${harness.toUpperCase()}_MODEL_${suffix}.`
    );
  }
  return { tier, source: "inherit" };
}

export function isClaudeAlias(model: string): boolean {
  return ["haiku", "sonnet", "opus", "default"].includes(model);
}
