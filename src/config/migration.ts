import { readFile } from "node:fs/promises";
import path from "node:path";
import { leanRigorConfigSchema, type LeanRigorConfig } from "./schema.js";
import { atomicWriteJson } from "./atomic-write.js";
import { ensureGitignore } from "./bootstrap.js";

/**
 * Result of a configuration migration check.
 */
export interface MigrationResult {
  /** Whether migration was needed and performed. */
  migrated: boolean;
  /** Paths that were modified. */
  changedFiles: string[];
  /** Human-readable summary of changes made. */
  summary: string[];
  /** Warnings or issues that need attention. */
  warnings: string[];
}

/**
 * Check and optionally migrate the local config at `.leanrigor/config.json`.
 *
 * Migration is repeat-safe and idempotent:
 * - Adds `version: 1` if missing (schema already defaults to 1)
 * - Ensures `$schema` field is present
 * - Never moves private values into committed files
 * - Never overwrites user-modified values
 *
 * Returns what was done (or would be done in dry-run mode).
 */
export async function migrateConfig(root: string, dryRun = false): Promise<MigrationResult> {
  const result: MigrationResult = {
    migrated: false,
    changedFiles: [],
    summary: [],
    warnings: []
  };

  const configPath = path.join(root, ".leanrigor", "config.json");
  const leanrigorDir = path.join(root, ".leanrigor");

  // Ensure .gitignore
  const gitignoreStatus = await ensureGitignore(leanrigorDir);
  if (gitignoreStatus.status === "created") {
    result.summary.push(`Created .leanrigor/.gitignore`);
    if (!dryRun) result.changedFiles.push(path.join(".leanrigor", ".gitignore"));
  } else if (gitignoreStatus.status === "incomplete") {
    result.warnings.push(".leanrigor/.gitignore: runtime state may be tracked — run `leanrigor doctor` for details");
  }

  // Load existing config
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    // No config to migrate
    result.summary.push("No existing .leanrigor/config.json to migrate");
    return result;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    result.warnings.push(`.leanrigor/config.json contains malformed JSON and cannot be migrated automatically`);
    return result;
  }

  let changed = false;

  // Add version if missing (schema already defaults to 1, but be explicit)
  if (parsed.version === undefined) {
    parsed.version = 1;
    changed = true;
    result.summary.push("Added version: 1 to .leanrigor/config.json");
  }

  // Add $schema if missing
  if (parsed.$schema === undefined) {
    parsed.$schema = "../node_modules/leanrigor/config.schema.json";
    changed = true;
    result.summary.push("Added $schema field to .leanrigor/config.json");
  }

  // Validate the final config
  try {
    leanRigorConfigSchema.parse(parsed);
  } catch (error) {
    result.warnings.push(`.leanrigor/config.json failed schema validation after migration: ${(error as Error).message}`);
    return result;
  }

  // Write back if changed
  if (changed) {
    result.migrated = true;
    if (!dryRun) {
      await atomicWriteJson(configPath, parsed);
      result.changedFiles.push(path.join(".leanrigor", "config.json"));
    }
    result.summary.push("Configuration migrated successfully");
  } else {
    result.summary.push("Configuration is already current (no migration needed)");
  }

  // Check for settings that should move to repo policy (warn, don't auto-migrate)
  const risk = (parsed as Record<string, unknown>).risk as Record<string, unknown> | undefined;
  if (risk?.rigorousPaths) {
    result.warnings.push(
      "risk.rigorousPaths is configured in private .leanrigor/config.json. " +
      "Consider moving to leanrigor.config.json (committed) for team-wide policy."
    );
  }
  const parallelism = (parsed as Record<string, unknown>).parallelism as Record<string, unknown> | undefined;
  if (parallelism?.maxAgents) {
    result.warnings.push(
      "parallelism.maxAgents is configured in .leanrigor/config.json. " +
      "Consider moving to leanrigor.config.json if it is a team policy."
    );
  }

  return result;
}

/**
 * Compatibility read: load config from .leanrigor/config.json
 * even if it lacks version metadata, and return a valid LeanRigorConfig.
 */
export async function loadLegacyConfig(root: string): Promise<LeanRigorConfig | null> {
  const configPath = path.join(root, ".leanrigor", "config.json");
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    return leanRigorConfigSchema.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Unable to load legacy config from ${configPath}: ${(error as Error).message}`, { cause: error });
  }
}
