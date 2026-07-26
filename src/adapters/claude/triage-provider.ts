import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LeanRigorConfig, ModelTier } from "../../config/schema.js";
import { resolveModelTierFallbacks, type ResolvedModel } from "../../config/models.js";
import type { TriageProvider, TriageProviderResult } from "../../core/triage-runner.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<CommandResult>;

export class ClaudeCliTriageProvider implements TriageProvider {
  name = "claude-cli";

  constructor(private readonly runCommand: CommandRunner = defaultCommandRunner) {}

  async classify(request: string, root: string, config: LeanRigorConfig): Promise<TriageProviderResult> {
    const tier = config.routing.triage;
    const prompt = await buildTriagePrompt(root, request);
    // Allow read-only tools for informed inspection; keep enough turns for inspect + respond.
    // Mutating and side-effect tools are forbidden.
    const baseArgs = ["-p", prompt, "--output-format", "json", "--max-turns", "5", "--disallowedTools", "Edit", "Write", "Bash", "PullRequest", "Git", "GitHub", "GitLab", "Jira", "Slack", "Email"];
    const attempted = await runClaudeWithTierFallback({
      runCommand: this.runCommand,
      root,
      baseArgs,
      preferredTier: tier,
      config,
      stage: "triage"
    });

    return { raw: parseCommandOutput(attempted.result), provider: this.name, model: attempted.model, warnings: attempted.warnings };
  }
}

export async function buildTriagePrompt(root: string, request: string): Promise<string> {
  const skillPath = path.join(root, "internal-skills", "triage-task", "SKILL.md");
  const skill = await readFile(skillPath, "utf8").catch(() => "Return only TriageOutput JSON. Do not modify files.");
  return [
    "You are the bounded triage classifier for LeanRigor.",
    "You may inspect the repository with Read/Glob/Grep to inform your assessment, but keep inspection minimal.",
    "Follow the contract below exactly. Return only one JSON object as your final response; no prose or markdown.",
    skill,
    "User request:",
    request
  ].join("\n\n");
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
      failures.push(formatTierFailure(args.stage, resolved, result.stderr.trim() || `Claude CLI exited with ${result.exitCode}.`));
    } catch (error) {
      failures.push(formatTierFailure(args.stage, resolved, error instanceof Error ? error.message : String(error ?? "unknown error")));
    }
  }

  const tried = resolvedModels.map(modelLabel).join(", ");
  throw new Error(
    `Claude Code could not run LeanRigor ${args.stage} after trying ${tried}. ` +
    `Last failure: ${failures.at(-1) ?? "reason unavailable"}. ` +
    `Configure the preferred tier with 'leanrigor models --claude-${args.preferredTier} <model-or-alias>', ` +
    `set LEANRIGOR_CLAUDE_MODEL_${args.preferredTier.toUpperCase()}, or adjust models.fallback.`
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
