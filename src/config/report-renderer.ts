import type { InitReport } from "./init-report.js";

// ---------------------------------------------------------------------------
// Deterministic text renderer for InitReport
// ---------------------------------------------------------------------------

/**
 * Render an InitReport as human-readable text.
 *
 * This function is fully deterministic — the same InitReport always produces
 * the same text. No LLM is needed to produce the report body.
 */
export function renderInitReport(report: InitReport): string {
  const lines: string[] = [];

  lines.push("=== LeanRigor Configuration ===");
  lines.push("");

  // --- Bootstrap summary (if bootstrapping ran before this report) ---
  if (report.bootstrap?.bootstrapped) {
    lines.push("LeanRigor project bootstrap completed.");
    const parts: string[] = [];
    if (report.bootstrap.installed > 0) parts.push(`Installed: ${report.bootstrap.installed} assets`);
    if (report.bootstrap.adopted > 0) parts.push(`Adopted: ${report.bootstrap.adopted} files`);
    if (report.bootstrap.settingsModified) parts.push("Shared settings: LeanRigor entries merged");
    lines.push(parts.join(". ") || "No changes needed.");
    lines.push("");
  }

  // --- Configuration files ---
  renderConfigFiles(report, lines);

  // --- Gitignore ---
  lines.push(`.leanrigor/.gitignore: ${report.gitignore.message}`);

  // --- Model tiers ---
  lines.push("");
  lines.push("Model tier resolution:");
  lines.push(renderModelTable(report.models));

  // --- Execution ---
  if (Object.keys(report.execution).length > 0) {
    lines.push("");
    lines.push("Execution:");
    for (const [key, entry] of Object.entries(report.execution)) {
      const shortKey = key.replace("execution.", "");
      lines.push(`  ${shortKey}: ${JSON.stringify(entry.value)} (source: ${entry.source})`);
    }
  }

  // --- Shared settings ---
  lines.push("");
  lines.push("Shared configuration:");
  lines.push(renderSettingsState(report.settings, report.isMarketplace));

  // --- Asset drift ---
  lines.push("");
  lines.push("LeanRigor-managed assets:");
  lines.push(`  total available: ${report.assets.totalAvailable}`);
  lines.push(`  installed: ${report.assets.installedCount}`);
  lines.push(`  current: ${report.assets.current.length}`);
  lines.push(`  modified: ${report.assets.modified.length}`);
  lines.push(`  missing: ${report.assets.missing.length}`);
  lines.push(`  adoptable: ${report.assets.adoptable.length}`);
  lines.push(`  conflicts: ${report.assets.conflicts.length}`);

  if (report.assets.modified.length > 0) {
    lines.push("");
    lines.push("Modified assets (LeanRigor-owned files with local changes):");
    for (const f of report.assets.modified) {
      lines.push(`  ${f}`);
    }
    lines.push("  Use `leanrigor init --adapter claude --force-owned-files` to restore.");
  }

  if (report.assets.missing.length > 0) {
    lines.push("");
    if (report.isMarketplace) {
      lines.push("Missing assets (will be repaired automatically on next command):");
    } else {
      lines.push("Missing assets (run `leanrigor init --adapter claude` to install):");
    }
    for (const f of report.assets.missing) {
      lines.push(`  ${f}`);
    }
  }

  if (report.assets.adoptable.length > 0) {
    lines.push("");
    lines.push("Adoptable assets (content matches packaged version, safe to adopt on next bootstrap):");
    for (const f of report.assets.adoptable) {
      lines.push(`  ${f}`);
    }
  }

  if (report.assets.conflicts.length > 0) {
    lines.push("");
    lines.push("Conflicting assets (non-LeanRigor files in expected locations):");
    for (const f of report.assets.conflicts) {
      lines.push(`  ${f}`);
    }
  }

  // --- Constraints ---
  if (report.constraints.length > 0) {
    lines.push("");
    lines.push("Constraints (repository policy):");
    for (const constraint of report.constraints) {
      lines.push(`  ${constraint}`);
    }
  }

  // --- Warnings ---
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of report.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
  }

  // --- Valid examples ---
  lines.push("");
  lines.push("Configuration commands:");
  lines.push("  Show effective config: leanrigor config show");
  lines.push("  Show config detail:   leanrigor config show --json");
  lines.push("");
  lines.push("Example mutations:");
  for (const example of report.validExamples) {
    lines.push(`  # ${example.description}`);
    lines.push(`  ${example.command}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderConfigFiles(report: InitReport, lines: string[]): void {
  lines.push("Configuration files:");
  lines.push(`  User config:          ${report.configurationFiles.user.path} (${report.configurationFiles.user.status})`);
  lines.push(`  Repository policy:    ${report.configurationFiles.repositoryPolicy.path} (${report.configurationFiles.repositoryPolicy.status})`);
  lines.push(`  Local config:         ${report.configurationFiles.local.path} (${report.configurationFiles.local.status})`);
  lines.push("");

  const allMissing =
    report.configurationFiles.user.status === "missing" &&
    report.configurationFiles.repositoryPolicy.status === "missing" &&
    report.configurationFiles.local.status === "missing";

  if (allMissing) {
    lines.push("No user, repository-policy, or local configuration files were found.");
    lines.push("");
    lines.push("Effective values currently come from:");
    lines.push("  - Claude adapter-derived model mappings");
    lines.push("  - built-in execution defaults");
  }
}

function renderModelTable(
  models: InitReport["models"],
): string {
  const rows = models.map((m) => ({
    tier: m.tier,
    alias: m.adapterAlias ?? "—",
    model: m.resolvedModel ?? "—",
    source: m.source,
  }));

  const tierWidth = Math.max(8, ...rows.map((r) => r.tier.length));
  const aliasWidth = Math.max(13, ...rows.map((r) => r.alias.length));
  const modelWidth = Math.max(15, ...rows.map((r) => r.model.length));
  const sourceWidth = Math.max(6, ...rows.map((r) => r.source.length));

  const pad = (s: string, w: number) => s.padEnd(w);

  const header =
    `${pad("Tier", tierWidth)} | ${pad("Claude alias", aliasWidth)} | ${pad("Resolved model", modelWidth)} | Source`;
  const sep = `${"—".repeat(tierWidth)}—|—${"—".repeat(aliasWidth)}—|—${"—".repeat(modelWidth)}—|—${"—".repeat(sourceWidth)}`;

  const body = rows
    .map(
      (r) =>
        `${pad(r.tier, tierWidth)} | ${pad(r.alias, aliasWidth)} | ${pad(r.model, modelWidth)} | ${r.source}`,
    )
    .join("\n");

  return [header, sep, body].join("\n");
}

function renderSettingsState(settings: InitReport["settings"], isMarketplace: boolean): string {
  const lines: string[] = [];
  lines.push(`  ${settings.path}: ${settings.detail}`);

  switch (settings.status) {
    case "shared_current":
      lines.push("  .claude/settings.json is shared Claude Code configuration.");
      lines.push("  LeanRigor-owned hook entries are current.");
      lines.push("  Unrelated user settings were preserved.");
      break;
    case "shared_missing_leanrigor_entries":
      lines.push("  .claude/settings.json is shared Claude Code configuration.");
      lines.push("  The file exists but does not contain LeanRigor-owned hook entries.");
      if (!isMarketplace) {
        lines.push("  Run `leanrigor init --adapter claude` to install LeanRigor settings.");
      } else {
        lines.push("  LeanRigor hook entries will be merged on next bootstrap.");
      }
      break;
    case "shared_conflicting_leanrigor_entries":
      lines.push("  .claude/settings.json is shared Claude Code configuration.");
      lines.push("  LeanRigor-owned hook entries are present but differ from expected.");
      lines.push("  Use `leanrigor init --adapter claude --force-owned-files` to restore.");
      break;
    case "missing":
      lines.push("  .claude/settings.json is missing.");
      if (!isMarketplace) {
        lines.push("  Run `leanrigor init --adapter claude` to create it with LeanRigor hook entries.");
      } else {
        lines.push("  Will be created with LeanRigor hook entries on next bootstrap.");
      }
      break;
    case "shared_malformed":
      lines.push("  .claude/settings.json exists but is not valid JSON.");
      lines.push("  Fix the file manually before LeanRigor can manage its hook entries.");
      break;
    case "shared_unwritable":
      lines.push("  .claude/settings.json cannot be read or written.");
      lines.push("  Check file permissions and try again.");
      break;
  }

  return lines.join("\n");
}
