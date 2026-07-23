import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LeanRigorConfig } from "../../config/schema.js";
import { resolveModelTier } from "../../config/models.js";
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
    const model = resolveModelTier(config.routing.triage, "claude", config).model;
    const prompt = await buildTriagePrompt(root, request);
    const args = ["-p", prompt, "--output-format", "json", "--max-turns", "1", "--disallowedTools", "Edit", "Write", "Bash"];
    if (model) args.push("--model", model);

    const result = await this.runCommand("claude", args, root);
    if (result.exitCode !== 0) {
      const resolved = model ?? "inherit";
      throw new Error(
        `Claude Code could not run the LeanRigor '${config.routing.triage}' tier ` +
        `(resolved model: '${resolved}'). ${result.stderr.trim() || `Claude CLI exited with ${result.exitCode}.`} ` +
        `Verify the model is allowed in Claude Code, configure it with ` +
        `'leanrigor models --claude-${config.routing.triage} <model-or-alias>', or set ` +
        `LEANRIGOR_CLAUDE_MODEL_${config.routing.triage.toUpperCase()}.`
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

export async function buildTriagePrompt(root: string, request: string): Promise<string> {
  const skillPath = path.join(root, "skills", "triage-task", "SKILL.md");
  const skill = await readFile(skillPath, "utf8").catch(() => "Return only TriageOutput JSON. Do not modify files.");
  return [
    "You are the bounded triage classifier for LeanRigor.",
    "Follow the contract below exactly. Return only one JSON object; no prose or markdown.",
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
