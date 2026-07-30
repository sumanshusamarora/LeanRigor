import type { LeanRigorConfig, ModelTier } from "../config/schema.js";
import type { ExecutionProvider } from "../core/execution/provider.js";
import type { PlanningProvider } from "../core/planning-runner.js";
import type { PhaseBriefPlanningProvider } from "../core/phase-brief-planner.js";
import type { StructuredDecisionProvider } from "../core/structured-decision.js";
import type { TriageProvider } from "../core/triage-runner.js";

export interface ModelResolver {
  resolve(tier: ModelTier, config: LeanRigorConfig): string | undefined;
}

/** Result of installing Claude Code plugin assets into a repository. */
export interface InstallReport {
  /** Relative paths that were newly written. */
  installed: string[];
  /** Relative paths whose content already matched the packaged version. */
  alreadyCurrent: string[];
  /**
   * Relative paths that were skipped because a non-owned file already
   * exists there, or because an owned file has been user-modified and
   * `--force-owned-files` was not requested.
   */
  skipped: string[];
}

/** Result of removing Claude Code plugin assets from a repository. */
export interface UninstallReport {
  /** Relative paths that were removed. */
  removed: string[];
  /**
   * Relative paths that were skipped because the file is either not
   * LeanRigor-owned or has been modified since installation.
   */
  skipped: string[];
}

export interface HarnessAdapter {
  name: string;
  modelResolver: ModelResolver;
  install(root: string, config: LeanRigorConfig, force?: boolean): Promise<InstallReport>;
  uninstall(root: string): Promise<UninstallReport>;
  doctor(root: string, config: LeanRigorConfig): Promise<string[]>;
  bootstrap?(root: string, config: LeanRigorConfig, force?: boolean): Promise<{
    installed: string[];
    alreadyCurrent: string[];
    adopted: string[];
    skipped: string[];
    settingsModified: boolean;
    settingsState: string;
  }>;
}

export interface AdapterRuntime {
  readonly id: string;
  readonly adapter: HarnessAdapter;
  createTriageProvider(): TriageProvider;
  createStructuredDecisionProvider?(): StructuredDecisionProvider;
  createPlanningProvider(): PlanningProvider;
  createPhaseBriefPlanningProvider(): PhaseBriefPlanningProvider;
  createExecutionProvider(config: LeanRigorConfig): ExecutionProvider;
}
