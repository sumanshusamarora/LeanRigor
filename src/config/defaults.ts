import { leanRigorConfigSchema, type LeanRigorConfig } from "./schema.js";

/**
 * Built-in defaults — the lowest-precedence fallback when no other
 * configuration source provides a value. These are the schema defaults.
 */
export const BUILTIN_DEFAULTS: LeanRigorConfig = leanRigorConfigSchema.parse({});

/** Convenience: parse an empty object through the schema to get all defaults. */
export function defaultConfig(): LeanRigorConfig {
  return leanRigorConfigSchema.parse({});
}
