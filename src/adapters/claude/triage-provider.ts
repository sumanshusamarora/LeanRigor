import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LeanRigorConfig, ModelTier } from "../../config/schema.js";
import { resolveModelTierFallbacks, type ResolvedModel } from "../../config/models.js";
import { TriageProviderError, type TriageInspectionInput, type TriageProvider, type TriageProviderResult, type TriageRecommendationInput } from "../../core/triage-runner.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<CommandResult>;

export class ClaudeCliTriageProvider implements TriageProvider {
  name = "claude-cli";

  constructor(private readonly runCommand: CommandRunner = defaultCommandRunner) {}

  async recommend(input: TriageRecommendationInput): Promise<TriageProviderResult> {
    return this.runRecommendation(input, undefined);
  }

  async repairRecommendation(input: TriageRecommendationInput, failure: string): Promise<TriageProviderResult> {
    return this.runRecommendation(input, failure);
  }

  async inspect(input: TriageInspectionInput): Promise<TriageProviderResult> {
    const prompt = buildInspectionPrompt(input);
    const baseArgs = [
      "-p", prompt,
      "--output-format", "json",
      "--max-turns", String(input.config.budgets.triageInspectionMaxTurns),
      "--allowedTools", "Read,Grep,Glob",
      "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,TodoWrite,PullRequest,Git,GitHub,GitLab,Jira,Slack,Email,MCP"
    ];
    const attempted = await runClaudeWithTierFallback({
      runCommand: this.runCommand,
      root: input.root,
      baseArgs,
      preferredTier: input.config.routing.repositoryInspection,
      config: input.config,
      stage: "triage inspection"
    });

    return { raw: parseCommandOutput(attempted.result), provider: this.name, model: attempted.model, warnings: attempted.warnings };
  }

  private async runRecommendation(input: TriageRecommendationInput, repairFailure: string | undefined): Promise<TriageProviderResult> {
    const prompt = await buildTriagePrompt(input, repairFailure);
    const baseArgs = [
      "-p", prompt,
      "--bare",
      "--output-format", "json",
      "--max-turns", String(input.config.budgets.triageRecommendationMaxTurns),
      "--disallowedTools", "Read,Glob,Grep,Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,TodoWrite,PullRequest,Git,GitHub,GitLab,Jira,Slack,Email,MCP"
    ];
    const attempted = await runClaudeWithTierFallback({
      runCommand: this.runCommand,
      root: input.root,
      baseArgs,
      preferredTier: input.config.routing.triage,
      config: input.config,
      stage: repairFailure ? "triage recommendation repair" : "triage recommendation"
    });

    return { raw: parseCommandOutput(attempted.result), provider: this.name, model: attempted.model, warnings: attempted.warnings };
  }
}

export async function buildTriagePrompt(input: TriageRecommendationInput, repairFailure?: string): Promise<string> {
  const { root, request, evidence } = input;
  const skill = await readTriageSkill(root);
  return [
    "You are the bounded triage recommendation provider for LeanRigor.",
    "You do not decide the final workflow mode. Deterministic LeanRigor policy has final authority.",
    "Use only the evidence packet below. Verified evidence is authoritative. Unknowns must remain unknown; do not invent repository facts.",
    "Do not request broad repository analysis. Request targeted inspection only through concrete structured questions when the answer can materially change mode or risk classification.",
    "Return only one JSON object matching ModelTriageRecommendation; no prose or markdown.",
    repairFailure ? `Previous malformed output or schema failure: ${repairFailure}` : undefined,
    skill,
    "Output schema summary:",
    JSON.stringify(recommendationSchemaDescription(), null, 2),
    "Deterministic evidence packet:",
    JSON.stringify(evidence, null, 2),
    "User request:",
    request
  ].filter(Boolean).join("\n\n");
}

async function readTriageSkill(root: string): Promise<string> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoots = [
    process.env.LEANRIGOR_CLAUDE_PLUGIN_ROOT,
    process.env.CLAUDE_PLUGIN_ROOT
  ].filter((value): value is string => Boolean(value));
  const candidates = [
    ...pluginRoots.map((pluginRoot) => path.join(pluginRoot, "internal-skills", "triage-task", "SKILL.md")),
    path.join(moduleDir, "internal-skills", "triage-task", "SKILL.md"),
    path.join(moduleDir, "..", "internal-skills", "triage-task", "SKILL.md"),
    path.join(moduleDir, "..", "..", "..", "internal-skills", "triage-task", "SKILL.md"),
    path.join(root, "internal-skills", "triage-task", "SKILL.md")
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // Try the next package-owned asset location.
    }
  }
  return "Return only ModelTriageRecommendation JSON. Do not modify files.";
}

function buildInspectionPrompt(input: TriageInspectionInput): string {
  return [
    "You are a bounded fact-only triage inspection provider for LeanRigor.",
    "Inspect only the allowed paths. Do not decide workflow mode. Do not write files or run shell commands.",
    `Maximum file reads: ${input.inspection.maxReads}. Maximum bytes: ${input.inspection.maxBytes}.`,
    "Return only JSON matching TriageInspectionResult with verified facts, evidence references, and whether the budget was exhausted.",
    "Allowed paths:",
    JSON.stringify(input.inspection.allowedPaths, null, 2),
    "Questions:",
    JSON.stringify(input.inspection.questions, null, 2),
    "Evidence packet:",
    JSON.stringify(input.evidence, null, 2),
    "User request:",
    input.request
  ].join("\n\n");
}

function recommendationSchemaDescription(): unknown {
  return {
    version: 1,
    complexity: "low|medium|high",
    ambiguity: "low|medium|high",
    blastRadius: "low|medium|high",
    risks: {
      architecturalImpact: "low|medium|high",
      securityRisk: "none|low|medium|high",
      dataIntegrityRisk: "none|low|medium|high",
      operationalRisk: "none|low|medium|high"
    },
    recommendedMode: "fast|standard|rigorous",
    confidence: "0..1",
    parallelism: "sequential|candidate",
    constraints: ["concise constraints"],
    approachSummary: "concise summary, no hidden reasoning",
    needsAdditionalInspection: false,
    inspectionQuestions: [{ id: "string", question: "string", reason: "string", allowedPaths: ["repo-relative paths"] }],
    evidenceReferences: ["keys from the evidence packet"],
    taskType: "bug|feature|refactor|investigation|maintenance|documentation|unknown",
    clarification: { required: false, question: null, reason: null }
  };
}

export const defaultCommandRunner: CommandRunner = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code: number | null) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
});

export async function runClaudeWithTierFallback(args: {
  runCommand: CommandRunner;
  root: string;
  baseArgs: string[];
  preferredTier: ModelTier;
  config: LeanRigorConfig;
  stage: string;
}): Promise<{ result: CommandResult; model?: string; tier: ModelTier; warnings: string[] }> {
  const resolvedModels = resolveModelTierFallbacks(args.preferredTier, "claude", args.config);
  const failures: string[] = [];

  for (const resolved of resolvedModels) {
    const commandArgs = [...args.baseArgs];
    if (resolved.model) commandArgs.push("--model", resolved.model);
    try {
      const result = await args.runCommand("claude", commandArgs, args.root);
      if (result.exitCode === 0) {
        return {
          result,
          model: resolved.model,
          tier: resolved.tier,
          warnings: failures.map((failure) => `Claude ${args.stage} provider tier fallback: ${failure}`)
        };
      }
      const reason = result.stderr.trim() || `Claude CLI exited with ${result.exitCode}.`;
      failures.push(formatTierFailure(args.stage, resolved, reason));
    } catch (error) {
      failures.push(formatTierFailure(args.stage, resolved, error instanceof Error ? error.message : String(error ?? "unknown error")));
    }
  }

  const tried = resolvedModels.map(modelLabel).join(", ");
  const lastFailure = failures.at(-1) ?? "reason unavailable";
  const kind = /max_turns_reached|max[-\s]?turns|turn limit|maximum turns|reached.*turn/i.test(lastFailure) ? "max_turns" : "provider_process_failure";
  throw new TriageProviderError(
    `Claude Code could not run LeanRigor ${args.stage} after trying ${tried}. ` +
    `Last failure: ${lastFailure}. ` +
    `Configure the preferred tier with 'leanrigor models --claude-${args.preferredTier} <model-or-alias>', ` +
    `set LEANRIGOR_CLAUDE_MODEL_${args.preferredTier.toUpperCase()}, or adjust models.fallback.`,
    kind
  );
}

function parseCommandOutput(result: CommandResult): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return result.stdout;
  }
}

function formatTierFailure(stage: string, resolved: ResolvedModel, reason: string): string {
  return `${stage} tier '${resolved.tier}' (${modelLabel(resolved)}) failed: ${compactReason(reason)}`;
}

function modelLabel(resolved: ResolvedModel): string {
  return resolved.model ? `model '${resolved.model}'` : "inherited Claude default";
}

function compactReason(reason: string): string {
  const compact = reason.replace(/\s+/g, " ").trim();
  if (/max[-\s]?turns|turn limit|maximum turns|reached.*turn/i.test(compact)) return `max_turns_reached: ${compact.slice(0, 450)}`;
  return compact.slice(0, 500);
}
