#!/usr/bin/env node
import { Command } from "commander";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/load.js";
import { defaultConfig } from "../config/defaults.js";
import { saveWorkflow, loadWorkflow } from "../core/workflow.js";
import { ClaudeAdapter } from "../adapters/claude/adapter.js";
import { ClaudeCliTriageProvider } from "../adapters/claude/triage-provider.js";
import { runTriage } from "../core/triage-runner.js";
import { leanRigorConfigSchema } from "../config/schema.js";
import type { InstallReport, UninstallReport } from "../adapters/types.js";

const program = new Command();
program.name("leanrigor").description("Adaptive rigor and model routing for AI coding agents").version("0.1.0-draft");

program.command("setup")
  .alias("init")
  .description("Create repository configuration and Claude Code adapter files")
  .option("--root <path>", "repository root", process.cwd())
  .option("--adapter <adapter>", "harness adapter: claude", "claude")
  .option("--force-owned-files", "replace LeanRigor-owned files that have local changes")
  .action(async ({ root, adapter, forceOwnedFiles }) => {
    if (adapter !== "claude") throw new Error(`Unsupported adapter: ${adapter}. Only 'claude' is currently supported.`);
    const configDir = path.join(root, ".leanrigor");
    await mkdir(configDir, { recursive: true });
    const config = await initConfig(root);
    const report = await new ClaudeAdapter().install(root, config, forceOwnedFiles as boolean);
    console.log(`LeanRigor configured. Claude defaults: small=haiku, medium=sonnet, large=opus.`);
    printInstallReport(report);
  });

program.command("uninstall")
  .description("Remove LeanRigor-owned adapter files from a repository")
  .option("--root <path>", "repository root", process.cwd())
  .option("--adapter <adapter>", "harness adapter: claude", "claude")
  .option("--remove-config", "also remove .leanrigor/config.json")
  .action(async ({ root, adapter, removeConfig }) => {
    if (adapter !== "claude") throw new Error(`Unsupported adapter: ${adapter}. Only 'claude' is currently supported.`);
    const report = await new ClaudeAdapter().uninstall(root);
    printUninstallReport(report);
    if (removeConfig) {
      const configPath = path.join(root, ".leanrigor", "config.json");
      try {
        const { unlink, rmdir } = await import("node:fs/promises");
        await unlink(configPath);
        await rmdir(path.join(root, ".leanrigor")).catch(() => { /* not empty */ });
        console.log("Removed .leanrigor/config.json");
      } catch {
        console.log(".leanrigor/config.json not found.");
      }
    }
  });

program.command("models")
  .description("Configure portable small, medium, and large model tiers")
  .option("--root <path>", "repository root", process.cwd())
  .option("--claude-small <model>")
  .option("--claude-medium <model>")
  .option("--claude-large <model>")
  .option("--opencode-small <model>")
  .option("--opencode-medium <model>")
  .option("--opencode-large <model>")
  .action(async (options) => {
    const root = options.root;
    const config = await loadConfig(root);
    for (const tier of ["small", "medium", "large"] as const) {
      const claude = options[`claude${capitalise(tier)}`];
      const opencode = options[`opencode${capitalise(tier)}`];
      if (claude) config.models.tiers[tier].claude = claude;
      if (opencode) config.models.tiers[tier].opencode = opencode;
    }
    await writeConfig(root, leanRigorConfigSchema.parse(config));
    console.log((await new ClaudeAdapter().doctor(root, config)).join("\n"));
    if (!config.models.tiers.small.opencode || !config.models.tiers.medium.opencode || !config.models.tiers.large.opencode) {
      console.log("OpenCode tiers are incomplete. Supply provider/model identifiers before enabling the OpenCode adapter.");
    }
  });

program.command("triage")
  .argument("<request>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--provider <provider>", "triage provider: auto, claude, or deterministic", "auto")
  .action(async (request, { root, provider }) => {
    const config = await loadConfig(root);
    if (!["auto", "claude", "deterministic"].includes(provider)) throw new Error(`Unsupported triage provider: ${provider}`);
    const triageProvider = provider === "deterministic" ? undefined : new ClaudeCliTriageProvider();
    const result = await runTriage({ request, root, config, provider: triageProvider });
    const assessment = result.output;
    await saveWorkflow(root, { version: 1, request, mode: assessment.workflow.finalMode, assessment,
      triageRun: { source: result.source, provider: result.provider, model: result.model, attempts: result.attempts, warnings: result.warnings },
      currentPhase: assessment.clarification.required ? "clarification" : "planning", decisions: [], updatedAt: new Date().toISOString() });
    console.log(JSON.stringify(result, null, 2));
  });

program.command("status").option("--root <path>", "repository root", process.cwd()).action(async ({ root }) => {
  const state = await loadWorkflow(root); console.log(state ? JSON.stringify(state, null, 2) : "No active workflow.");
});

program.command("doctor")
  .option("--root <path>", "repository root", process.cwd())
  .option("--adapter <adapter>", "harness adapter: claude", "claude")
  .action(async ({ root, adapter }) => {
    if (adapter !== "claude") throw new Error(`Unsupported adapter: ${adapter}. Only 'claude' is currently supported.`);
    const config = await loadConfig(root);
    console.log((await new ClaudeAdapter().doctor(root, config)).join("\n"));
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printInstallReport(report: InstallReport): void {
  if (report.installed.length > 0) {
    console.log("\nInstalled:");
    for (const f of report.installed) console.log(`  ${f}`);
  }
  if (report.alreadyCurrent.length > 0) {
    console.log("\nAlready current:");
    for (const f of report.alreadyCurrent) console.log(`  ${f}`);
  }
  if (report.skipped.length > 0) {
    console.log("\nSkipped because file differs:");
    for (const f of report.skipped) console.log(`  ${f}`);
    console.log("\nUse `leanrigor init --adapter claude --force-owned-files` to replace only files");
    console.log("that contain LeanRigor ownership metadata.");
  }
}

function printUninstallReport(report: UninstallReport): void {
  if (report.removed.length > 0) {
    console.log("\nRemoved:");
    for (const f of report.removed) console.log(`  ${f}`);
  }
  if (report.skipped.length > 0) {
    console.log("\nSkipped (user file or user-modified owned file):");
    for (const f of report.skipped) console.log(`  ${f}`);
  }
  if (report.removed.length === 0 && report.skipped.length === 0) {
    console.log("No LeanRigor-owned files found.");
  }
}

async function initConfig(root: string) {
  const configPath = path.join(root, ".leanrigor", "config.json");
  const existing = await readFile(configPath, "utf8").catch(() => undefined);
  if (existing) return leanRigorConfigSchema.parse(JSON.parse(existing));
  const config = defaultConfig();
  config.instructions = await detectInstructions(root);
  await writeConfig(root, config);
  return config;
}

async function writeConfig(root: string, config: unknown): Promise<void> {
  const dir = path.join(root, ".leanrigor"); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "config.json"), JSON.stringify({ $schema: "../node_modules/leanrigor/config.schema.json", ...(config as object) }, null, 2) + "\n");
}
async function detectInstructions(root: string): Promise<string[]> {
  const candidates = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"];
  const topLevel = new Set(await readdir(root).catch(() => [])); return candidates.filter((candidate) => topLevel.has(candidate));
}
function capitalise(value: string): string { return value[0].toUpperCase() + value.slice(1); }
await program.parseAsync();
