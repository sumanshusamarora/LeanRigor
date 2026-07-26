import type { LeanRigorConfig } from "../../config/schema.js";
import { resolveModelTier } from "../../config/models.js";
import type { PlanningProvider, PlanningProviderInput, PlanningProviderResult } from "../../core/planning-runner.js";
import type { CommandRunner } from "./triage-provider.js";
import { defaultCommandRunner } from "./triage-provider.js";

export class ClaudeCliPlanningProvider implements PlanningProvider {
  name = "claude-cli";

  constructor(private readonly runCommand: CommandRunner = defaultCommandRunner) {}

  async plan(input: PlanningProviderInput): Promise<PlanningProviderResult> {
    const model = resolveModelTier(planningTier(input), "claude", input.config).model;
    const prompt = buildPlanningPrompt(input);
    const args = ["-p", prompt, "--output-format", "json", "--max-turns", "7", "--disallowedTools", "Edit", "Write", "Bash", "PullRequest", "Git", "GitHub", "GitLab", "Jira", "Slack", "Email"];
    if (model) args.push("--model", model);

    const result = await this.runCommand("claude", args, input.root);
    if (result.exitCode !== 0) {
      const tier = planningTier(input);
      const resolved = model ?? "inherit";
      throw new Error(
        `Claude Code could not run LeanRigor planning tier '${tier}' ` +
        `(resolved model: '${resolved}'). ${result.stderr.trim() || `Claude CLI exited with ${result.exitCode}.`} ` +
        `Configure it with 'leanrigor models --claude-${tier} <model-or-alias>', or set ` +
        `LEANRIGOR_CLAUDE_MODEL_${tier.toUpperCase()}.`
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      raw = result.stdout;
    }
    return { raw, provider: this.name, model };
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
