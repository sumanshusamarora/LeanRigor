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
import {
  answerClarification,
  approveApproach,
  approvePlan,
  cancelFlow,
  completeFlow,
  completePhase,
  getCommitPlan,
  listFlows,
  loadLatestFlow,
  nextActions,
  repairPhase,
  recordReview,
  recordValidation,
  rejectApproach,
  resumeFlow,
  revisePlan,
  startFlow,
  startPhase
} from "../core/flow.js";
import type { CriterionCompletionEvidence, SequentialWorkflowState, ValidationEvidence } from "../core/types.js";

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
        await rmdir(path.join(root, ".leanrigor")).catch(() => { /* ignore: directory may contain other files */ });
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
  const active = await loadLatestFlow(root).catch(() => undefined);
  if (active) {
    printFlowState(active);
    return;
  }
  const state = await loadWorkflow(root);
  console.log(state ? JSON.stringify(state, null, 2) : "No active workflow.");
});

program.command("doctor")
  .option("--root <path>", "repository root", process.cwd())
  .option("--adapter <adapter>", "harness adapter: claude", "claude")
  .action(async ({ root, adapter }) => {
    if (adapter !== "claude") throw new Error(`Unsupported adapter: ${adapter}. Only 'claude' is currently supported.`);
    const config = await loadConfig(root);
    console.log((await new ClaudeAdapter().doctor(root, config)).join("\n"));
  });

const flow = program.command("flow").description("Run the persisted sequential LeanRigor workflow");

flow.command("start")
  .argument("<request>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--provider <provider>", "triage provider: auto, claude, or deterministic", "auto")
  .action(async (request, options) => {
    const config = await ensureRepositoryConfig(options.root);
    const state = await startFlow({
      request,
      root: options.root,
      config,
      provider: triageProvider(options.provider)
    });
    printFlowState(state);
  });

flow.command("answer")
  .argument("<workflow-id>")
  .argument("<answer>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--provider <provider>", "triage provider: auto, claude, or deterministic", "auto")
  .action(async (workflowId, answer, options) => {
    const config = await ensureRepositoryConfig(options.root);
    printFlowState(await answerClarification({
      root: options.root,
      workflowId,
      answer,
      config,
      provider: triageProvider(options.provider)
    }));
  });

flow.command("approve-approach")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .action(async (workflowId, { root }) => {
    printFlowState(await approveApproach(root, workflowId, await ensureRepositoryConfig(root)));
  });

flow.command("reject-approach")
  .argument("<workflow-id>")
  .requiredOption("--reason <reason>", "reason for rejection")
  .option("--root <path>", "repository root", process.cwd())
  .action(async (workflowId, { root, reason }) => {
    printFlowState(await rejectApproach(root, workflowId, reason));
  });

flow.command("approve-plan")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .action(async (workflowId, { root }) => {
    printFlowState(await approvePlan(root, workflowId));
  });

flow.command("revise-plan")
  .argument("<workflow-id>")
  .argument("<feedback>")
  .option("--root <path>", "repository root", process.cwd())
  .action(async (workflowId, feedback, { root }) => {
    printFlowState(await revisePlan(root, workflowId, feedback, await ensureRepositoryConfig(root)));
  });

flow.command("phase-start")
  .argument("<workflow-id>")
  .argument("[phase-id]")
  .option("--root <path>", "repository root", process.cwd())
  .action(async (workflowId, phaseId, { root }) => {
    printFlowState(await startPhase(root, workflowId, phaseId));
  });

flow.command("phase-complete")
  .argument("<workflow-id>")
  .argument("<phase-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--evidence-file <path>", "JSON completion evidence file")
  .option("--files <files>", "comma-separated files changed")
  .option("--command <command>", "command run during the phase", collect, [])
  .option("--deviation <deviation>", "scope deviation to record", collect, [])
  .option("--assumption <assumption>", "assumption introduced during execution", collect, [])
  .option("--risk <risk>", "remaining risk", collect, [])
  .option("--blocked-reason <reason>", "external blocker preventing completion")
  .action(async (workflowId, phaseId, options) => {
    const evidence = options.evidenceFile ? await readCompletionEvidence(options.evidenceFile) : {};
    const config = await ensureRepositoryConfig(options.root);
    printFlowState(await completePhase({
      root: options.root,
      workflowId,
      phaseId,
      config,
      criteria: evidence.criteria,
      filesChanged: uniqueCli([...(evidence.filesChanged ?? []), ...splitCsv(options.files)]),
      commandsRun: uniqueCli([...(evidence.commandsRun ?? []), ...options.command]),
      validation: evidence.validation,
      scopeDeviations: uniqueCli([...(evidence.scopeDeviations ?? []), ...options.deviation]),
      assumptions: uniqueCli([...(evidence.assumptions ?? []), ...options.assumption]),
      remainingRisks: uniqueCli([...(evidence.remainingRisks ?? []), ...options.risk]),
      blockedReason: options.blockedReason ?? evidence.blockedReason,
      requestedRepairScope: evidence.requestedRepairScope,
      modelDecision: evidence.modelDecision
    }));
  });

flow.command("phase-status")
  .argument("<workflow-id>")
  .argument("<phase-id>")
  .option("--root <path>", "repository root", process.cwd())
  .action(async (workflowId, phaseId, { root }) => {
    const state = await resumeFlow(root, workflowId);
    const phase = state.plan?.phases.find((candidate) => candidate.id === phaseId);
    if (!phase) throw new Error(`Unknown phase: ${phaseId}`);
    console.log(JSON.stringify(formatPhaseStatus(state, phaseId), null, 2));
  });

flow.command("repair")
  .argument("<workflow-id>")
  .argument("<phase-id>")
  .requiredOption("--reason <reason>", "reason the repair is needed")
  .option("--scope <scope>", "requested bounded repair scope")
  .option("--root <path>", "repository root", process.cwd())
  .action(async (workflowId, phaseId, options) => {
    printFlowState(await repairPhase({
      root: options.root,
      workflowId,
      phaseId,
      reason: options.reason,
      requestedScope: options.scope,
      config: await ensureRepositoryConfig(options.root)
    }));
  });

flow.command("record-validation")
  .argument("<workflow-id>")
  .requiredOption("--command <command>", "validation command")
  .option("--root <path>", "repository root", process.cwd())
  .option("--phase <phase-id>", "phase ID")
  .option("--exit <code>", "exit status", "0")
  .option("--result <result>", "concise validation result", "")
  .option("--skipped", "record skipped validation")
  .option("--reason <reason>", "reason validation was skipped")
  .action(async (workflowId, options) => {
    printFlowState(await recordValidation({
      root: options.root,
      workflowId,
      phaseId: options.phase,
      command: options.command,
      exitStatus: options.skipped ? null : Number.parseInt(options.exit, 10),
      result: options.result || (options.skipped ? "Validation skipped." : "Validation command recorded."),
      skipped: Boolean(options.skipped),
      skippedReason: options.reason
    }));
  });

flow.command("record-review")
  .argument("<workflow-id>")
  .requiredOption("--status <status>", "passed, needs_repair, needs_replan, or blocked")
  .requiredOption("--summary <summary>", "concise review summary")
  .option("--root <path>", "repository root", process.cwd())
  .option("--finding <finding>", "review finding", collect, [])
  .option("--repair-scope <scope>", "smallest repair scope when repair is needed")
  .action(async (workflowId, options) => {
    const config = await ensureRepositoryConfig(options.root);
    printFlowState(await recordReview({
      root: options.root,
      workflowId,
      status: options.status,
      summary: options.summary,
      findings: options.finding,
      repairScope: options.repairScope,
      config
    }));
  });

flow.command("commit-plan")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .action(async (workflowId, { root }) => {
    console.log(JSON.stringify(await getCommitPlan(root, workflowId), null, 2));
  });

flow.command("complete")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .action(async (workflowId, { root }) => {
    printFlowState(await completeFlow(root, workflowId));
  });

flow.command("status")
  .argument("[workflow-id]")
  .option("--root <path>", "repository root", process.cwd())
  .action(async (workflowId, { root }) => {
    const state = workflowId ? await resumeFlow(root, workflowId) : await loadLatestFlow(root);
    if (!state) {
      console.log("No workflows found.");
      return;
    }
    printFlowState(state);
  });

flow.command("resume")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .action(async (workflowId, { root }) => {
    printFlowState(await resumeFlow(root, workflowId));
  });

flow.command("list")
  .option("--root <path>", "repository root", process.cwd())
  .action(async ({ root }) => {
    console.log(JSON.stringify(await listFlows(root), null, 2));
  });

flow.command("cancel")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .action(async (workflowId, { root }) => {
    printFlowState(await cancelFlow(root, workflowId));
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
    console.log("\nUse `leanrigor init --adapter claude --force-owned-files` to replace only LeanRigor-owned files.");
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

function triageProvider(provider: string): ClaudeCliTriageProvider | undefined {
  if (!["auto", "claude", "deterministic"].includes(provider)) throw new Error(`Unsupported triage provider: ${provider}`);
  return provider === "deterministic" ? undefined : new ClaudeCliTriageProvider();
}

function printFlowState(state: SequentialWorkflowState): void {
  console.log(JSON.stringify({
    id: state.id,
    revision: state.revision,
    state: state.state,
    mode: state.mode,
    request: state.request,
    pendingUserAction: pendingUserAction(state),
    triage: state.triage ? {
      task: state.triage.task,
      assessment: state.triage.assessment,
      finalMode: state.triage.workflow.finalMode,
      reviewLevel: state.triage.workflow.reviewLevel,
      testLevel: state.triage.workflow.testLevel,
      source: state.triageRun?.source,
      provider: state.triageRun?.provider,
      reasons: state.triage.escalationReasons,
      assumptions: state.triage.assumptions,
      overrideReason: state.triage.workflow.overrideReason
    } : undefined,
    clarification: state.clarification,
    approach: state.approach,
    phaseProgress: state.plan?.phases.map((phase) => ({
      id: phase.id,
      status: phase.status,
      objective: phase.objective,
      dependencies: phase.dependencies,
      expectedFilesOrAreas: phase.expectedFilesOrAreas,
      acceptanceCriteria: phase.acceptanceCriteria,
      validationCommands: phase.validationCommands,
      riskLevel: phase.riskLevel,
      modelTier: phase.modelTier,
      completionGate: phase.completion ? {
        decision: phase.completion.decision,
        reason: phase.completion.reason,
        criteria: summariseCriteria(phase.completion.criteria),
        validation: phase.completion.validation.status,
        dependentPhasesMayProceed: phase.completion.dependentPhasesMayProceed
      } : undefined,
      repairAttempts: phase.repairAttempts.length,
      scopeDeviations: phase.scopeDeviations
    })),
    validation: state.validation.map((evidence) => ({
      phaseId: evidence.phaseId,
      command: evidence.command,
      exitStatus: evidence.exitStatus,
      status: evidence.status,
      skipped: evidence.skipped,
      skippedReason: evidence.skippedReason,
      result: evidence.result
    })),
    review: state.review,
    commitPlan: state.commitPlan,
    blockers: state.blockers,
    currentPhase: currentPhaseStatus(state),
    nextValidCommands: nextActions(state),
    updatedAt: state.updatedAt
  }, null, 2));
}

function currentPhaseStatus(state: SequentialWorkflowState): unknown {
  const active = state.plan?.phases.find((phase) => phase.status === "active")
    ?? state.plan?.phases.find((phase) => ["needs_repair", "needs_review", "needs_replan", "blocked"].includes(phase.status));
  return active ? formatPhaseStatus(state, active.id) : undefined;
}

function formatPhaseStatus(state: SequentialWorkflowState, phaseId: string): unknown {
  const phase = state.plan?.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) return undefined;
  const completion = phase.completion;
  return {
    phase: phase.id,
    objective: phase.objective,
    status: phase.status,
    completionGate: completion?.decision ?? (phase.status === "active" ? "pending" : "not_started"),
    criteria: completion ? summariseCriteria(completion.criteria) : { met: 0, notMet: 0, uncertain: phase.acceptanceCriteria.length, notApplicable: 0 },
    validation: completion?.validation.status ?? (phase.validationResults.length > 0 ? "recorded" : "pending"),
    repairAttempts: `${phase.repairAttempts.length}/${phaseRepairBudget(state)}`,
    scopeDeviations: phase.scopeDeviations,
    reason: completion?.reason,
    blockedOrPendingReviewReason: ["needs_review", "needs_replan", "blocked"].includes(phase.status) ? completion?.reason : undefined,
    nextAction: nextActions(state)[0] ?? null
  };
}

function summariseCriteria(criteria: CriterionCompletionEvidence[]): { met: number; notMet: number; uncertain: number; notApplicable: number } {
  return {
    met: criteria.filter((criterion) => criterion.status === "met").length,
    notMet: criteria.filter((criterion) => criterion.status === "not_met").length,
    uncertain: criteria.filter((criterion) => criterion.status === "uncertain").length,
    notApplicable: criteria.filter((criterion) => criterion.status === "not_applicable").length
  };
}

function phaseRepairBudget(state: SequentialWorkflowState): number {
  if (state.mode === "fast") return 1;
  return 2;
}

function pendingUserAction(state: SequentialWorkflowState): string | null {
  if (state.state === "awaiting_clarification") return "Answer the single blocking clarification question.";
  if (state.state === "awaiting_approach_approval") return "Approve or reject the recommended approach.";
  if (state.state === "awaiting_plan_approval") return "Approve or revise the sequential plan.";
  if (state.state === "awaiting_commit_approval") return "Review the commit proposal; LeanRigor will not commit automatically.";
  if (state.state === "blocked") return "Resolve the blocker or cancel the workflow.";
  return null;
}

interface CompletionEvidenceFile {
  criteria?: CriterionCompletionEvidence[];
  filesChanged?: string[];
  commandsRun?: string[];
  validation?: Array<Partial<ValidationEvidence> & { command: string; result?: string; exitStatus?: number | null; skipped?: boolean; skippedReason?: string }>;
  scopeDeviations?: string[];
  assumptions?: string[];
  remainingRisks?: string[];
  blockedReason?: string;
  requestedRepairScope?: string;
  modelDecision?: "completed" | "needs_repair" | "needs_review" | "needs_replan" | "blocked";
}

async function readCompletionEvidence(file: string): Promise<Omit<CompletionEvidenceFile, "validation"> & { validation?: ValidationEvidence[] }> {
  const raw = JSON.parse(await readFile(path.resolve(file), "utf8")) as CompletionEvidenceFile;
  return {
    ...raw,
    validation: raw.validation?.map((entry) => {
      const skipped = Boolean(entry.skipped);
      const exitStatus = skipped ? null : entry.exitStatus ?? 0;
      return {
        phaseId: entry.phaseId,
        command: entry.command,
        exitStatus,
        result: entry.result ?? (skipped ? "Validation skipped." : "Validation command recorded."),
        status: skipped ? "skipped" : exitStatus === 0 ? "passed" : "failed",
        skipped,
        skippedReason: entry.skippedReason,
        timestamp: entry.timestamp ?? new Date().toISOString()
      };
    })
  };
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function splitCsv(value: string | undefined): string[] {
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

function uniqueCli(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function initConfig(root: string) {
  return ensureRepositoryConfig(root);
}

async function ensureRepositoryConfig(root: string) {
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
await program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`LeanRigor error: ${message}`);
  process.exitCode = 1;
});
