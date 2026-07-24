import {
  resolveModelTier,
  type Harness,
  type ModelSource,
} from "./models.js";
import type { LeanRigorConfig, ModelTier } from "./schema.js";

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/** Structured model-resolution info for display or serialisation. */
export interface ModelDisplayInfo {
  tier: ModelTier;
  /** The Claude alias this tier was resolved through (haiku/sonnet/opus). */
  adapterAlias: string | undefined;
  /** The concrete model string that will be passed to the harness. */
  resolvedModel: string | undefined;
  /** Raw source code from ResolvedModel. */
  source: ModelSource;
  /** Human-readable source label. */
  sourceLabel: string;
  /** True when the resolved model is a known Claude alias (not a concrete model ID). */
  isClaudeAlias: boolean;
}

// ---------------------------------------------------------------------------
// Source labels
// ---------------------------------------------------------------------------

/**
 * Map a model-resolution source code and tier to a human-readable label.
 *
 * When the source is an environment variable the label includes the specific
 * variable name (e.g. `ANTHROPIC_DEFAULT_OPUS_MODEL`) rather than a glob.
 */
export function modelSourceLabel(source: ModelSource, tier?: ModelTier, harness?: Harness): string {
  const suffix = tier ? tier.toUpperCase() : "SMALL";
  switch (source) {
    case "adapter-env": {
      if (harness === "claude") {
        const aliasName = suffix === "SMALL" ? "HAIKU" : suffix === "MEDIUM" ? "SONNET" : "OPUS";
        return `ANTHROPIC_DEFAULT_${aliasName}_MODEL`;
      }
      return "adapter environment variable";
    }
    case "platform-env": {
      const envVar = harness
        ? `LEANRIGOR_${harness.toUpperCase()}_MODEL_${suffix}`
        : `LEANRIGOR_*_MODEL_${suffix}`;
      return harness ? envVar : `platform environment variable`;
    }
    case "generic-env":
      return tier ? `LEANRIGOR_MODEL_${suffix}` : "LEANRIGOR_MODEL_* environment variable";
    case "config":
      return "LeanRigor configuration file";
    case "adapter-default":
      return "Claude alias fallback";
    case "inherit":
      return "inherited (no model specified)";
    default:
      return source;
  }
}

// ---------------------------------------------------------------------------
// Single-tier display
// ---------------------------------------------------------------------------

/**
 * Build a structured display-info object for a single model tier.
 */
export function formatModelResolution(
  tier: ModelTier,
  harness: Harness,
  config: LeanRigorConfig,
): ModelDisplayInfo {
  const resolved = resolveModelTier(tier, harness, config);
  const alias = resolved.adapterAlias;
  const model = resolved.resolvedModel ?? resolved.model;

  return {
    tier,
    adapterAlias: alias,
    resolvedModel: resolved.source === "inherit" ? undefined : model,
    source: resolved.source,
    sourceLabel: modelSourceLabel(resolved.source, tier, harness),
    isClaudeAlias: alias !== undefined && alias === model,
  };
}

/**
 * Return a single human-readable line describing model resolution for one tier.
 *
 * Formats (depending on data):
 *   small: haiku → deepseek-v4-flash (source: ANTHROPIC_DEFAULT_HAIKU_MODEL)
 *   small: haiku (source: Claude alias fallback)
 *   small: inherit (no model assigned)
 *   small: my-custom-model (source: LeanRigor configuration file)
 */
export function formatModelTierLine(
  tier: ModelTier,
  harness: Harness,
  config: LeanRigorConfig,
): string {
  const resolved = resolveModelTier(tier, harness, config);

  if (resolved.source === "inherit") {
    return `  ${tier}: inherit (no model assigned)`;
  }

  const model = resolved.resolvedModel ?? resolved.model;
  const alias = resolved.adapterAlias;
  const sourceLabel = modelSourceLabel(resolved.source, tier, harness);

  // When the resolved model IS the alias (adapter default) — just show the alias
  if (alias && model === alias) {
    return `  ${tier}: ${model} (source: ${sourceLabel})`;
  }

  // When we have both an alias and a different concrete model — show alias → model
  if (alias && model && model !== alias) {
    return `  ${tier}: ${alias} → ${model} (source: ${sourceLabel})`;
  }

  // No alias available — just show the model
  return `  ${tier}: ${model ?? "unknown"} (source: ${sourceLabel})`;
}

// ---------------------------------------------------------------------------
// Multi-tier display
// ---------------------------------------------------------------------------

/**
 * Return an array of formatted lines for small / medium / large tiers.
 */
export function formatAllModelTiers(
  harness: Harness,
  config: LeanRigorConfig,
): string[] {
  return (["small", "medium", "large"] as const).map((tier) => {
    try {
      return formatModelTierLine(tier, harness, config);
    } catch (error) {
      return `  ${tier}: ERROR — ${(error as Error).message}`;
    }
  });
}

/**
 * Return a formatted table of model resolution for all tiers.
 *
 * Example output:
 *   Tier    | Claude alias | Resolved model       | Source
 *   small   | haiku        | deepseek-v4-flash    | ANTHROPIC_DEFAULT_HAIKU_MODEL
 *   medium  | sonnet       | deepseek-v4-pro[1m]  | ANTHROPIC_DEFAULT_SONNET_MODEL
 *   large   | opus         | deepseek-v4-pro[1m]  | ANTHROPIC_DEFAULT_OPUS_MODEL
 *   inherit | —            | (session default)    | --model omitted
 */
export function formatModelTable(
  harness: Harness,
  config: LeanRigorConfig,
): string {
  const tiers: ModelTier[] = ["small", "medium", "large", "inherit"];
  const rows: Array<{
    tier: string;
    alias: string;
    model: string;
    source: string;
  }> = [];

  for (const tier of tiers) {
    try {
      const resolved = resolveModelTier(tier, harness, config);
      if (resolved.source === "inherit") {
        rows.push({
          tier,
          alias: "—",
          model: "(session default)",
          source: "--model omitted",
        });
      } else {
        const model = resolved.resolvedModel ?? resolved.model ?? "—";
        const alias = resolved.adapterAlias ?? "—";
        rows.push({
          tier,
          alias,
          model,
          source: modelSourceLabel(resolved.source, tier, harness),
        });
      }
    } catch {
      rows.push({ tier, alias: "—", model: "ERROR", source: "unavailable" });
    }
  }

  // Compute column widths
  const tierWidth = Math.max(8, ...rows.map((r) => r.tier.length));
  const aliasWidth = Math.max(13, ...rows.map((r) => r.alias.length));
  const modelWidth = Math.max(15, ...rows.map((r) => r.model.length));
  const sourceWidth = Math.max(6, ...rows.map((r) => r.source.length));

  const pad = (s: string, w: number) => s.padEnd(w);

  const header =
    `${pad("Tier", tierWidth)} | ${pad("Claude alias", aliasWidth)} | ${pad("Resolved model", modelWidth)} | Source`;
  const sep = `${"—".repeat(tierWidth)}—|—${"—".repeat(aliasWidth)}—|—${"—".repeat(modelWidth)}—|—${"—".repeat(sourceWidth)}`;

  const body = rows
    .map(
      (r) =>
        `${pad(r.tier, tierWidth)} | ${pad(r.alias, aliasWidth)} | ${pad(r.model, modelWidth)} | ${r.source}`,
    )
    .join("\n");

  return [header, sep, body].join("\n");
}

// ---------------------------------------------------------------------------
// Init output helper
// ---------------------------------------------------------------------------

/**
 * Return the one-line blurb printed by `leanrigor init` / `leanrigor setup`.
 *
 * Example:
 *   Claude adapter defaults: small → haiku, medium → sonnet, large → opus
 */
export function claudeDefaultsBlurb(): string {
  return "Claude adapter defaults: small → haiku, medium → sonnet, large → opus";
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

/**
 * Return a structured JSON-safe representation for a single model tier.
 */
export function formatModelTierJson(
  tier: ModelTier,
  harness: Harness,
  config: LeanRigorConfig,
): Record<string, unknown> {
  const resolved = resolveModelTier(tier, harness, config);
  const model = resolved.resolvedModel ?? resolved.model;
  return {
    tier,
    adapter: harness,
    adapterAlias: resolved.adapterAlias ?? null,
    resolvedModel: model ?? null,
    source: resolved.source,
    sourceLabel: modelSourceLabel(resolved.source, tier, harness),
    isClaudeAlias:
      resolved.adapterAlias !== undefined &&
      resolved.adapterAlias === model,
  };
}

/**
 * Return JSON-safe representations for all three portable tiers.
 */
export function formatAllModelTiersJson(
  harness: Harness,
  config: LeanRigorConfig,
): Record<string, unknown>[] {
  return (["small", "medium", "large"] as const).map((tier) =>
    formatModelTierJson(tier, harness, config),
  );
}
