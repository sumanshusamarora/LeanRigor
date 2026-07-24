import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { access, chmod, mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessAdapter, InstallReport, UninstallReport } from "../types.js";
import type { LeanRigorConfig, ModelTier } from "../../config/schema.js";
import { resolveModelTier } from "../../config/models.js";
import { formatModelTierLine } from "../../config/model-display.js";
import { ensureGitignore, checkTrackedLeanrigorFiles, type GitignoreStatus } from "../../config/bootstrap.js";
import { configFileExists, loadUserConfig, loadRepoPolicy } from "../../config/load.js";
import { ConfigScope } from "../../config/config-scope.js";
import { mergeLeanRigorHooks, removeLeanRigorHooks, checkSettingsState } from "./settings-merger.js";

// ---------------------------------------------------------------------------
// Asset inspection types
// ---------------------------------------------------------------------------

/** Structured result from asset inspection, reused by doctor and init-report. */
export interface AssetInspectionResult {
  /** Per-asset manifest entries with their status. */
  manifest: Array<{ dest: string; status: "current" | "missing" | "conflict" | "modified" | "adoptable" }>;
  current: string[];
  modified: string[];
  missing: string[];
  conflicts: string[];
  /** Files that exist without ownership but whose content matches the packaged version — safe to adopt. */
  adoptable: string[];
  totalAvailable: number;
  installedCount: number;
  /** Classified state of .claude/settings.json (from settings-merger). */
  settingsState: "shared_current" | "shared_missing_leanrigor_entries" | "shared_conflicting_leanrigor_entries" | "shared_malformed" | "shared_unwritable" | "missing";
  settingsDetail: string;
  protectGitState: string;
  gitignoreStatus: GitignoreStatus;
  trackedLeanrigorFiles: string[];
}

/** Result from a bootstrap run. */
export interface BootstrapReport {
  /** Files that were installed (previously missing). */
  installed: string[];
  /** Files that were already current (no changes needed). */
  alreadyCurrent: string[];
  /** Files that were adopted (content matched but lacked ownership token). */
  adopted: string[];
  /** Files that were skipped (non-owned with different content, or user-modified owned files). */
  skipped: string[];
  /** Whether the .claude/settings.json was modified during bootstrap. */
  settingsModified: boolean;
  /** State of settings after bootstrap. */
  settingsState: string;
}

/** Version stamp embedded in every generated asset. Increment when assets change in a breaking way. */
export const ASSET_VERSION = 5;

/** String embedded in every LeanRigor-generated file for ownership detection. */
const OWNERSHIP_TOKEN = "generated_by: leanrigor";
const PROTECT_GIT_DEST = path.join(".claude", "leanrigor", "protect-git.sh");

// ---------------------------------------------------------------------------
// Installation mode
// ---------------------------------------------------------------------------

/**
 * Explicit installation mode.
 *
 * - `marketplace`: running from a Claude marketplace plugin; assets are served
 *   from `${CLAUDE_PLUGIN_ROOT}`.
 * - `project-local`: installed via `leanrigor init --adapter claude`; assets
 *   live in the repository's `.claude/` tree.
 * - `unknown`: cannot conclusively determine — neither env-var signal nor
 *   owned project-local assets found.
 */
export type InstallationMode = "marketplace" | "project-local" | "unknown";

/**
 * Per-file classification used by shadowing detection.
 */
export type ShadowedAssetStatus = "stale_owned" | "modified_owned" | "adoptable_unowned" | "conflict";

/** Single entry in a shadowing report. */
export interface ShadowedAsset {
  path: string;
  status: ShadowedAssetStatus;
}

/** Full result of shadowing detection. */
export interface ShadowingReport {
  /** Whether any project-local assets that may shadow marketplace plugins were found. */
  detected: boolean;
  /** The individual assets classified. */
  assets: ShadowedAsset[];
  /** Human-readable summary of the recommended action. */
  recommendation: string;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Cleanup operation scope. */
export type CleanupScope = "project-local" | "runtime-state" | "user-config" | "all";

/** Options for the cleanup operation. */
export interface CleanupOptions {
  dryRun: boolean;
  scope: CleanupScope;
  force: boolean;
}

/** A single item that will be or was removed during cleanup. */
export interface CleanupItem {
  path: string;
  action: "remove-file" | "remove-directory" | "remove-settings-entry" | "skip-modified" | "skip-unowned" | "skip-not-found";
  reason?: string;
}

/** Result of a cleanup operation. */
export interface CleanupReport {
  /** Whether this was a dry run (true) or actual removal (false). */
  dryRun: boolean;
  /** The scope of the cleanup. */
  scope: CleanupScope;
  /** Items that would be or were acted upon. */
  items: CleanupItem[];
  /** Items that were skipped (modified, unowned, etc.). */
  skipped: CleanupItem[];
  /** Human-readable summary. */
  summary: string;
}

/**
 * Clean up LeanRigor-owned project-local assets, runtime state, or user config.
 *
 * Safety invariants:
 * - Defaults to dry-run unless opts.dryRun is false.
 * - Never deletes entire .claude/ or ~/.config/ directories — only specific owned files.
 * - Modified owned files are skipped unless opts.force is true.
 * - Unrelated settings.json entries are preserved.
 * - .leanrigor/ is only removed when scope is runtime-state or all.
 */
export async function cleanupProjectLocalAssets(
  root: string,
  opts: CleanupOptions,
): Promise<CleanupReport> {
  const items: CleanupItem[] = [];
  const skipped: CleanupItem[] = [];

  // --- Project-local assets (.claude/ LeanRigor files) ---
  if (opts.scope === "project-local" || opts.scope === "all") {
    // Load config for asset manifest
    let config: LeanRigorConfig;
    try {
      const { loadConfig } = await import("../../config/load.js");
      config = await loadConfig(root);
    } catch {
      const { defaultConfig } = await import("../../config/defaults.js");
      config = (await defaultConfig()) as unknown as LeanRigorConfig;
    }

    const { resolveModelTier } = await import("../../config/models.js");
    const triageModel = resolveModelTier(config.routing.triage, "claude", config).model ?? "haiku";
    const manifest = assetManifestWithoutSettings(triageModel);

    for (const entry of manifest) {
      const targetPath = path.join(root, entry.dest);
      let existing: string | undefined;
      try { existing = await readFile(targetPath, "utf8"); } catch { continue; }

      if (!isLeanRigorOwned(existing)) {
        // Check content equality for adoptable files
        const expected = await readPackagedAsset(entry.src, entry.vars).catch(() => undefined);
        if (expected !== undefined && sha256(existing) === sha256(expected)) {
          // Adoptable: content matches but no ownership — safe to remove with --force
          if (opts.force) {
            items.push({ path: entry.dest, action: opts.dryRun ? "remove-file" : "remove-file" });
            if (!opts.dryRun) {
              await unlink(targetPath).catch(() => {});
            }
          } else {
            skipped.push({ path: entry.dest, action: "skip-unowned", reason: "content matches but lacks ownership token — use --force to remove" });
          }
        } else {
          skipped.push({ path: entry.dest, action: "skip-unowned", reason: "not LeanRigor-owned and content differs" });
        }
        continue;
      }

      // Owned — check if modified
      const expected = await readPackagedAsset(entry.src, entry.vars).catch(() => undefined);
      if (expected !== undefined && sha256(existing) !== sha256(expected)) {
        if (opts.force) {
          items.push({ path: entry.dest, action: "remove-file" });
          if (!opts.dryRun) {
            await unlink(targetPath).catch(() => {});
          }
        } else {
          skipped.push({ path: entry.dest, action: "skip-modified", reason: "modified — use --force to remove" });
        }
      } else {
        items.push({ path: entry.dest, action: "remove-file" });
        if (!opts.dryRun) {
          await unlink(targetPath).catch(() => {});
        }
      }
    }

    // Clean empty directories up to .claude/
    if (!opts.dryRun) {
      // Remove any empty subdirectories
      const dirsToCheck = [
        path.join(root, ".claude", "commands"),
        path.join(root, ".claude", "agents"),
        path.join(root, ".claude", "leanrigor"),
        path.join(root, ".claude", "leanrigor", "methodology", "modes"),
        path.join(root, ".claude", "leanrigor", "methodology"),
      ];
      for (const dir of dirsToCheck) {
        await removeIfEmpty(dir);
      }
    }

    // Remove LeanRigor hook entries from settings.json
    const settingsPath = path.join(root, ".claude", "settings.json");
    try {
      await readFile(settingsPath, "utf8");
      items.push({ path: ".claude/settings.json", action: "remove-settings-entry" });
      if (!opts.dryRun) {
        await removeLeanRigorHooks(settingsPath);
      }
    } catch {
      // settings.json doesn't exist — nothing to do
    }
  }

  // --- Runtime state (.leanrigor/) ---
  if (opts.scope === "runtime-state" || opts.scope === "all") {
    const leanrigorDir = path.join(root, ".leanrigor");
    try {
      await stat(leanrigorDir);
      items.push({ path: ".leanrigor/", action: "remove-directory" });
      if (!opts.dryRun) {
        const { rm } = await import("node:fs/promises");
        await rm(leanrigorDir, { recursive: true, force: true });
      }
    } catch {
      skipped.push({ path: ".leanrigor/", action: "skip-not-found", reason: "directory does not exist" });
    }
  }

  // --- User config (~/.config/leanrigor/config.json) ---
  if (opts.scope === "user-config" || opts.scope === "all") {
    const { homedir } = await import("node:os");
    const userConfigPath = path.join(homedir(), ".config", "leanrigor", "config.json");
    try {
      await stat(userConfigPath);
      items.push({ path: userConfigPath, action: "remove-file" });
      if (!opts.dryRun) {
        await unlink(userConfigPath).catch(() => {});
        await removeIfEmpty(path.dirname(userConfigPath));
      }
    } catch {
      skipped.push({ path: userConfigPath, action: "skip-not-found", reason: "file does not exist" });
    }
  }

  const summary = opts.dryRun
    ? `Dry-run: ${items.length} item(s) would be removed, ${skipped.length} would be skipped (scope: ${opts.scope})`
    : `Removed ${items.length} item(s), skipped ${skipped.length} (scope: ${opts.scope})`;

  return { dryRun: opts.dryRun, scope: opts.scope, items, skipped, summary };
}

/** Detect the current installation mode from runtime signals and repo state. */
export function detectInstallationMode(root: string): Promise<InstallationMode> {
  return _detectInstallationMode(root);
}

async function _detectInstallationMode(root: string): Promise<InstallationMode> {
  // 1. Marketplace signal: CLAUDE_PLUGIN_ROOT or LEANRIGOR_CLAUDE_PLUGIN_ROOT is set
  if (process.env.LEANRIGOR_CLAUDE_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT) {
    return "marketplace";
  }

  // 2. Check for owned project-local assets
  const protectGitPath = path.join(root, PROTECT_GIT_DEST);
  try {
    const content = await readFile(protectGitPath, "utf8");
    if (isLeanRigorOwned(content)) {
      return "project-local";
    }
  } catch {
    // File doesn't exist — not project-local
  }

  // 3. Neither signal is conclusive
  return "unknown";
}

/**
 * Detect project-local assets that may shadow marketplace plugin assets.
 * Only meaningful when the installation mode is `marketplace`; returns
 * an empty (non-detected) report otherwise.
 */
export async function detectShadowing(
  root: string,
  mode: InstallationMode,
  config: LeanRigorConfig,
): Promise<ShadowingReport> {
  if (mode !== "marketplace") {
    return { detected: false, assets: [], recommendation: "" };
  }

  const { resolveModelTier } = await import("../../config/models.js");
  const triageModel = resolveModelTier(config.routing.triage, "claude", config).model ?? "haiku";
  const manifest = assetManifestWithoutSettings(triageModel);
  const assets: ShadowedAsset[] = [];

  for (const entry of manifest) {
    const targetPath = path.join(root, entry.dest);
    let existing: string | undefined;
    try { existing = await readFile(targetPath, "utf8"); } catch { continue; }

    if (!isLeanRigorOwned(existing)) {
      // Check content equality to distinguish adoptable from conflict
      const expected = await readPackagedAsset(entry.src, entry.vars).catch(() => undefined);
      if (expected !== undefined && sha256(existing) === sha256(expected)) {
        assets.push({ path: entry.dest, status: "adoptable_unowned" });
      } else {
        assets.push({ path: entry.dest, status: "conflict" });
      }
    } else {
      // Owned — check if it matches the packaged version
      const expected = await readPackagedAsset(entry.src, entry.vars).catch(() => undefined);
      if (expected !== undefined && sha256(existing) === sha256(expected)) {
        assets.push({ path: entry.dest, status: "stale_owned" });
      } else {
        assets.push({ path: entry.dest, status: "modified_owned" });
      }
    }
  }

  if (assets.length === 0) {
    return { detected: false, assets: [], recommendation: "" };
  }

  const recommendation = [
    `${assets.length} project-local asset(s) detected that may shadow marketplace plugin assets.`,
    `Run \`leanrigor cleanup --adapter claude --project-local-only --dry-run\` to preview removal,`,
    `then \`leanrigor cleanup --adapter claude --project-local-only\` to remove them.`,
    `Modified files will require --force.`,
  ].join("\n");

  return { detected: true, assets, recommendation };
}

/** Check whether the runtime was launched from the Claude marketplace plugin. */
export function isMarketplaceRuntime(): boolean {
  return process.env.LEANRIGOR_RUNTIME_SOURCE === "claude-marketplace-plugin"
    || Boolean(process.env.LEANRIGOR_CLAUDE_PLUGIN_ROOT)
    || Boolean(process.env.CLAUDE_PLUGIN_ROOT);
}

/** Directory containing the Claude plugin source assets, resolved at runtime. */
function pluginDir(): string {
  return fileURLToPath(new URL("./plugin/", import.meta.url));
}

/** Repository/package root containing shared methodology assets. */
function packageRoot(): string {
  return path.resolve(pluginDir(), "..", "..", "..", "..");
}

const METHODOLOGY_FILES = [
  "core.md",
  "planning.md",
  "design.md",
  "implementation.md",
  "debugging.md",
  "testing.md",
  "review.md",
  "evidence.md",
  "safeguards.md",
  path.join("modes", "fast.md"),
  path.join("modes", "standard.md"),
  path.join("modes", "rigorous.md")
];

/** Deterministic SHA-256 of a string. */
function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Return true when the file content was generated by LeanRigor. */
function isLeanRigorOwned(content: string): boolean {
  return content.includes(OWNERSHIP_TOKEN);
}

/**
 * Read a packaged asset and optionally substitute template variables.
 * The only currently supported substitution is `{{TRIAGE_MODEL}}`.
 */
async function readPackagedAsset(assetPath: string, vars?: Record<string, string>): Promise<string> {
  let content = await readFile(assetPath, "utf8");
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      content = content.replaceAll(`{{${key}}}`, value);
    }
  }
  return content;
}

/** Describe all plugin assets to install relative to the plugin directory. */
function assetManifest(triageModel: string): Array<{ src: string; dest: string; vars?: Record<string, string> }> {
  const plugin = pluginDir();
  const methodology = METHODOLOGY_FILES.map((file) => ({
    src: path.join(packageRoot(), "methodology", file),
    dest: path.join(".claude", "leanrigor", "methodology", file)
  }));
  return [
    // protect-git.sh MUST come before settings.json to avoid the stale-hook catch-22
    { src: path.join(plugin, "hooks", "protect-git.sh"),         dest: path.join(".claude", "leanrigor", "protect-git.sh") },
    { src: path.join(plugin, "commands", "leanrigor.md"),        dest: path.join(".claude", "commands", "leanrigor.md") },
    { src: path.join(plugin, "commands", "leanrigor-init.md"),   dest: path.join(".claude", "commands", "leanrigor-init.md") },
    { src: path.join(plugin, "commands", "leanrigor-plan.md"),   dest: path.join(".claude", "commands", "leanrigor-plan.md") },
    { src: path.join(plugin, "commands", "leanrigor-status.md"), dest: path.join(".claude", "commands", "leanrigor-status.md") },
    { src: path.join(plugin, "commands", "leanrigor-review.md"), dest: path.join(".claude", "commands", "leanrigor-review.md") },
    { src: path.join(plugin, "commands", "leanrigor-commit.md"), dest: path.join(".claude", "commands", "leanrigor-commit.md") },
    { src: path.join(plugin, "leanrigor", "sequential-workflow.md"), dest: path.join(".claude", "leanrigor", "sequential-workflow.md") },
    {
      src: path.join(plugin, "agents", "leanrigor-triage.md.tpl"),
      dest: path.join(".claude", "agents", "leanrigor-triage.md"),
      vars: { TRIAGE_MODEL: triageModel }
    },
    { src: path.join(plugin, "settings.json"),                   dest: path.join(".claude", "settings.json") },
    ...methodology
  ];
}

/** Asset manifest without the shared settings.json entry. Used by bootstrap. */
function assetManifestWithoutSettings(triageModel: string): Array<{ src: string; dest: string; vars?: Record<string, string> }> {
  return assetManifest(triageModel).filter((entry) => entry.dest !== ".claude/settings.json");
}

export class ClaudeAdapter implements HarnessAdapter {
  name = "claude";

  modelResolver = {
    resolve(tier: ModelTier, config: LeanRigorConfig): string | undefined {
      return resolveModelTier(tier, "claude", config).model;
    }
  };

  async install(root: string, config: LeanRigorConfig, force = false): Promise<InstallReport> {
    const triageModel = resolveModelTier(config.routing.triage, "claude", config).model ?? "haiku";
    const manifest = assetManifest(triageModel);
    const report: InstallReport = { installed: [], alreadyCurrent: [], skipped: [] };

    for (const entry of manifest) {
      const targetPath = path.join(root, entry.dest);
      await mkdir(path.dirname(targetPath), { recursive: true });

      const expected = await readPackagedAsset(entry.src, entry.vars);

      let existing: string | undefined;
      try { existing = await readFile(targetPath, "utf8"); } catch { /* file missing */ }

      if (existing === undefined) {
        // File does not exist — install it
        await writeFile(targetPath, expected, "utf8");
        await ensureExecutableIfHook(entry.dest, targetPath);
        report.installed.push(entry.dest);
      } else if (sha256(existing) === sha256(expected)) {
        // File exists and is identical to the packaged version
        await ensureExecutableIfHook(entry.dest, targetPath);
        report.alreadyCurrent.push(entry.dest);
      } else if (isLeanRigorOwned(existing) && force) {
        // File is owned and user requested force-replace
        await writeFile(targetPath, expected, "utf8");
        await ensureExecutableIfHook(entry.dest, targetPath);
        report.installed.push(entry.dest);
      } else {
        // User file or user-modified owned file — do not overwrite
        report.skipped.push(entry.dest);
      }
    }

    return report;
  }

  /**
   * Bootstrap the LeanRigor project environment for first use.
   *
   * Ordering is critical:
   * 1. Create directories
   * 2. Install protect-git.sh first (avoid the stale-hook catch-22)
   * 3. chmod +x protect-git.sh
   * 4. Install remaining LeanRigor-owned assets (with content-equality adoption)
   * 5. Merge LeanRigor hook entries into shared .claude/settings.json
   *
   * This method is safe to call repeatedly — already-current files are skipped.
   */
  async bootstrap(root: string, config: LeanRigorConfig, force = false): Promise<BootstrapReport> {
    const triageModel = resolveModelTier(config.routing.triage, "claude", config).model ?? "haiku";
    const manifest = assetManifestWithoutSettings(triageModel);
    const report: BootstrapReport = {
      installed: [],
      alreadyCurrent: [],
      adopted: [],
      skipped: [],
      settingsModified: false,
      settingsState: "unknown",
    };

    // Install assets one at a time — only create directories when we're about to write
    for (const entry of manifest) {
      const targetPath = path.join(root, entry.dest);
      let expected: string;
      try {
        expected = await readPackagedAsset(entry.src, entry.vars);
      } catch {
        // Source asset not readable — skip (e.g. bundled runtime without plugin files)
        report.skipped.push(entry.dest);
        continue;
      }

      let existing: string | undefined;
      try { existing = await readFile(targetPath, "utf8"); } catch { /* file missing */ }

      if (existing === undefined) {
        // Missing — install
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, expected, "utf8");
        await ensureExecutableIfHook(entry.dest, targetPath);
        report.installed.push(entry.dest);
      } else if (sha256(existing) === sha256(expected)) {
        // Content matches — current or adoptable
        if (!isLeanRigorOwned(existing)) {
          // Content-equal but no ownership token — adopt by adding the token
          await adoptAsset(targetPath, expected);
          await ensureExecutableIfHook(entry.dest, targetPath);
          report.adopted.push(entry.dest);
        } else {
          // Already owned and current
          await ensureExecutableIfHook(entry.dest, targetPath);
          report.alreadyCurrent.push(entry.dest);
        }
      } else if (isLeanRigorOwned(existing) && force) {
        // Owned, modified, force-replace
        await writeFile(targetPath, expected, "utf8");
        await ensureExecutableIfHook(entry.dest, targetPath);
        report.installed.push(entry.dest);
      } else {
        // Non-owned different content, or modified owned without force — skip
        report.skipped.push(entry.dest);
      }
    }

    // Merge LeanRigor hook entries into shared .claude/settings.json
    const settingsPath = path.join(root, ".claude", "settings.json");
    const packagedSettingsPath = path.join(pluginDir(), "settings.json");
    const mergeResult = await mergeLeanRigorHooks(settingsPath, packagedSettingsPath);
    report.settingsModified = mergeResult.modified;
    report.settingsState = mergeResult.state;

    return report;
  }

  async uninstall(root: string): Promise<UninstallReport> {
    const config = await loadConfigForUninstall(root);
    const triageModel = resolveModelTier(config.routing.triage, "claude", config).model ?? "haiku";
    const manifest = assetManifestWithoutSettings(triageModel);
    const report: UninstallReport = { removed: [], skipped: [] };

    for (const entry of manifest) {
      const targetPath = path.join(root, entry.dest);
      let existing: string | undefined;
      try { existing = await readFile(targetPath, "utf8"); } catch { /* file missing — nothing to remove */ }

      if (existing === undefined) continue;

      if (!isLeanRigorOwned(existing)) {
        report.skipped.push(entry.dest);
        continue;
      }

      // Hash comparison detects user modifications. Note: for template-based assets
      // (e.g. leanrigor-triage.md) the expected content depends on the current config.
      // If the triage model was changed after installation, the hashes will differ even
      // without user edits. In that case the file is skipped (preserved), which is the
      // safe default. To remove all LeanRigor-owned files, delete them manually or run
      // `leanrigor uninstall --adapter claude` after resetting the config to the original
      // model tier.
      const expected = await readPackagedAsset(entry.src, entry.vars).catch(() => undefined);
      if (expected !== undefined && sha256(existing) !== sha256(expected)) {
        // User has modified this owned file (or config changed) — preserve it
        report.skipped.push(entry.dest);
        continue;
      }

      await unlink(targetPath);
      report.removed.push(entry.dest);

      // Remove the parent directory and ancestor directories up to .claude/ if now empty
      const claudeDir = path.join(root, ".claude");
      let dir = path.dirname(targetPath);
      while (dir.length > claudeDir.length && dir.startsWith(claudeDir)) {
        const removed = await removeIfEmpty(dir);
        if (!removed) break; // Directory still has contents — stop climbing
        dir = path.dirname(dir);
      }
      await removeIfEmpty(claudeDir);
    }

    // Remove LeanRigor hook entries from shared .claude/settings.json
    // (do NOT delete the file — it is shared with other Claude Code settings)
    const settingsPath = path.join(root, ".claude", "settings.json");
    await removeLeanRigorHooks(settingsPath);

    return report;
  }

  async doctor(root: string, config: LeanRigorConfig): Promise<string[]> {
    const output: string[] = [];
    const packageVersion = await readPackageVersion();
    const mode = await detectInstallationMode(root);

    // --- Header: installation mode, version, runtime source ---
    output.push(`Installation mode: ${mode}`);
    output.push(`Runtime source: ${runtimeSource()}`);
    output.push(`Package version: ${packageVersion}`);
    output.push(`Asset version: ${ASSET_VERSION}`);
    output.push(`Platform: Claude Code`);

    // --- Configuration files found ---
    output.push("");
    output.push("Configuration files:");
    const userConfig = await loadUserConfig();
    output.push(`  User config (~/.config/leanrigor/config.json): ${userConfig ? "found" : "not found"}`);
    const repoPolicy = await loadRepoPolicy(root);
    output.push(`  Repository policy (leanrigor.config.json): ${repoPolicy ? "found" : "not found"}`);
    const localExists = await configFileExists(ConfigScope.Local, root);
    output.push(`  Local config (.leanrigor/config.json): ${localExists ? "found" : "not found (using defaults)"}`);

    // --- .leanrigor/.gitignore status ---
    const gitignoreStatus = await ensureGitignore(path.join(root, ".leanrigor"));
    output.push("");
    output.push(gitignoreStatus.message);

    // Check for tracked .leanrigor files
    const trackedFiles = await checkTrackedLeanrigorFiles(root);
    if (trackedFiles.length > 0) {
      output.push(`⚠ WARNING: ${trackedFiles.length} file(s) in .leanrigor/ may be tracked by Git:`);
      for (const file of trackedFiles) {
        output.push(`  .leanrigor/${file}`);
      }
      output.push("  These files contain private runtime state and should not be committed.");
    }

    // Check Claude CLI availability
    const claudeInPath = await which("claude");
    if (claudeInPath) {
      output.push(`Claude CLI: found (${claudeInPath})`);
    } else {
      try {
        await access("/usr/local/bin/claude");
        output.push("Claude CLI: found at /usr/local/bin/claude");
      } catch {
        output.push("Claude CLI: not found on PATH");
      }
    }

    // --- Model tier resolution ---
    output.push("");
    output.push("Model tier resolution:");
    for (const tier of ["small", "medium", "large"] as const) {
      try {
        output.push(formatModelTierLine(tier, "claude", config));
      } catch (error) { output.push(`  ${tier}: ERROR — ${(error as Error).message}`); }
    }

    // --- Asset inspection (mode-aware) ---
    if (mode === "marketplace") {
      // Marketplace: use plugin-root assets directly
      output.push("");
      output.push("Plugin assets: current (served from plugin root)");
      output.push("Project-local fallback assets: not applicable");

      // Shadowing detection
      const shadowing = await detectShadowing(root, mode, config);
      if (shadowing.detected) {
        output.push("");
        output.push("⚠ Legacy project-local fallback assets detected:");
        output.push("Status: shadowing risk — these may shadow marketplace plugin commands/agents");
        for (const asset of shadowing.assets) {
          output.push(`  ${asset.path} (${asset.status})`);
        }
        output.push("Recommended: leanrigor cleanup --adapter claude --project-local-only --dry-run");
      }

      // Shared settings for marketplace mode
      output.push("");
      output.push("Shared configuration:");
      output.push("  .claude/settings.json: not managed by marketplace installation");
    } else {
      // Project-local or unknown: inspect fallback assets
      const inspection = await this.inspectAssets(root, config);

      // Asset summary
      output.push("");
      output.push(`Fallback assets: ${inspection.installedCount}/${inspection.totalAvailable}`);
      const assetIssues = [...inspection.missing, ...inspection.conflicts, ...inspection.modified];
      if (assetIssues.length === 0) {
        output.push("Status: current");
      } else {
        output.push("Status: incomplete or needs attention");
      }

      if (inspection.current.length > 0) {
        output.push("");
        output.push("Current:");
        for (const f of inspection.current) output.push(`  ${f}`);
      }

      if (inspection.adoptable.length > 0) {
        output.push("");
        output.push("Adoptable (content matches packaged version, safe to adopt on next bootstrap):");
        for (const f of inspection.adoptable) output.push(`  ${f}`);
      }

      // Git protection hook
      output.push("");
      output.push("Git protection hook:");
      output.push(`  ${inspection.protectGitState}`);

      if (inspection.missing.length > 0) {
        output.push("");
        const cmd = isMarketplaceRuntime() ? "next LeanRigor command" : "`leanrigor init --adapter claude`";
        output.push(`Missing (will be repaired automatically by ${cmd}):`);
        for (const f of inspection.missing) output.push(`  ${f}`);
      }
      if (inspection.modified.length > 0) {
        output.push("");
        output.push("Modified (LeanRigor-owned files with local changes):");
        for (const f of inspection.modified) output.push(`  ${f}`);
        output.push("  Use `leanrigor init --adapter claude --force-owned-files` to restore.");
      }
      if (inspection.conflicts.length > 0) {
        output.push("");
        output.push("Conflict (non-LeanRigor files in expected locations):");
        for (const f of inspection.conflicts) output.push(`  ${f}`);
      }

      // Shared settings.json summary
      output.push("");
      output.push("Shared configuration:");
      output.push(`  .claude/settings.json: ${inspection.settingsDetail}`);

      // Bootstrap health
      output.push("");
      const bootstrapped = inspection.missing.length === 0 && inspection.adoptable.length === 0
        && (inspection.settingsState === "shared_current");
      output.push(`Project bootstrap: ${bootstrapped ? "complete" : inspection.missing.length > 0 ? "incomplete" : "repairable"} (${isMarketplaceRuntime() ? "marketplace" : "project-local"} mode)`);
    }

    // --- Workflow settings ---
    output.push("");
    output.push(`Automatic triage: ${config.workflow.automaticTriage ? "enabled" : "disabled"}`);

    // --- Config management hints ---
    output.push("");
    output.push("Configuration management:");
    output.push("  Show effective config: leanrigor config show");
    output.push("  Show config detail:   leanrigor config show --json");
    output.push("  Change user setting:   leanrigor config set <path> <value> --scope user");
    output.push("  Change repo policy:    leanrigor config set <path> <value> --scope repo");
    output.push("  Change local setting:  leanrigor config set <path> <value> --scope local");

    return output;
  }

  /**
   * Inspect installed plugin assets and return structured status.
   * Fact-only: no speculation about why files differ.
   */
  async inspectAssets(root: string, config: LeanRigorConfig): Promise<AssetInspectionResult> {
    const triageModel = resolveModelTier(config.routing.triage, "claude", config).model ?? "haiku";
    const manifest = assetManifest(triageModel);
    const manifestEntries: AssetInspectionResult["manifest"] = [];

    let installedCount = 0;
    const current: string[] = [];
    const modified: string[] = [];
    const missing: string[] = [];
    const conflicts: string[] = [];
    const adoptable: string[] = [];
    let protectGitState = "missing";

    for (const entry of manifest) {
      const targetPath = path.join(root, entry.dest);
      let existing: string | undefined;
      try { existing = await readFile(targetPath, "utf8"); } catch { /* missing */ }

      // settings.json is handled separately via the settings-merger
      if (isSettingsJson(entry.dest)) continue;

      if (existing === undefined) {
        missing.push(entry.dest);
        manifestEntries.push({ dest: entry.dest, status: "missing" });
        if (isProtectGit(entry.dest)) protectGitState = "missing";
        continue;
      }

      installedCount += 1;
      const expected = await readPackagedAsset(entry.src, entry.vars).catch(() => undefined);
      if (!isLeanRigorOwned(existing)) {
        // Check for content-equality: if the file matches the packaged version exactly,
        // it's adoptable rather than a conflict (e.g. manually copied protect-git.sh).
        if (expected !== undefined && sha256(existing) === sha256(expected)) {
          adoptable.push(entry.dest);
          manifestEntries.push({ dest: entry.dest, status: "adoptable" });
          if (isProtectGit(entry.dest)) {
            protectGitState = await isExecutable(targetPath)
              ? "adoptable and executable"
              : "adoptable but not executable";
          }
        } else {
          conflicts.push(entry.dest);
          manifestEntries.push({ dest: entry.dest, status: "conflict" });
          if (isProtectGit(entry.dest)) protectGitState = "content differs from packaged version (not LeanRigor-owned)";
        }
      } else if (expected !== undefined && sha256(existing) === sha256(expected)) {
        current.push(entry.dest);
        manifestEntries.push({ dest: entry.dest, status: "current" });
        if (isProtectGit(entry.dest)) {
          protectGitState = await isExecutable(targetPath)
            ? "current and executable"
            : "installed but not executable";
        }
      } else {
        modified.push(entry.dest);
        manifestEntries.push({ dest: entry.dest, status: "modified" });
        if (isProtectGit(entry.dest)) protectGitState = "modified (content differs from packaged version)";
      }
    }

    // Use the settings-merger for actual .claude/settings.json state detection
    const settingsPath = path.join(root, ".claude", "settings.json");
    const packagedSettingsPath = path.join(pluginDir(), "settings.json");
    const settingsCheck = await checkSettingsState(settingsPath, packagedSettingsPath);
    const settingsState = settingsCheck.state;
    const settingsDetail = settingsCheck.detail;

    const gitignoreStatus = await ensureGitignore(path.join(root, ".leanrigor"));
    const trackedFiles = await checkTrackedLeanrigorFiles(root);

    return {
      manifest: manifestEntries,
      current,
      modified,
      missing,
      conflicts,
      adoptable,
      totalAvailable: manifest.filter((e) => !isSettingsJson(e.dest)).length,
      installedCount,
      settingsState,
      settingsDetail,
      protectGitState,
      gitignoreStatus,
      trackedLeanrigorFiles: trackedFiles,
    };
  }
}

function isProtectGit(dest: string): boolean {
  return dest === PROTECT_GIT_DEST;
}

function isSettingsJson(dest: string): boolean {
  return dest === ".claude/settings.json";
}

/**
 * Adopt a content-equal file that lacks LeanRigor ownership.
 * Writes the packaged asset (which includes the ownership token) to the target,
 * effectively converting a manually-copied file into a LeanRigor-owned one.
 */
async function adoptAsset(targetPath: string, expectedContent: string): Promise<void> {
  await writeFile(targetPath, expectedContent, "utf8");
}

async function ensureExecutableIfHook(dest: string, targetPath: string): Promise<void> {
  if (isProtectGit(dest)) await chmod(targetPath, 0o755);
}

async function isExecutable(targetPath: string): Promise<boolean> {
  if (process.platform === "win32") return true;
  try {
    const mode = (await stat(targetPath)).mode;
    return (mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function removeIfEmpty(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    if (entries.length === 0) {
      await rmdir(dir).catch(() => { /* ignore: may not be removable (race condition or permissions) */ });
      return true;
    }
    return false;
  } catch { /* ignore: directory may not exist */ }
  return false;
}

async function which(command: string): Promise<string | undefined> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn("which", [command], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("close", (code: number | null) => {
      resolve(code === 0 ? out.trim() : undefined);
    });
    child.on("error", () => resolve(undefined));
  });
}

async function readPackageVersion(): Promise<string> {
  try {
    // Walk up from plugin dir to find package.json
    const packageJsonPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function runtimeSource(): string {
  if (process.env.LEANRIGOR_CLAUDE_PLUGIN_ROOT) return `\${CLAUDE_PLUGIN_ROOT}/bin/leanrigor (plugin runtime)`;
  if (process.env.CLAUDE_PLUGIN_ROOT) return `\${CLAUDE_PLUGIN_ROOT}/bin/leanrigor (plugin runtime)`;
  if (process.env.LEANRIGOR_RUNTIME_SOURCE === "claude-marketplace-plugin") return "marketplace plugin runtime";
  if (process.argv[1]?.includes(`${path.sep}node_modules${path.sep}`)) return "npm package CLI";
  return "local development or global CLI";
}

/** Load config for uninstall without crashing if config is missing. */
async function loadConfigForUninstall(root: string): Promise<LeanRigorConfig> {
  try {
    const { loadConfig } = await import("../../config/load.js");
    return loadConfig(root);
  } catch {
    const { defaultConfig } = await import("../../config/defaults.js");
    return defaultConfig();
  }
}
