import { ensureRepositoryConfig, ensureGitignore, findRepoRoot } from "../config/bootstrap.js";
import { ClaudeAdapter, type BootstrapReport, type InstallationMode, type ShadowingReport, detectInstallationMode, detectShadowing } from "../adapters/claude/adapter.js";
import type { LeanRigorConfig } from "../config/schema.js";
import path from "node:path";

/** Result of an ensureBootstrapped call. */
export interface EnsureBootstrappedResult {
  /** Whether bootstrap ran and made changes. */
  bootstrapped: boolean;
  /** Detailed report from the adapter bootstrap (if it ran). */
  report: BootstrapReport | null;
  /** The resolved configuration. */
  config: LeanRigorConfig;
  /** Warnings that may need user attention. */
  warnings: string[];
  /** The detected installation mode. */
  installationMode: InstallationMode;
  /** Shadowing report (only populated when marketplace mode detects stale fallback assets). */
  shadowing: ShadowingReport | null;
}

/**
 * Ensure the repository is fully bootstrapped for LeanRigor use.
 *
 * This is the single entry point called by all commands that need
 * a working LeanRigor environment:
 * - CLI `init-report` / `init` / `setup` / `flow start`
 * - Doctor repair
 * - Marketplace plugin commands (via the runtime)
 *
 * In marketplace mode, only repository state (.leanrigor/) is created.
 * Adapter bootstrap (project-local .claude/ assets) only runs in
 * project-local or unknown modes.
 *
 * The function is safe to call repeatedly — it only installs or repairs
 * missing items.
 */
export async function ensureBootstrapped(
  root: string,
  opts: { force?: boolean } = {},
): Promise<EnsureBootstrappedResult> {
  const warnings: string[] = [];

  // 1. Always ensure .leanrigor/ directory, .gitignore, and config.json
  const config = await ensureRepositoryConfig(root);

  // 2. Always ensure .leanrigor/.gitignore is correct
  await ensureGitignore(path.join(root, ".leanrigor"));

  // 3. Detect installation mode
  const installationMode = await detectInstallationMode(root);

  // 4. Detect shadowing if in marketplace mode
  let shadowing: ShadowingReport | null = null;
  if (installationMode === "marketplace") {
    shadowing = await detectShadowing(root, installationMode, config);
    if (shadowing.detected) {
      for (const asset of shadowing.assets) {
        warnings.push(`Shadowing risk: ${asset.path} (${asset.status}) — project-local asset may shadow marketplace plugin asset`);
      }
    }
  }

  // 5. In marketplace mode, skip adapter bootstrap entirely
  if (installationMode === "marketplace") {
    return {
      bootstrapped: false,
      report: null,
      config,
      warnings,
      installationMode,
      shadowing,
    };
  }

  // 6. Bootstrap Claude adapter assets (project-local or unknown mode)
  const adapter = new ClaudeAdapter();
  const hasBootstrap = typeof adapter.bootstrap === "function";

  if (!hasBootstrap) {
    // Fallback to install (older adapter or custom)
    const report = await adapter.install(root, config, opts.force ?? false);
    const bootstrapped = report.installed.length > 0;
    return {
      bootstrapped,
      report: {
        installed: report.installed,
        alreadyCurrent: report.alreadyCurrent,
        adopted: [],
        skipped: report.skipped,
        settingsModified: false,
        settingsState: "unknown",
      },
      config,
      warnings,
      installationMode,
      shadowing: null,
    };
  }

  let report: BootstrapReport;
  try {
    report = await adapter.bootstrap(root, config, opts.force ?? false);
  } catch (err: unknown) {
    // Bootstrap may fail when plugin source assets are unavailable
    // (e.g. running from a bare bundled runtime without plugin files).
    // The command should still proceed — report the issue as a warning.
    warnings.push(`Bootstrap skipped: ${(err as Error).message}`);
    return {
      bootstrapped: false,
      report: null,
      config,
      warnings,
      installationMode,
      shadowing: null,
    };
  }

  const bootstrapped =
    report.installed.length > 0 ||
    report.adopted.length > 0 ||
    report.settingsModified;

  if (report.skipped.length > 0) {
    warnings.push(
      `${report.skipped.length} file(s) were skipped (non-owned or user-modified): ${report.skipped.join(", ")}`,
    );
  }

  if (report.adopted.length > 0) {
    warnings.push(
      `${report.adopted.length} file(s) had matching content but no ownership token — adopted: ${report.adopted.join(", ")}`,
    );
  }

  return {
    bootstrapped,
    report,
    config,
    warnings,
    installationMode,
    shadowing: null,
  };
}

/**
 * Minimal bootstrap for marketplace mode: ensure .leanrigor/ state only.
 * Does NOT install project-local .claude/ assets.
 *
 * Use this when you know the runtime is in marketplace mode and want to
 * avoid the full adapter bootstrap overhead.
 */
export async function ensureStateBootstrapped(root: string): Promise<EnsureBootstrappedResult> {
  const config = await ensureRepositoryConfig(root);
  await ensureGitignore(path.join(root, ".leanrigor"));
  return {
    bootstrapped: false,
    report: null,
    config,
    warnings: [],
    installationMode: "marketplace",
    shadowing: null,
  };
}

/**
 * Convenience wrapper that infers the repository root and bootstraps.
 */
export async function ensureBootstrappedAtCwd(
  opts: { force?: boolean } = {},
): Promise<EnsureBootstrappedResult> {
  const root = findRepoRoot(process.cwd());
  return ensureBootstrapped(root, opts);
}
