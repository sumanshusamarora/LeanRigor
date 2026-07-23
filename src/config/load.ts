import { readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { leanRigorConfigSchema, type LeanRigorConfig } from "./schema.js";

/**
 * Configuration precedence (lowest to highest): built-in defaults, user-global,
 * repository, and an explicitly supplied LEANRIGOR_CONFIG file.
 * Model environment variables are resolved later by resolveModelTier and take
 * precedence over all file-based configuration.
 */
export async function loadConfig(root: string): Promise<LeanRigorConfig> {
  const locations = [
    path.join(homedir(), ".config", "leanrigor", "config.json"),
    path.join(root, ".leanrigor", "config.json"),
    process.env.LEANRIGOR_CONFIG
  ].filter(Boolean) as string[];

  let merged: unknown = {};
  for (const location of locations) {
    try {
      const raw = JSON.parse(await readFile(location, "utf8"));
      merged = deepMerge(merged, raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Unable to load LeanRigor configuration from ${location}: ${(error as Error).message}`);
    }
  }
  return leanRigorConfigSchema.parse(merged);
}

function deepMerge(base: any, override: any): any {
  if (!base || typeof base !== "object" || Array.isArray(base)) return override ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    out[key] = value && typeof value === "object" && !Array.isArray(value)
      ? deepMerge(out[key] ?? {}, value)
      : value;
  }
  return out;
}
