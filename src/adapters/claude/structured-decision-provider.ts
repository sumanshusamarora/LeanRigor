import type {
  StructuredDecisionCapabilities,
  StructuredDecisionProvider,
  StructuredDecisionRequest,
  StructuredDecisionResult
} from "../../core/structured-decision.js";
import type { CommandRunner } from "./triage-provider.js";
import { defaultCommandRunner, runClaudeWithTierFallback } from "./triage-provider.js";

export class ClaudeCliStructuredDecisionProvider implements StructuredDecisionProvider {
  readonly name = "claude-cli";

  constructor(private readonly runCommand: CommandRunner = defaultCommandRunner) {}

  capabilities(): StructuredDecisionCapabilities {
    return { structuredOutput: true, schemaEnforcement: true, minimalContext: true, toolIsolation: true };
  }

  async decide<T = unknown>(request: StructuredDecisionRequest): Promise<StructuredDecisionResult<T>> {
    const toolArgs = request.tools === "none"
      ? ["--tools", ""]
      : ["--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,TodoWrite,PullRequest,Git,GitHub,GitLab,Jira,Slack,Email,MCP"];
    const attempted = await runClaudeWithTierFallback({
      runCommand: this.runCommand,
      root: request.root,
      baseArgs: [
        "-p", "--bare", "--effort", request.effort ?? "low",
        "--output-format", "json", "--json-schema", JSON.stringify(request.schema),
        "--no-session-persistence", "--max-turns", String(request.maxTurns), ...toolArgs
      ],
      prompt: request.prompt,
      preferredTier: request.tier,
      config: request.config,
      stage: request.stage
    });
    return {
      value: structuredValue(attempted.result.stdout) as T,
      provider: this.name,
      model: attempted.model,
      tier: attempted.tier,
      launchMode: "bare",
      warnings: attempted.warnings
    };
  }
}

function structuredValue(stdout: string): unknown {
  let envelope: unknown;
  try { envelope = JSON.parse(stdout); } catch { return stdout; }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return envelope;
  const record = envelope as Record<string, unknown>;
  if (record.structured_output !== undefined) return record.structured_output;
  if (typeof record.result === "string") {
    try { return JSON.parse(record.result); } catch { return record.result; }
  }
  return envelope;
}
