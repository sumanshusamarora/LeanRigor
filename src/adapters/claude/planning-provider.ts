import type { LeanRigorConfig } from "../../config/schema.js";
import type { PlanningProvider, PlanningProviderInput, PlanningProviderResult } from "../../core/planning-runner.js";
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

    return { raw: parseCommandOutput(attempted.result), provider: this.name, model: attempted.model, warnings: attempted.warnings };
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
    "User request:",
    input.request,
    "Triage output:",
    JSON.stringify(input.triage, null, 2),
    "Deterministic baseline plan:",
    JSON.stringify(input.deterministicPlan, null, 2)
  ].join("\n\n");
}
