import { readFile } from "node:fs/promises";
import { leanRigorConfigSchema, type LeanRigorConfig } from "./schema.js";
import { userConfigSchema, type UserConfig } from "./schemas/user.js";
import { repoPolicyConfigSchema, type RepoPolicyConfig } from "./schemas/repo-policy.js";
import { ConfigScope, scopePath } from "./config-scope.js";

/**
 * Legacy loader: deep-merges user + local + env config into one LeanRigorConfig.
 * Maintained for backward compatibility. New callers should use the scope-aware
 * loaders and the central resolver.
 */
export async function loadConfig(root: string): Promise<LeanRigorConfig> {
  const locations = [
    scopePath(ConfigScope.User, root),
    scopePath(ConfigScope.Local, root),
    process.env.LEANRIGOR_CONFIG
  ].filter(Boolean) as string[];

  let merged: unknown = {};
  for (const location of locations) {
    try {
      const raw = JSON.parse(await readFile(location, "utf8"));
      merged = deepMerge(merged, raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Unable to load LeanRigor configuration from ${location}: ${(error as Error).message}`, { cause: error });
    }
  }
  return leanRigorConfigSchema.parse(merged);
}

/**
 * Load user-wide configuration from ~/.config/leanrigor/config.json.
 * Returns null when the file does not exist.
 */
export async function loadUserConfig(): Promise<UserConfig | null> {
  const filePath = scopePath(ConfigScope.User, ""); // user config is root-independent
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    return userConfigSchema.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Unable to load user configuration from ${filePath}: ${(error as Error).message}`, { cause: error });
  }
}

/**
 * Load committed repository policy from <root>/leanrigor.config.json.
 * Returns null when the file does not exist.
 */
export async function loadRepoPolicy(root: string): Promise<RepoPolicyConfig | null> {
  const filePath = scopePath(ConfigScope.RepoPolicy, root);
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    return repoPolicyConfigSchema.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Unable to load repository policy from ${filePath}: ${(error as Error).message}`, { cause: error });
  }
}

/**
 * Load private per-repository config from <root>/.leanrigor/config.json.
 * Returns null when the file does not exist.
 */
export async function loadLocalConfig(root: string): Promise<LeanRigorConfig | null> {
  const filePath = scopePath(ConfigScope.Local, root);
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    return leanRigorConfigSchema.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Unable to load local configuration from ${filePath}: ${(error as Error).message}`, { cause: error });
  }
}

/**
 * Check whether a config file exists at the given scope path.
 */
export async function configFileExists(scope: ConfigScope, root: string): Promise<boolean> {
  try {
    await readFile(scopePath(scope, root), "utf8");
    return true;
  } catch {
    return false;
  }
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isJsonObject(base)) return override ?? base;
  const out: JsonObject = { ...base };
  for (const [key, value] of Object.entries(isJsonObject(override) ? override : {})) {
    out[key] = isJsonObject(value) ? deepMerge(out[key] ?? {}, value) : value;
  }
  return out;
}
