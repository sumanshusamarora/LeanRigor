import type { ConfigScope } from "./config-scope.js";

/**
 * Tracks the origin and resolution path of a single configuration value.
 */
export interface ConfigProvenance {
  /** Current effective value. */
  value: unknown;
  /** Scope where the effective value originated. */
  source: ConfigScope;
  /** The raw value from the source before any merging/constraining. */
  rawValue: unknown;
  /** If an adapter resolved this value from its own env/defaults. */
  adapterResolution?: string;
  /** Whether a repository policy constraint modified this value. */
  constrained: boolean;
  /** If constrained, what was the originally requested value. */
  requestedValue?: unknown;
  /** Warnings or notes about this value's resolution. */
  warnings: string[];
}

/**
 * Create a provenance entry from a scope with the raw value.
 */
export function provenance(
  value: unknown,
  source: ConfigScope,
  rawValue: unknown = value
): ConfigProvenance {
  return {
    value,
    source,
    rawValue,
    constrained: false,
    warnings: []
  };
}

/**
 * Return a provenance entry representing a constrained value.
 */
export function constrainedProvenance(
  original: ConfigProvenance,
  constrainedValue: unknown
): ConfigProvenance {
  return {
    ...original,
    value: constrainedValue,
    constrained: true,
    requestedValue: original.value,
    warnings: [
      ...original.warnings,
      `Value constrained by repository policy: requested ${JSON.stringify(original.value)}, resolved to ${JSON.stringify(constrainedValue)}`
    ]
  };
}

/**
 * A flat map from dotted field paths to provenance entries.
 */
export type ProvenanceMap = Map<string, ConfigProvenance>;

/**
 * Build a provenance map by walking an object tree.
 */
export function buildProvenanceMap(
  obj: Record<string, unknown>,
  source: ConfigScope,
  prefix = ""
): ProvenanceMap {
  const map: ProvenanceMap = new Map();

  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      // Recurse into nested objects
      const nested = buildProvenanceMap(value as Record<string, unknown>, source, fullPath);
      for (const [nestedPath, entry] of nested) {
        map.set(nestedPath, entry);
      }
    } else {
      map.set(fullPath, provenance(value, source));
    }
  }

  return map;
}

/**
 * Format a single provenance entry for human-readable output.
 */
export function formatProvenance(path: string, entry: ConfigProvenance): string {
  const lines: string[] = [];
  lines.push(`${path}: ${JSON.stringify(entry.value)}`);
  lines.push(`  Source: ${entry.source}`);

  if (entry.adapterResolution) {
    lines.push(`  Adapter resolution: ${entry.adapterResolution}`);
  }

  if (entry.constrained && entry.requestedValue !== undefined) {
    lines.push(`  Requested: ${JSON.stringify(entry.requestedValue)}`);
    lines.push(`  Constrained by repository policy`);
  }

  for (const warning of entry.warnings) {
    lines.push(`  ⚠ ${warning}`);
  }

  return lines.join("\n");
}
