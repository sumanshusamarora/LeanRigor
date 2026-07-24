#!/usr/bin/env node
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/load.js";
import { saveWorkflow, loadWorkflow } from "../core/workflow.js";
import { ClaudeAdapter } from "../adapters/claude/adapter.js";
import { ClaudeCliTriageProvider } from "../adapters/claude/triage-provider.js";
import { runTriage } from "../core/triage-runner.js";
import { leanRigorConfigSchema } from "../config/schema.js";
import type { UninstallReport } from "../adapters/types.js";
import { resolveEffectiveConfig, formatEffectiveConfig } from "../config/resolver.js";
import { claudeDefaultsBlurb } from "../config/model-display.js";
import { buildInitReport } from "../config/init-report.js";
import { renderInitReport } from "../config/report-renderer.js";
import { ensureRepositoryConfig, writeConfig } from "../config/bootstrap.js";
import { ensureBootstrapped, type EnsureBootstrappedResult } from "../core/bootstrap.js";
import { atomicWriteJson } from "../config/atomic-write.js";
import { ConfigScope, scopePath, REPO_POLICY_FORBIDDEN_KEYS } from "../config/config-scope.js";
import { loadUserConfig, loadRepoPolicy, loadLocalConfig } from "../config/load.js";
import { userConfigSchema } from "../config/schemas/user.js";
import { repoPolicyConfigSchema } from "../config/schemas/repo-policy.js";
import {
  activeWorkflowSelection,
  currentPhaseObject,
  phaseRepairBudget,
  resolveSingleActiveWorkflow,
  workflowNextSummary,
  type ActiveWorkflowSelection,
  type WorkflowNextSummary
} from "../core/ux.js";
import {
  answerClarification,
  approveApproach,
  approvePlan,
  cancelFlow,
  completeFlow,
  completePhase,
  getCommitPlan,
  heartbeatPhase,
  gitPreflight,
  integratePhase,
  integrationStatus,
  leasePhase,
  listFlows,
  loadLatestFlow,
  nextActions,
  repairPhase,
  recordReview,
  recordValidation,
  recoverLeases,
  rejectApproach,
  releasePhase,
  resumeFlow,
  revisePlan,
  readyPhases,
  startFlow,
  startPhase,
  validateIntegration,
  workspaceCleanup,
  workspaceCreatePhase,
  workspaceInit,
  workspaceRecover,
  workspaceStatus,
  workflowEvents
} from "../core/flow.js";
import { RevisionConflictError } from "../core/workflow-store.js";
import type { CriterionCompletionEvidence, SequentialWorkflowState, ValidationEvidence, WorkflowMode } from "../core/types.js";
import { ClaudeCliExecutionProvider } from "../core/execution/claude-provider.js";
import { ExecutionCoordinator } from "../core/execution/coordinator.js";
import type { ExecutionProvider } from "../core/execution/provider.js";
import { ScriptedExecutionProvider, type ScriptedPhase } from "../core/execution/scripted-provider.js";
import type { CoordinatorResult } from "../core/execution/types.js";

const program = new Command();
program.name("leanrigor").description("Adaptive rigor and model routing for AI coding agents").version("0.3.1-draft");

program.command("setup")
  .alias("init")
  .description("Create repository configuration and Claude Code adapter files")
  .option("--root <path>", "repository root", process.cwd())
  .option("--adapter <adapter>", "harness adapter: claude", "claude")
  .option("--force-owned-files", "replace LeanRigor-owned files that have local changes")
  .action(async ({ root, adapter, forceOwnedFiles }) => {
    if (adapter !== "claude") throw new Error(`Unsupported adapter: ${adapter}. Only 'claude' is currently supported.`);
    const result = await ensureBootstrapped(root, { force: forceOwnedFiles as boolean });
    console.log(`LeanRigor configured.`);
    console.log("Configuration files:");
    console.log(`  User config:          ~/.config/leanrigor/config.json`);
    console.log(`  Repository policy:    leanrigor.config.json (committed)`);
    console.log(`  Local config:         .leanrigor/config.json (private, never committed)`);
    console.log(`  ${claudeDefaultsBlurb()}`);
    printBootstrapReport(result);
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

// ---------------------------------------------------------------------------
// Configuration management
// ---------------------------------------------------------------------------

const configCmd = program.command("config").description("Inspect and update LeanRigor configuration");

configCmd.command("show")
  .description("Display the effective configuration with provenance")
  .option("--root <path>", "repository root", process.cwd())
  .option("--json", "print structured effective config with provenance")
  .action(async ({ root, json }) => {
    const effective = await resolveEffectiveConfig(root);
    if (json) {
      const provenances: Record<string, unknown> = {};
      for (const [key, entry] of effective.provenance) {
        provenances[key] = {
          value: entry.value,
          source: entry.source,
          constrained: entry.constrained,
          ...(entry.adapterResolution !== undefined && { adapterResolution: entry.adapterResolution }),
          ...(entry.adapterAlias !== undefined && { adapterAlias: entry.adapterAlias }),
          ...(entry.isClaudeAlias !== undefined && { isClaudeAlias: entry.isClaudeAlias }),
        };
      }
      console.log(JSON.stringify({
        values: effective.values,
        provenance: provenances,
        constraints: effective.constraints,
        warnings: effective.warnings,
        sourcesFound: effective.sourcesFound
      }, null, 2));
    } else {
      console.log(formatEffectiveConfig(effective));
    }
  });

configCmd.command("get")
  .description("Read a single configuration value with provenance")
  .argument("<path>", "dotted path, e.g. execution.maxParallelPhases")
  .option("--root <path>", "repository root", process.cwd())
  .action(async (configPath, { root }) => {
    const effective = await resolveEffectiveConfig(root);
    const entry = effective.provenance.get(configPath);
    if (!entry) {
      // Try to find the value in the config directly
      const value = getNestedValue(effective.values as unknown as Record<string, unknown>, configPath);
      if (value === undefined) {
        console.log(`No configuration found at path: ${configPath}`);
        return;
      }
      console.log(`${configPath}: ${JSON.stringify(value)}`);
      console.log(`  Source: built-in default`);
      return;
    }
    console.log(`${configPath}: ${JSON.stringify(entry.value)}`);
    console.log(`  Source: ${entry.source}`);
    if (entry.adapterResolution) console.log(`  Adapter resolution: ${entry.adapterResolution}`);
    if (entry.adapterAlias) console.log(`  Adapter alias: ${entry.adapterAlias}`);
    if (entry.isClaudeAlias !== undefined) console.log(`  Is Claude alias: ${entry.isClaudeAlias}`);
    if (entry.constrained) {
      console.log(`  Requested: ${JSON.stringify(entry.requestedValue)}`);
      console.log(`  Constrained by repository policy`);
    }
    for (const warning of entry.warnings) console.log(`  ⚠ ${warning}`);
  });

configCmd.command("set")
  .description("Set a configuration value in the specified scope")
  .argument("<path>", "dotted path, e.g. execution.maxParallelPhases")
  .argument("<value>", "value to set (JSON-parsed; use quotes: '\"string\"' or 42)")
  .requiredOption("--scope <scope>", "target scope: user, repo, or local")
  .option("--root <path>", "repository root", process.cwd())
  .action(async (configPath, rawValue, options) => {
    const { scope: scopeName, root } = options;

    if (!["user", "repo", "local"].includes(scopeName)) {
      throw new Error(`Invalid scope: ${scopeName}. Must be one of: user, repo, local`);
    }

    const scope = scopeName === "user" ? ConfigScope.User
      : scopeName === "repo" ? ConfigScope.RepoPolicy
      : ConfigScope.Local;

    // Prevent forbidden keys in repo policy
    if (scope === ConfigScope.RepoPolicy && REPO_POLICY_FORBIDDEN_KEYS.includes(configPath)) {
      throw new Error(`Setting '${configPath}' is not allowed in committed repository policy. Use --scope local for this value.`);
    }

    const value = parseJsonValue(rawValue);
    const filePath = scopePath(scope, root);

    // Load existing config for this scope
    let config: Record<string, unknown>;
    if (scope === ConfigScope.User) {
      config = (await loadUserConfig()) as unknown as Record<string, unknown> ?? { version: 1 };
    } else if (scope === ConfigScope.RepoPolicy) {
      config = (await loadRepoPolicy(root)) as unknown as Record<string, unknown> ?? { version: 1 };
    } else {
      config = (await loadLocalConfig(root)) as unknown as Record<string, unknown> ?? {};
    }

    // Set nested value
    setNestedValue(config, configPath, value);

    // Validate against the appropriate schema
    if (scope === ConfigScope.User) {
      userConfigSchema.parse(config);
    } else if (scope === ConfigScope.RepoPolicy) {
      repoPolicyConfigSchema.parse(config);
    } else {
      leanRigorConfigSchema.parse(config);
    }

    // Write atomically
    await atomicWriteJson(filePath, config);
    console.log(`Set ${configPath} = ${JSON.stringify(value)} (scope: ${scopeName})`);
    console.log(`Written to: ${filePath}`);
  });

configCmd.command("unset")
  .description("Remove a configuration value from the specified scope")
  .argument("<path>", "dotted path, e.g. models.tiers.small.claude")
  .requiredOption("--scope <scope>", "target scope: user, repo, or local")
  .option("--root <path>", "repository root", process.cwd())
  .action(async (configPath, options) => {
    const { scope: scopeName, root } = options;

    if (!["user", "repo", "local"].includes(scopeName)) {
      throw new Error(`Invalid scope: ${scopeName}. Must be one of: user, repo, local`);
    }

    const scope = scopeName === "user" ? ConfigScope.User
      : scopeName === "repo" ? ConfigScope.RepoPolicy
      : ConfigScope.Local;

    const filePath = scopePath(scope, root);

    // Load existing config for this scope
    let config: Record<string, unknown> | null;
    if (scope === ConfigScope.User) {
      config = await loadUserConfig() as unknown as Record<string, unknown> | null;
    } else if (scope === ConfigScope.RepoPolicy) {
      config = await loadRepoPolicy(root) as unknown as Record<string, unknown> | null;
    } else {
      config = await loadLocalConfig(root) as unknown as Record<string, unknown> | null;
    }

    if (!config) {
      console.log(`No configuration file found at: ${filePath}`);
      return;
    }

    // Remove nested value
    unsetNestedValue(config, configPath);

    // Write atomically
    await atomicWriteJson(filePath, config);
    console.log(`Removed ${configPath} (scope: ${scopeName})`);
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
    printHumanStatus(active);
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
    // Also show config management hints
    console.log("");
    console.log("To see effective config with provenance:");
    console.log("  leanrigor config show");
    console.log("  leanrigor config show --json");
  });

program.command("init-report")
  .description("Produce a deterministic structured configuration report")
  .option("--root <path>", "repository root", process.cwd())
  .option("--json", "print structured JSON report")
  .option("--no-bootstrap", "skip automatic bootstrapping before generating report")
  .action(async ({ root, json, bootstrap: doBootstrap }) => {
    // Bootstrap missing assets before generating the report (unless --no-bootstrap)
    let bootstrapResult: EnsureBootstrappedResult | null = null;
    if (doBootstrap !== false) {
      bootstrapResult = await ensureBootstrapped(root);
    }
    const report = await buildInitReport(root, bootstrapResult);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderInitReport(report));
    }
  });

const flow = program.command("flow").description("Run the persisted sequential LeanRigor workflow");

flow.command("start")
  .argument("<request>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--provider <provider>", "triage provider: auto, claude, or deterministic", "auto")
  .action(async (request, options) => {
    // Bootstrap project environment before starting the workflow
    const { config } = await ensureBootstrapped(options.root);
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
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "lock owner ID", "cli")
  .action(async (workflowId, answer, options) => {
    const config = await ensureRepositoryConfig(options.root);
    printFlowState(await answerClarification({
      root: options.root,
      workflowId,
      answer,
      config,
      provider: triageProvider(options.provider),
      mutation: mutationOptions(options)
    }));
  });

flow.command("approve-approach")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "lock owner ID", "cli")
  .action(async (workflowId, options) => {
    printFlowState(await approveApproach(options.root, workflowId, await ensureRepositoryConfig(options.root), mutationOptions(options)));
  });

flow.command("reject-approach")
  .argument("<workflow-id>")
  .requiredOption("--reason <reason>", "reason for rejection")
  .option("--root <path>", "repository root", process.cwd())
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "lock owner ID", "cli")
  .action(async (workflowId, options) => {
    printFlowState(await rejectApproach(options.root, workflowId, options.reason, mutationOptions(options)));
  });

flow.command("approve-plan")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "lock owner ID", "cli")
  .action(async (workflowId, options) => {
    printFlowState(await approvePlan(options.root, workflowId, mutationOptions(options)));
  });

flow.command("revise-plan")
  .argument("<workflow-id>")
  .argument("<feedback>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "lock owner ID", "cli")
  .action(async (workflowId, feedback, options) => {
    printFlowState(await revisePlan(options.root, workflowId, feedback, await ensureRepositoryConfig(options.root), mutationOptions(options)));
  });

flow.command("phase-start")
  .argument("<workflow-id>")
  .argument("[phase-id]")
  .option("--root <path>", "repository root", process.cwd())
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "phase lease owner ID", "cli")
  .action(async (workflowId, phaseId, options) => {
    printFlowState(await startPhase(options.root, workflowId, phaseId, { ...mutationOptions(options), config: await ensureRepositoryConfig(options.root) }));
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
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "phase lease owner ID", "cli")
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
      modelDecision: evidence.modelDecision,
      mutation: mutationOptions(options)
    }));
  });

flow.command("ready")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--json", "print structured ready phase schedule")
  .action(async (workflowId, options) => {
    const schedule = readyPhases(await resumeFlow(options.root, workflowId), await ensureRepositoryConfig(options.root));
    if (options.json) console.log(JSON.stringify(schedule, null, 2));
    else console.log(`${schedule.dispatchableCount}/${schedule.eligibleCount} phase(s) dispatchable; max parallel phases ${schedule.maxParallelPhases}.`);
  });

flow.command("execute-next")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--provider <provider>", "execution provider: scripted or claude", "scripted")
  .option("--script-file <path>", "scripted provider JSON file")
  .option("--json", "print structured coordinator result")
  .action(async (workflowId, options) => {
    const coordinator = await executionCoordinator(options.root, workflowId, options.provider, options.scriptFile);
    printCoordinatorResult(await coordinator.runNext(), Boolean(options.json));
  });

flow.command("execute-ready")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--provider <provider>", "execution provider: scripted or claude", "scripted")
  .option("--script-file <path>", "scripted provider JSON file")
  .option("--json", "print structured coordinator result")
  .action(async (workflowId, options) => {
    const coordinator = await executionCoordinator(options.root, workflowId, options.provider, options.scriptFile);
    printCoordinatorResult(await coordinator.dispatchReady(), Boolean(options.json));
  });

flow.command("execution-status")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--provider <provider>", "execution provider: scripted or claude", "scripted")
  .option("--script-file <path>", "scripted provider JSON file")
  .option("--json", "print structured coordinator result")
  .action(async (workflowId, options) => {
    const coordinator = await executionCoordinator(options.root, workflowId, options.provider, options.scriptFile);
    printCoordinatorResult(coordinator.executionStatus(await resumeFlow(options.root, workflowId)), Boolean(options.json));
  });

flow.command("execution-poll")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--provider <provider>", "execution provider: scripted or claude", "scripted")
  .option("--script-file <path>", "scripted provider JSON file")
  .option("--json", "print structured coordinator result")
  .action(async (workflowId, options) => {
    const coordinator = await executionCoordinator(options.root, workflowId, options.provider, options.scriptFile);
    printCoordinatorResult(await coordinator.poll(), Boolean(options.json));
  });

flow.command("execution-cancel")
  .argument("<workflow-id>")
  .argument("<phase-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--provider <provider>", "execution provider: scripted or claude", "scripted")
  .option("--script-file <path>", "scripted provider JSON file")
  .option("--reason <reason>", "cancellation reason")
  .option("--json", "print structured coordinator result")
  .action(async (workflowId, phaseId, options) => {
    const coordinator = await executionCoordinator(options.root, workflowId, options.provider, options.scriptFile);
    printCoordinatorResult(await coordinator.cancelPhase(phaseId, options.reason), Boolean(options.json));
  });

flow.command("execution-recover")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--provider <provider>", "execution provider: scripted or claude", "scripted")
  .option("--script-file <path>", "scripted provider JSON file")
  .option("--json", "print structured coordinator result")
  .action(async (workflowId, options) => {
    const coordinator = await executionCoordinator(options.root, workflowId, options.provider, options.scriptFile);
    printCoordinatorResult(await coordinator.recover(), Boolean(options.json));
  });

flow.command("lease-phase")
  .argument("<workflow-id>")
  .argument("<phase-id>")
  .requiredOption("--owner <id>", "phase lease owner ID")
  .option("--root <path>", "repository root", process.cwd())
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--json", "print workflow JSON summary")
  .action(async (workflowId, phaseId, options) => {
    const state = await leasePhase({ root: options.root, workflowId, phaseId, ownerId: options.owner, config: await ensureRepositoryConfig(options.root), mutation: mutationOptions(options) });
    if (options.json) printFlowState(state);
    else console.log(`Phase ${phaseId} leased by ${options.owner}.`);
  });

flow.command("heartbeat-phase")
  .argument("<workflow-id>")
  .argument("<phase-id>")
  .requiredOption("--owner <id>", "phase lease owner ID")
  .option("--root <path>", "repository root", process.cwd())
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--json", "print workflow JSON summary")
  .action(async (workflowId, phaseId, options) => {
    const state = await heartbeatPhase({ root: options.root, workflowId, phaseId, ownerId: options.owner, config: await ensureRepositoryConfig(options.root), mutation: mutationOptions(options) });
    if (options.json) printFlowState(state);
    else console.log(`Phase ${phaseId} lease refreshed by ${options.owner}.`);
  });

flow.command("release-phase")
  .argument("<workflow-id>")
  .argument("<phase-id>")
  .requiredOption("--owner <id>", "phase lease owner ID")
  .option("--root <path>", "repository root", process.cwd())
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--json", "print workflow JSON summary")
  .action(async (workflowId, phaseId, options) => {
    const state = await releasePhase({ root: options.root, workflowId, phaseId, ownerId: options.owner, mutation: mutationOptions(options) });
    if (options.json) printFlowState(state);
    else console.log(`Phase ${phaseId} lease released by ${options.owner}.`);
  });

flow.command("recover-leases")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "lock owner ID", "cli")
  .option("--json", "print workflow JSON summary")
  .action(async (workflowId, options) => {
    const state = await recoverLeases({ root: options.root, workflowId, mutation: mutationOptions(options) });
    if (options.json) printFlowState(state);
    else console.log(`Recovered expired leases for ${workflowId}.`);
  });

flow.command("git-preflight")
  .option("--root <path>", "repository root", process.cwd())
  .option("--json", "print structured preflight result")
  .action(async (options) => {
    const result = await gitPreflight(options.root, await ensureRepositoryConfig(options.root));
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.ok ? "Git workspace preflight passed." : `Git workspace preflight failed: ${result.code}`);
  });

flow.command("workspace-init")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "lock owner ID", "cli")
  .option("--json", "print workflow JSON summary")
  .action(async (workflowId, options) => {
    const state = await workspaceInit({ root: options.root, workflowId, config: await ensureRepositoryConfig(options.root), mutation: mutationOptions(options) });
    if (options.json) printFlowState(state);
    else console.log(`Integration workspace ready: ${state.git?.integration.path}`);
  });

flow.command("workspace-create-phase")
  .argument("<workflow-id>")
  .argument("<phase-id>")
  .requiredOption("--owner <id>", "phase lease owner ID")
  .option("--root <path>", "repository root", process.cwd())
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--json", "print workflow JSON summary")
  .action(async (workflowId, phaseId, options) => {
    const state = await workspaceCreatePhase({
      root: options.root,
      workflowId,
      phaseId,
      ownerId: options.owner,
      config: await ensureRepositoryConfig(options.root),
      mutation: mutationOptions(options)
    });
    if (options.json) printFlowState(state);
    else console.log(`Phase ${phaseId} workspace ready: ${state.git?.phaseWorkspaces[phaseId]?.path}`);
  });

flow.command("workspace-status")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--json", "print structured workspace status")
  .action(async (workflowId, options) => {
    const status = await workspaceStatus(options.root, workflowId, await ensureRepositoryConfig(options.root));
    if (options.json) console.log(JSON.stringify(status, null, 2));
    else console.log(status.git ? `Integration workspace: ${status.git.integration.status}` : "No Git workspace initialized.");
  });

flow.command("integrate-phase")
  .argument("<workflow-id>")
  .argument("<phase-id>")
  .requiredOption("--owner <id>", "integration owner ID")
  .option("--root <path>", "repository root", process.cwd())
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--json", "print structured integration result")
  .action(async (workflowId, phaseId, options) => {
    const result = await integratePhase({ root: options.root, workflowId, phaseId, ownerId: options.owner, mutation: mutationOptions(options) });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (result.ok) console.log(result.code === "already_integrated" ? `Phase ${phaseId} was already integrated.` : `Phase ${phaseId} integrated.`);
    else console.log(`Phase ${phaseId} integration failed: ${result.code}`);
  });

flow.command("integration-status")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--json", "print structured integration status")
  .action(async (workflowId, options) => {
    const status = integrationStatus(await resumeFlow(options.root, workflowId));
    if (options.json) console.log(JSON.stringify(status, null, 2));
    else console.log(status.finalReviewEligible ? "Integration is ready for final review." : `${status.pendingPhaseIds.length} pending, ${status.conflictedPhaseIds.length} conflicted.`);
  });

flow.command("validate-integration")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "lock owner ID", "cli")
  .option("--json", "print workflow JSON summary")
  .action(async (workflowId, options) => {
    const state = await validateIntegration({ root: options.root, workflowId, mutation: mutationOptions(options) });
    if (options.json) printFlowState(state);
    else console.log(`Combined integration validation: ${state.git?.integrationValidation?.status}`);
  });

flow.command("workspace-cleanup")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--mode <mode>", "safe, force-owned, or archive", "safe")
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "lock owner ID", "cli")
  .option("--json", "print structured cleanup report")
  .action(async (workflowId, options) => {
    const report = await workspaceCleanup({ root: options.root, workflowId, mode: options.mode, mutation: mutationOptions(options) });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else console.log(`Workspace cleanup removed ${report.removedWorktrees.length} worktree(s); retained ${report.retainedWorktrees.length}.`);
  });

flow.command("workspace-recover")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "lock owner ID", "cli")
  .option("--json", "print structured recovery report")
  .action(async (workflowId, options) => {
    const report = await workspaceRecover({ root: options.root, workflowId, mutation: mutationOptions(options) });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else console.log(report.needsReview.length ? `Workspace recovery needs review: ${report.needsReview.join(", ")}` : "Workspace recovery completed.");
  });

flow.command("events")
  .argument("<workflow-id>")
  .option("--root <path>", "repository root", process.cwd())
  .option("--json", "print structured event history")
  .action(async (workflowId, options) => {
    const events = workflowEvents(await resumeFlow(options.root, workflowId));
    if (options.json) console.log(JSON.stringify(events, null, 2));
    else for (const event of events) console.log(`${event.timestamp} ${event.type}: ${event.summary}`);
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
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "phase lease owner ID", "cli")
  .action(async (workflowId, phaseId, options) => {
    printFlowState(await repairPhase({
      root: options.root,
      workflowId,
      phaseId,
      reason: options.reason,
      requestedScope: options.scope,
      config: await ensureRepositoryConfig(options.root),
      mutation: mutationOptions(options)
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
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "lock owner ID", "cli")
  .action(async (workflowId, options) => {
    printFlowState(await recordValidation({
      root: options.root,
      workflowId,
      phaseId: options.phase,
      command: options.command,
      exitStatus: options.skipped ? null : Number.parseInt(options.exit, 10),
      result: options.result || (options.skipped ? "Validation skipped." : "Validation command recorded."),
      skipped: Boolean(options.skipped),
      skippedReason: options.reason,
      mutation: mutationOptions(options)
    }));
  });

flow.command("record-review")
  .argument("<workflow-id>")
  .requiredOption("--status <status>", "passed, needs_repair, needs_replan, or blocked")
  .requiredOption("--summary <summary>", "concise review summary")
  .option("--root <path>", "repository root", process.cwd())
  .option("--finding <finding>", "review finding", collect, [])
  .option("--repair-scope <scope>", "smallest repair scope when repair is needed")
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "lock owner ID", "cli")
  .action(async (workflowId, options) => {
    const config = await ensureRepositoryConfig(options.root);
    printFlowState(await recordReview({
      root: options.root,
      workflowId,
      status: options.status,
      summary: options.summary,
      findings: options.finding,
      repairScope: options.repairScope,
      config,
      mutation: mutationOptions(options)
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
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "lock owner ID", "cli")
  .action(async (workflowId, options) => {
    printFlowState(await completeFlow(options.root, workflowId, mutationOptions(options)));
  });

flow.command("status")
  .argument("[workflow-id]")
  .option("--root <path>", "repository root", process.cwd())
  .option("--json", "print raw workflow JSON for automation")
  .action(async (workflowId, { root, json }) => {
    const state = workflowId ? await resumeFlow(root, workflowId) : await loadLatestFlow(root);
    if (!state) {
      console.log("No workflows found.");
      return;
    }
    if (json) printFlowState(state);
    else printHumanStatus(state);
  });

flow.command("active")
  .option("--root <path>", "repository root", process.cwd())
  .option("--json", "print structured active-workflow selection data")
  .action(async ({ root, json }) => {
    const selection = await activeWorkflowSelection(root);
    if (json) console.log(JSON.stringify(selection, null, 2));
    else printActiveSelection(selection);
  });

flow.command("next")
  .argument("[workflow-id]")
  .option("--root <path>", "repository root", process.cwd())
  .option("--json", "print structured next-step data")
  .action(async (workflowId, { root, json }) => {
    const state = workflowId ? await resumeFlow(root, workflowId) : await resolveSingleActiveWorkflow(root);
    const summary = workflowNextSummary(state);
    if (json) console.log(JSON.stringify(summary, null, 2));
    else printNextSummary(summary);
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
  .option("--expected-revision <revision>", "expected workflow revision")
  .option("--owner <id>", "lock owner ID", "cli")
  .action(async (workflowId, options) => {
    printFlowState(await cancelFlow(options.root, workflowId, mutationOptions(options)));
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printBootstrapReport(result: EnsureBootstrappedResult): void {
  if (!result.report) return;
  const report = result.report;
  if (report.installed.length > 0) {
    console.log("\nInstalled:");
    for (const f of report.installed) console.log(`  ${f}`);
  }
  if (report.adopted.length > 0) {
    console.log("\nAdopted (content matched, ownership token added):");
    for (const f of report.adopted) console.log(`  ${f}`);
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
  if (report.settingsModified) {
    console.log(`\nShared settings: LeanRigor hook entries ${report.settingsState === "shared_merged" ? "merged" : report.settingsState}.`);
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
    execution: Object.values(state.execution.records).map((record) => ({
      phaseId: record.phaseId,
      provider: record.providerId,
      status: record.status,
      workspacePath: record.workspacePath,
      heartbeatAt: record.heartbeatAt,
      completedAt: record.completedAt,
      resultSummary: record.resultSummary
    })),
    currentPhase: currentPhaseStatus(state),
    nextValidCommands: nextActions(state),
    updatedAt: state.updatedAt
  }, null, 2));
}

function printHumanStatus(state: SequentialWorkflowState): void {
  const next = workflowNextSummary(state);
  const phase = currentPhaseObject(state);
  const lines = [
    `LeanRigor - ${next.label}`,
    "",
    `Workflow: ${state.id}`,
    `Request: ${state.request}`,
    `Mode: ${labelMode(state.mode)}`,
    `State: ${state.state}`,
    phase ? `Current phase: ${phase.id} - ${phase.objective}` : undefined,
    phase ? `Completion gate: ${phase.completion?.decision ?? (["leased", "running", "completion_pending"].includes(phase.status) ? "pending" : "not started")}` : undefined,
    phase ? `Repair attempts: ${phase.repairAttempts.length}/${phaseRepairBudget(state)}` : undefined,
    state.blockers.length > 0 ? `Blockers: ${state.blockers.join("; ")}` : undefined,
    next.pendingDecision ? `Pending decision: ${next.pendingDecision}` : undefined,
    `Next action: ${next.pendingAction}`
  ].filter((line): line is string => line !== undefined);
  console.log(lines.join("\n"));
}

async function executionCoordinator(root: string, workflowId: string, providerName: string, scriptFile?: string): Promise<ExecutionCoordinator> {
  const config = await ensureRepositoryConfig(root);
  return new ExecutionCoordinator({
    root,
    workflowId,
    config,
    provider: await executionProvider(providerName, scriptFile)
  });
}

async function executionProvider(providerName: string, scriptFile?: string): Promise<ExecutionProvider> {
  if (providerName === "scripted") {
    const scripts = scriptFile ? JSON.parse(await readFile(path.resolve(scriptFile), "utf8")) as Record<string, ScriptedPhase> : {};
    return new ScriptedExecutionProvider(scripts);
  }
  if (providerName === "claude" || providerName === "claude-cli") return new ClaudeCliExecutionProvider();
  throw new Error(`Unsupported execution provider: ${providerName}`);
}

function printCoordinatorResult(result: CoordinatorResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const lines = [
    `Workflow ${result.workflowId} revision ${result.revision}: ${result.state}`,
    result.message,
    result.executionMode ? `Execution mode: ${result.executionMode}` : undefined,
    result.provider ? `Provider: ${result.provider}` : undefined,
    result.runningPhase ? `Running phase: ${result.runningPhase}` : undefined,
    result.lastProviderStatus ? `Last provider status: ${result.lastProviderStatus}` : undefined,
    result.phaseGateStatus ? `Phase gate: ${result.phaseGateStatus}` : undefined,
    result.integrationStatus ? `Integration: ${result.integrationStatus}` : undefined,
    result.combinedValidationStatus ? `Combined validation: ${result.combinedValidationStatus}` : undefined,
    result.pendingUserGate ? `Pending user gate: ${result.pendingUserGate}` : undefined,
    result.dispatched.length > 0 ? `Dispatched: ${result.dispatched.map((item) => `${item.phaseId} (${item.provider})`).join(", ")}` : undefined,
    result.running.length > 0 ? `Running: ${result.running.map((item) => `${item.phaseId} (${item.status})`).join(", ")}` : undefined,
    result.completed.length > 0 ? `Completed evidence: ${result.completed.map((item) => item.phaseId).join(", ")}` : undefined,
    result.blocked.length > 0 ? `Blocked: ${result.blocked.map((item) => `${item.phaseId}: ${item.reason}`).join("; ")}` : undefined,
    `Next action: ${result.nextValidAction ?? result.nextAction}`
  ].filter((line): line is string => Boolean(line));
  console.log(lines.join("\n"));
}

function printActiveSelection(selection: ActiveWorkflowSelection): void {
  console.log(`LeanRigor - Active workflows\n\n${selection.message}`);
  for (const workflow of selection.workflows) {
    console.log(`- ${workflow.id} | ${workflow.state} | ${labelMode(workflow.mode)} | ${workflow.request} | updated ${workflow.updatedAt}`);
  }
}

function printNextSummary(summary: WorkflowNextSummary): void {
  const lines = [
    `LeanRigor - ${summary.label}`,
    "",
    `Workflow: ${summary.workflow.id}`,
    `Request: ${summary.workflow.request}`,
    `Mode: ${labelMode(summary.workflow.mode)}`,
    `State: ${summary.workflow.state}`,
    summary.pendingDecision ? `Pending decision: ${summary.pendingDecision}` : undefined,
    `Next action: ${summary.pendingAction}`
  ].filter((line): line is string => line !== undefined);
  console.log(lines.join("\n"));
}

function labelMode(mode: WorkflowMode): string {
  return mode[0].toUpperCase() + mode.slice(1);
}

function currentPhaseStatus(state: SequentialWorkflowState): unknown {
  const active = state.plan?.phases.find((phase) => phase.status === "running" || phase.status === "leased" || phase.status === "completion_pending")
    ?? state.plan?.phases.find((phase) => phase.status === "ready")
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
    completionGate: completion?.decision ?? (phase.status === "running" || phase.status === "leased" || phase.status === "completion_pending" ? "pending" : "not_started"),
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

function pendingUserAction(state: SequentialWorkflowState): string | null {
  if (state.state === "awaiting_clarification") return "Answer the single blocking clarification question.";
  if (state.state === "awaiting_approach_approval") return "Approve or reject the recommended approach.";
  if (state.state === "awaiting_plan_approval") return "Approve or revise the sequential plan.";
  if (state.state === "awaiting_commit_approval") return "Review the commit proposal; LeanRigor will not commit automatically.";
  if (state.state === "blocked") return "Resolve the blocker or cancel the workflow.";
  return null;
}

function mutationOptions(options: { expectedRevision?: string; owner?: string }) {
  return {
    expectedRevision: options.expectedRevision === undefined ? undefined : Number.parseInt(options.expectedRevision, 10),
    ownerId: options.owner ?? "cli"
  };
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

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Parse a CLI string value into its JSON representation. */
function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Treat as a plain string if not valid JSON
    return raw;
  }
}

/** Get a nested value from an object using a dotted path. */
function getNestedValue(obj: Record<string, unknown>, dottedPath: string): unknown {
  const keys = dottedPath.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Set a nested value on an object using a dotted path. Creates intermediate objects as needed. */
function setNestedValue(obj: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const keys = dottedPath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || current[key] === null || typeof current[key] !== "object" || Array.isArray(current[key])) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

/** Remove a nested value from an object using a dotted path. */
function unsetNestedValue(obj: Record<string, unknown>, dottedPath: string): void {
  const keys = dottedPath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || typeof current[key] !== "object" || Array.isArray(current[key])) {
      return; // Path doesn't exist
    }
    current = current[key] as Record<string, unknown>;
  }
  delete current[keys[keys.length - 1]];
}

function capitalise(value: string): string { return value[0].toUpperCase() + value.slice(1); }
await program.parseAsync().catch((error: unknown) => {
  if (error instanceof RevisionConflictError) {
    console.error(JSON.stringify({
      ok: false,
      code: error.code,
      expectedRevision: error.expectedRevision,
      actualRevision: error.actualRevision
    }, null, 2));
    process.exitCode = 1;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`LeanRigor error: ${message}`);
  process.exitCode = 1;
});
