import { readFile } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_DEFAULTS } from "./defaults.js";
import { loadUserConfig, loadRepoPolicy } from "./load.js";
import { applyRepoPolicy, applyUserConfig } from "./merger.js";
import type { ProvenanceMap } from "./provenance.js";
import { buildProvenanceMap } from "./provenance.js";
import { ConfigScope } from "./config-scope.js";
import { leanRigorConfigSchema, type LeanRigorConfig } from "./schema.js";
import { resolveModelTier } from "./models.js";
import { formatAllModelTiers } from "./model-display.js";

/**
 * The fully resolved effective configuration with provenance tracking.
 */
export interface EffectiveConfig {
  /** The merged configuration with all sources applied. */
  values: LeanRigorConfig;
  /** Per-field provenance: where each value originated. */
  provenance: ProvenanceMap;
  /** Active constraints imposed by repository policy or safety rules. */
  constraints: string[];
  /** Warnings about configuration issues that need attention. */
  warnings: string[];
  /** Which configuration scopes were found and loaded. */
  sourcesFound: ConfigScope[];
}

/**
 * Load the raw local config JSON without schema-defaulting.
 * This prevents schema defaults from overwriting policy-constrained values
 * when deep-merging.
 */
async function loadLocalConfigRaw(root: string): Promise<Record<string, unknown> | null> {
  const filePath = path.join(root, ".leanrigor", "config.json");
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Resolve the effective configuration for a repository at `root`,
 * applying the full precedence chain:
 *
 *   1. Built-in defaults
 *   2. Adapter-derived defaults
 *   3. User config (~/.config/leanrigor/config.json)
 *   4. Committed repo policy (leanrigor.config.json)
 *   5. Private local config (.leanrigor/config.json)
 *   6. Environment variables
 *
 * Returns values, provenance, constraints, and warnings.
 */
export async function resolveEffectiveConfig(root: string): Promise<EffectiveConfig> {
  const warnings: string[] = [];
  const sourcesFound: ConfigScope[] = [ConfigScope.Builtin];

  // 1. Start from built-in defaults
  let config = structuredClone(BUILTIN_DEFAULTS);
  const provenance: ProvenanceMap = buildProvenanceMap(
    config as unknown as Record<string, unknown>,
    ConfigScope.Builtin
  );

  // 2. Adapter-derived defaults (Claude model alias defaults from env or built-in)
  // This is applied by the adapter itself; we record it here
  sourcesFound.push(ConfigScope.Adapter);
  // Record model tier provenance as adapter-derived (resolved at use time)
  for (const tier of ["small", "medium", "large"] as const) {
    const key = `models.tiers.${tier}.claude`;
    try {
      const resolved = resolveModelTier(tier, "claude", config);
      const val = resolved.resolvedModel ?? resolved.model;
      if (val) {
        provenance.set(key, {
          value: val,
          source: ConfigScope.Adapter,
          rawValue: val,
          constrained: false,
          warnings: [],
          adapterResolution: resolved.source,
          adapterAlias: resolved.adapterAlias,
          isClaudeAlias: resolved.adapterAlias !== undefined && resolved.adapterAlias === val,
        });
      }
    } catch {
      // Resolution failed — no provenance for this tier
    }
  }

  // 3. Apply user config
  const userConfig = await loadUserConfig();
  if (userConfig) {
    sourcesFound.push(ConfigScope.User);
    config = applyUserConfig(config, userConfig);
    // Merge user provenance
    const userProvenance = buildProvenanceMap(
      userConfig as unknown as Record<string, unknown>,
      ConfigScope.User
    );
    for (const [key, entry] of userProvenance) {
      if (entry.value !== undefined) provenance.set(key, entry);
    }
  }

  // 4. Apply committed repo policy (with constraint enforcement)
  const repoPolicy = await loadRepoPolicy(root);
  const constraints: string[] = [];
  if (repoPolicy) {
    sourcesFound.push(ConfigScope.RepoPolicy);
    const result = applyRepoPolicy(config, repoPolicy);
    config = result.config;
    constraints.push(...result.constraints);

    // Merge repo policy provenance
    const repoProvenance = buildProvenanceMap(
      repoPolicy as unknown as Record<string, unknown>,
      ConfigScope.RepoPolicy
    );
    for (const [key, entry] of repoProvenance) {
      if (entry.value !== undefined) provenance.set(key, entry);
    }
  }

  // 5. Apply local config (highest file precedence)
  // Load raw JSON first to avoid schema defaults overwriting policy constraints
  const localRaw = await loadLocalConfigRaw(root);
  if (localRaw) {
    sourcesFound.push(ConfigScope.Local);
    // Merge raw local values into the config
    config = leanRigorConfigSchema.parse(
      deepMergeObjects(config as unknown as Record<string, unknown>, localRaw)
    );
    // Merge local provenance from the raw values
    const localProvenance = buildProvenanceMap(localRaw, ConfigScope.Local);
    for (const [key, entry] of localProvenance) {
      if (entry.value !== undefined) provenance.set(key, entry);
    }
  }

  // 6. Re-apply policy constraints after local config merge
  // Local config cannot weaken safety constraints already enforced by repo policy
  if (repoPolicy) {
    const reapplied = applyRepoPolicy(config, repoPolicy);
    config = reapplied.config;
    // Only add new constraints (don't duplicate)
    for (const c of reapplied.constraints) {
      if (!constraints.includes(c)) constraints.push(c);
    }
  }

  // Validate final config
  const validated = leanRigorConfigSchema.parse(config);

  return {
    values: validated,
    provenance,
    constraints,
    warnings,
    sourcesFound
  };
}

/**
 * Simple deep merge of two plain objects.
 */
function deepMergeObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isJsonObject(value) && isJsonObject(out[key])) {
      out[key] = deepMergeObjects(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Format the effective configuration for human-readable display.
 */
export function formatEffectiveConfig(effective: EffectiveConfig): string {
  const lines: string[] = [];

  lines.push("=== LeanRigor Effective Configuration ===");
  lines.push("");

  // Configuration sources found
  lines.push("Configuration sources found:");
  for (const source of effective.sourcesFound) {
    lines.push(`  [${source}] ${scopeLabel(source)}`);
  }
  if (effective.sourcesFound.length <= 2) {
    // Only Builtin + Adapter present — no User, RepoPolicy, or Local config files
    lines.push("  (no configuration files found; effective values are from adapter-derived and built-in defaults)");
  }

  // Model tier resolution
  lines.push("");
  lines.push("Model tier resolution:");
  lines.push(...formatAllModelTiers("claude", effective.values));

  // Key execution settings
  lines.push("");
  lines.push("Execution:");
  const maxPhases = effective.values.execution.maxParallelPhases;
  const maxPhasesProv = effective.provenance.get("execution.maxParallelPhases");
  lines.push(`  Maximum parallel phases: ${maxPhases}${maxPhasesProv ? ` (source: ${scopeLabel(maxPhasesProv.source)})` : ""}`);

  // Constraints
  if (effective.constraints.length > 0) {
    lines.push("");
    lines.push("Constraints (repository policy):");
    for (const constraint of effective.constraints) {
      lines.push(`  ${constraint}`);
    }
  }

  // Warnings
  if (effective.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of effective.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
  }

  return lines.join("\n");
}

function scopeLabel(source: ConfigScope): string {
  switch (source) {
    case ConfigScope.Cli: return "CLI flag";
    case ConfigScope.Env: return "environment variable";
    case ConfigScope.Local: return "repository-local config (.leanrigor/config.json)";
    case ConfigScope.RepoPolicy: return "committed repository policy (leanrigor.config.json)";
    case ConfigScope.User: return "user config (~/.config/leanrigor/config.json)";
    case ConfigScope.Adapter: return "adapter-derived default";
    case ConfigScope.Builtin: return "built-in default";
  }
}
