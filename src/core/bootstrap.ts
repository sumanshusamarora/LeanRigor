import { ensureRepositoryConfig, ensureGitignore, findRepoRoot } from "../config/bootstrap.js";
import { ClaudeAdapter, type BootstrapReport } from "../adapters/claude/adapter.js";
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
 * In marketplace mode, the adapter is inferred as `claude`.
 * The function is safe to call repeatedly — it only installs or repairs
 * missing items.
 */
export async function ensureBootstrapped(
  root: string,
  opts: { force?: boolean } = {},
): Promise<EnsureBootstrappedResult> {
  const warnings: string[] = [];

  // 1. Ensure .leanrigor/ directory, .gitignore, and config.json
  const config = await ensureRepositoryConfig(root);

  // 2. Ensure .leanrigor/.gitignore is correct
  await ensureGitignore(path.join(root, ".leanrigor"));

  // 3. Bootstrap Claude adapter assets
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
