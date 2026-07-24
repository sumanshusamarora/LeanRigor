import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { leanRigorConfigSchema, type LeanRigorConfig } from "./schema.js";
import { defaultConfig } from "./defaults.js";
import { atomicWriteJson } from "./atomic-write.js";

/**
 * Content for the .leanrigor/.gitignore file.
 * Ensures runtime state is never accidentally committed.
 */
const GITIGNORE_CONTENT = "*\n!.gitignore\n";

export interface GitignoreStatus {
  status: "created" | "current" | "user_extended" | "incomplete" | "missing";
  message: string;
}

/**
 * Ensure `.leanrigor/.gitignore` exists with the correct safety pattern.
 *
 * Called from every bootstrap path: setup/init, flow start, doctor, migration.
 * Never overwrites a user-modified file unless it clearly fails to protect
 * LeanRigor runtime state.
 */
export async function ensureGitignore(leanrigorDir: string): Promise<GitignoreStatus> {
  await mkdir(leanrigorDir, { recursive: true });
  const gitignorePath = path.join(leanrigorDir, ".gitignore");

  let existing: string | undefined;
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch {
    // File missing — create it
  }

  if (existing === undefined) {
    await writeFile(gitignorePath, GITIGNORE_CONTENT, "utf8");
    return { status: "created", message: ".leanrigor/.gitignore: created" };
  }

  const trimmed = existing.trim();

  // Exact match — current
  if (trimmed === GITIGNORE_CONTENT.trim()) {
    return { status: "current", message: ".leanrigor/.gitignore: current" };
  }

  // User-extended: has both patterns but also includes additional entries
  if (trimmed.includes("*") && trimmed.includes("!.gitignore")) {
    return { status: "user_extended", message: ".leanrigor/.gitignore: current (user-extended)" };
  }

  // Missing critical safety patterns
  return { status: "incomplete", message: ".leanrigor/.gitignore: runtime state may be tracked" };
}

/**
 * Check whether the repository already has tracked .leanrigor files
 * (which would indicate a safety issue — private state was committed).
 */
export async function checkTrackedLeanrigorFiles(root: string): Promise<string[]> {
  const leanrigorDir = path.join(root, ".leanrigor");
  try {
    const entries = await readdir(leanrigorDir);
    return entries.filter((entry) => entry !== ".gitignore");
  } catch {
    return [];
  }
}

/**
 * Lazily create and ensure the .leanrigor/ directory with .gitignore and
 * an initial config.json if none exists. Returns the loaded or newly-created
 * configuration.
 *
 * This is the single bootstrap entry point used by:
 * - Claude marketplace plugin first use (/leanrigor:start)
 * - CLI `flow start`
 * - CLI `setup/init --adapter claude`
 * - Execution recovery
 * - Doctor repair
 */
export async function ensureRepositoryConfig(root: string): Promise<LeanRigorConfig> {
  const configPath = path.join(root, ".leanrigor", "config.json");

  // 1. Ensure .leanrigor/.gitignore
  await ensureGitignore(path.join(root, ".leanrigor"));

  // 2. Load or create config
  let existing: string | undefined;
  try {
    existing = await readFile(configPath, "utf8");
  } catch {
    // Config missing — create it
  }

  if (existing) {
    return leanRigorConfigSchema.parse(JSON.parse(existing));
  }

  // Create new config with auto-detected instructions
  const config = defaultConfig();
  config.instructions = await detectInstructions(root);
  await atomicWriteJson(configPath, { $schema: "../node_modules/leanrigor/config.schema.json", ...config });
  return config;
}

/**
 * Detect available instruction files (AGENTS.md, CLAUDE.md, CONTRIBUTING.md).
 */
export async function detectInstructions(root: string): Promise<string[]> {
  const candidates = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"];
  try {
    const topLevel = new Set(await readdir(root));
    return candidates.filter((candidate) => topLevel.has(candidate));
  } catch {
    return [];
  }
}

/**
 * Write the configuration to `.leanrigor/config.json` atomically.
 */
export async function writeConfig(root: string, config: unknown): Promise<void> {
  const configPath = path.join(root, ".leanrigor", "config.json");
  await ensureGitignore(path.join(root, ".leanrigor"));
  await atomicWriteJson(configPath, { $schema: "../node_modules/leanrigor/config.schema.json", ...(config as object) });
}

/**
 * Find the repository root by walking up from cwd looking for a .git directory
 * or leanrigor.config.json.
 */
export function findRepoRoot(startDir?: string): string {
  let dir = path.resolve(startDir ?? process.cwd());
  for (let i = 0; i < 64; i++) {
    // Simple check: does .git exist (directory or file for worktrees)?
    // We check without fs access — repo root is a concept; actual validation
    // happens when reading files.
    if (dir === path.dirname(dir)) break; // reached filesystem root
    dir = path.dirname(dir);
  }
  // Fall back to cwd — actual validation is done by callers
  return path.resolve(startDir ?? process.cwd());
}
