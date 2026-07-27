import type { LeanRigorConfig } from "../../config/schema.js";
import type { PlanningProvider, PlanningProviderInput, PlanningProviderResult, PlanningRepairRequest } from "../../core/planning-runner.js";
import type { CommandRunner } from "./triage-provider.js";
import { defaultCommandRunner, runClaudeWithTierFallback } from "./triage-provider.js";

export class ClaudeCliPlanningProvider implements PlanningProvider {
  name = "claude-cli";

  constructor(private readonly runCommand: CommandRunner = defaultCommandRunner) {}

  async plan(input: PlanningProviderInput): Promise<PlanningProviderResult> {
    const tier = planningTier(input);
    const prompt = buildPlanningPrompt(input);
    const baseArgs = ["-p", prompt, "--output-format", "json", "--max-turns", "7", "--disallowedTools", "Edit", "Write", "Bash", "PullRequest", "Git", "GitHub", "GitLab", "Jira", "Slack", "Email"];
    const attempted = await runClaudeWithTierFallback({
      runCommand: this.runCommand,
      root: input.root,
      baseArgs,
      preferredTier: tier,
      config: input.config,
      stage: "planning"
    });

    return { raw: parseCommandOutput(attempted.result), provider: this.name, model: attempted.model, tier: attempted.tier, warnings: attempted.warnings };
  }

  async repair(input: PlanningProviderInput, request: PlanningRepairRequest): Promise<PlanningProviderResult> {
    const prompt = buildPlanningRepairPrompt(input, request);
    const args = ["-p", prompt, "--output-format", "json", "--max-turns", "4", "--disallowedTools", "Edit", "Write", "Bash", "PullRequest", "Git", "GitHub", "GitLab", "Jira", "Slack", "Email"];
    if (request.model) args.push("--model", request.model);
    const result = await this.runCommand("claude", args, input.root);
    if (result.exitCode !== 0) {
      const reason = compactFailure(result.stderr.trim() || `Claude CLI exited with ${result.exitCode}.`);
      throw new Error(`Claude planning repair failed for ${request.model ? `model '${request.model}'` : "inherited Claude default"}: ${reason}`);
    }
    return { raw: parseCommandOutput(result), provider: this.name, model: request.model, tier: request.tier, warnings: [] };
  }
}

function parseCommandOutput(result: { stdout: string }): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return result.stdout;
  }
}

function planningTier(input: PlanningProviderInput): LeanRigorConfig["routing"]["triage"] {
  const mode = input.triage.workflow.finalMode;
  const config = input.config;
  if (mode === "rigorous") return config.routing.rigorousPlanning;
  if (mode === "standard") return config.routing.standardPlanning;
  return config.routing.standardPlanning;
}

function buildPlanningPrompt(input: PlanningProviderInput): string {
  return [
    "You are the bounded sequential planner for LeanRigor.",
    "You may inspect the repository with Read/Glob/Grep to identify concrete files, existing schemas, tests, and integration points. Keep inspection minimal.",
    "Return only one JSON object as your final response; no prose or markdown.",
    "Produce a LeanRigor ExecutionPlan using this compact schema:",
    JSON.stringify({
      version: 1,
      summary: "string",
      principles: ["string"],
      phases: [{
        id: "phase-1",
        objective: "specific outcome",
        rationale: "why this phase is separately reviewable",
        dependencies: [],
        expectedReadAreas: ["src/example.ts"],
        expectedWriteAreas: ["src/example.ts"],
        expectedFilesOrAreas: ["src/example.ts"],
        acceptanceCriteria: ["specific evidence obligation"],
        validationCommands: ["npm test"],
        riskLevel: "low|medium|high",
        modelTier: "small|medium|large|inherit"
      }],
      revisionRequests: input.revisionRequests
    }, null, 2),
    "Rules:",
    "- Prefer concrete repository files or narrow areas over generic areas.",
    "- Keep phases sequential and independently reviewable.",
    "- Do not include runtime fields such as status, completion, workspace, filesChanged, commandsRun, validationResults, or repairAttempts.",
    "- Preserve revisionRequests exactly.",
    "- Use the deterministic baseline only as a safety floor; improve specificity when repository evidence supports it.",
    "",
    "Enforced quality rules:",
    "- One primary objective means one reviewable outcome in one phase. Supporting actions may be mentioned only when they are necessary evidence for that same outcome.",
    "- Good objective: 'Persist phase-specific test obligations in workflow state.'",
    "- Good objective: 'Require completion evidence to satisfy mandatory obligations.'",
    "- Bad objective: 'Implement backend, frontend, tests, docs, and migration changes.'",
    "- Bad objective: 'Do everything needed for issue 12.'",
    "- A single architectural boundary is determined from expectedWriteAreas, not from words in the objective. Keep each phase within one production owner such as src/core, src/config, src/cli, or one adapter unless dependencies make the boundary explicit.",
    "- Migration, security, schema, compatibility, failure, concurrency, recovery, contract, and regression may be obligation categories. These words do not by themselves mean a phase mixes boundaries.",
    "- Every phase must include specific acceptance criteria, at least one validation command or check expectation, and bounded expected write areas.",
    "- Preserve final approved effective constraints exactly. Do not reintroduce removed assumptions or scope the user rejected.",
    "- If an effective constraint says backward compatibility is not required, do not describe any phase as backward-compatible or compatibility-preserving.",
    "User request:",
    input.request,
    "Triage output:",
    JSON.stringify(input.triage, null, 2),
    "Final approved effective constraints:",
    JSON.stringify(input.effectiveConstraints ?? input.triage.constraints.mustNot, null, 2),
    "Constraint change audit:",
    JSON.stringify(input.constraintChanges ?? [], null, 2),
    "Deterministic baseline plan:",
    JSON.stringify(input.deterministicPlan, null, 2)
  ].join("\n\n");
}

function buildPlanningRepairPrompt(input: PlanningProviderInput, request: PlanningRepairRequest): string {
  return [
    "You are repairing a LeanRigor ExecutionPlan returned by the same planning model.",
    "Return only one JSON object; no prose or markdown.",
    "Repair only the invalid fields named in diagnostics.",
    "Preserve all valid fields exactly, including phase IDs, dependencies, expectedReadAreas, expectedWriteAreas, expectedFilesOrAreas, acceptanceCriteria, validationCommands, riskLevel, modelTier, and revisionRequests.",
    "Do not restart planning. Do not add new phases unless a diagnostic explicitly requires it.",
    "Quality definitions:",
    "- One primary objective means one reviewable outcome in one phase; supporting evidence can remain in acceptanceCriteria or validationCommands.",
    "- Single architectural boundary is determined primarily by expectedWriteAreas and component ownership, not by words such as migration, security, schema, compatibility, failure, concurrency, recovery, contract, or regression.",
    "Original request:",
    input.request,
    "Triage constraints and context:",
    JSON.stringify(input.triage, null, 2),
    "Final approved effective constraints:",
    JSON.stringify(input.effectiveConstraints ?? input.triage.constraints.mustNot, null, 2),
    "Diagnostics to repair:",
    JSON.stringify(request.diagnostics, null, 2),
    "Invalid plan:",
    JSON.stringify(request.plan, null, 2)
  ].join("\n\n");
}

function compactFailure(reason: string): string {
  const compact = reason.replace(/\s+/g, " ").trim();
  if (/max[-\s]?turns|turn limit|maximum turns|reached.*turn/i.test(compact)) return `max_turns_reached: ${compact.slice(0, 450)}`;
  return compact.slice(0, 500);
}
