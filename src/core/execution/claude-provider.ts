import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ExecutionError } from "./errors.js";
import type { ExecutionProvider } from "./provider.js";
import { phaseWorkerPrompt } from "./prompt.js";
import type { ExecutionCapabilities, ExecutionHandle, ExecutionStatus, PhaseExecutionInput, PhaseExecutionResult } from "./types.js";

const execFileAsync = promisify(execFile);

interface ClaudeExecution {
  handle: ExecutionHandle;
  controller: AbortController;
  promise: Promise<{ stdout: string; stderr: string }>;
  status: "running" | "completed" | "failed" | "cancelled" | "timed_out";
  startedAt: string;
  completedAt?: string;
  diagnostics: Record<string, unknown>;
}

export interface ClaudeCliExecutionProviderOptions {
  command?: string;
  maxTurns?: number;
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "manual";
}

export class ClaudeCliExecutionProvider implements ExecutionProvider {
  readonly id = "claude-cli";
  private executions = new Map<string, ClaudeExecution>();

  constructor(private readonly options: ClaudeCliExecutionProviderOptions = {}) {}

  async capabilities(): Promise<ExecutionCapabilities> {
    try {
      await execFileAsync(this.options.command ?? "claude", ["--version"], { timeout: 5000 });
    } catch (error) {
      throw new ExecutionError("provider_unavailable", "Claude CLI is not available on PATH.", { cause: error instanceof Error ? error.message : String(error) });
    }
    return {
      parallel: false,
      cancellation: true,
      heartbeats: false,
      maxConcurrent: 1,
      structuredResults: true,
      diagnostics: ["claude CLI print mode", "JSON result parsing"]
    };
  }

  async dispatch(input: PhaseExecutionInput): Promise<ExecutionHandle> {
    const executionId = `claude-${input.workflowId}-${input.phaseId}-${Date.now()}`;
    const prompt = `${phaseWorkerPrompt(input)}\n\nReturn this JSON shape exactly:\n${JSON.stringify(exampleResult(input), null, 2)}`;
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--max-turns",
      String(this.options.maxTurns ?? 12),
      "--permission-mode",
      this.options.permissionMode ?? "acceptEdits",
      "--no-session-persistence"
    ];
    if (this.options.model) args.push("--model", this.options.model);
    const startedAt = new Date().toISOString();
    const handle: ExecutionHandle = {
      providerId: this.id,
      providerExecutionId: executionId,
      workflowId: input.workflowId,
      phaseId: input.phaseId,
      leaseOwnerId: input.leaseOwnerId,
      workspacePath: input.workspacePath,
      startedAt,
      lastKnownStatus: "running",
      providerMetadata: { command: this.options.command ?? "claude", maxTurns: this.options.maxTurns ?? 12, permissionMode: this.options.permissionMode ?? "acceptEdits" }
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutSeconds * 1000);
    const promise = execFileAsync(this.options.command ?? "claude", args, {
      cwd: input.workspacePath,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      signal: controller.signal,
      env: { ...process.env, CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1" }
    }).finally(() => clearTimeout(timeout));
    const execution: ClaudeExecution = {
      handle,
      controller,
      promise,
      status: "running",
      startedAt,
      diagnostics: {}
    };
    this.executions.set(executionId, execution);
    promise.then(() => {
      execution.status = "completed";
      execution.completedAt = new Date().toISOString();
    }).catch((error: unknown) => {
      execution.status = controller.signal.aborted ? "timed_out" : "failed";
      execution.completedAt = new Date().toISOString();
      execution.diagnostics = redactDiagnostics({ error: error instanceof Error ? error.message : String(error) });
    });
    return handle;
  }

  async getStatus(handle: ExecutionHandle): Promise<ExecutionStatus> {
    const execution = this.executions.get(handle.providerExecutionId);
    if (!execution) throw new ExecutionError("execution_not_found", `Unknown Claude execution: ${handle.providerExecutionId}`);
    return {
      status: execution.status,
      heartbeatAt: execution.status === "running" ? new Date().toISOString() : execution.completedAt,
      diagnostics: execution.diagnostics
    };
  }

  async collectResult(handle: ExecutionHandle): Promise<PhaseExecutionResult> {
    const execution = this.executions.get(handle.providerExecutionId);
    if (!execution) throw new ExecutionError("execution_not_found", `Unknown Claude execution: ${handle.providerExecutionId}`);
    try {
      const output = await execution.promise;
      return parseClaudeResult(output.stdout, output.stderr);
    } catch (error) {
      const output = commandOutput(error);
      const message = `${error instanceof Error ? error.message : String(error)}\n${output.stdout}\n${output.stderr}`;
      if (/login|auth|api key|unauthorized/i.test(message)) throw new ExecutionError("provider_unauthenticated", "Claude CLI is not authenticated.", { message: redact(message) });
      if (execution.status === "timed_out") {
        return emptyResult("timed_out", "Claude execution timed out.");
      }
      throw new ExecutionError("provider_process_exited", "Claude CLI exited before returning a structured result.", { message: redact(message) });
    }
  }

  async cancel(handle: ExecutionHandle, reason?: string): Promise<void> {
    const execution = this.executions.get(handle.providerExecutionId);
    if (!execution) return;
    execution.status = "cancelled";
    execution.completedAt = new Date().toISOString();
    execution.diagnostics = { reason };
    execution.controller.abort();
  }
}

function parseClaudeResult(stdout: string, stderr: string): PhaseExecutionResult {
  let outer: unknown;
  try {
    outer = JSON.parse(stdout);
  } catch {
    throw new ExecutionError("provider_protocol_error", "Claude CLI did not return JSON.", { stderr: redact(stderr).slice(0, 1000) });
  }
  const text = typeof outer === "object" && outer !== null && "result" in outer
    ? String((outer as { result?: unknown }).result ?? "")
    : JSON.stringify(outer);
  if (typeof outer === "object" && outer !== null && (outer as { is_error?: unknown }).is_error && /login|auth|api key|unauthorized/i.test(text)) {
    throw new ExecutionError("provider_unauthenticated", "Claude CLI is not authenticated.", { message: redact(text) });
  }
  const parsed = extractJson(text);
  if (!isPhaseExecutionResult(parsed)) throw new ExecutionError("result_malformed", "Claude result did not match the phase execution result contract.");
  return parsed;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new ExecutionError("result_malformed", "No JSON object was found in Claude's result.");
  }
}

function isPhaseExecutionResult(value: unknown): value is PhaseExecutionResult {
  if (!value || typeof value !== "object") return false;
  const result = value as PhaseExecutionResult;
  return ["completed", "failed", "cancelled", "timed_out", "blocked"].includes(result.status)
    && typeof result.summary === "string"
    && Array.isArray(result.changedFiles)
    && Array.isArray(result.validation)
    && Array.isArray(result.criterionEvidence)
    && Array.isArray(result.assumptions)
    && Array.isArray(result.scopeDeviations)
    && Array.isArray(result.remainingRisks);
}

function exampleResult(input: PhaseExecutionInput): PhaseExecutionResult {
  return {
    status: "completed",
    summary: "Verified: concise summary of implemented work. Inferred: any bounded inferences. Unverified: any unverified claims.",
    changedFiles: ["relative/path.ts"],
    validation: input.validationExpectations.map((command) => ({ command, exitCode: 0, status: "passed", result: "concise result" })),
    criterionEvidence: input.acceptanceCriteria.map((criterion) => ({ criterion, status: "met", evidence: ["specific evidence"] })),
    assumptions: [],
    scopeDeviations: [],
    remainingRisks: []
  };
}

function emptyResult(status: PhaseExecutionResult["status"], summary: string): PhaseExecutionResult {
  return { status, summary, changedFiles: [], validation: [], criterionEvidence: [], assumptions: [], scopeDeviations: [], remainingRisks: [] };
}

function redactDiagnostics(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "string" ? redact(item) : item]));
}

function redact(value: string): string {
  return value.replace(/(api[_-]?key|token|secret|password)[=:]\S+/gi, "$1=[REDACTED]");
}

function commandOutput(error: unknown): { stdout: string; stderr: string } {
  if (!error || typeof error !== "object") return { stdout: "", stderr: "" };
  const candidate = error as { stdout?: unknown; stderr?: unknown };
  return {
    stdout: typeof candidate.stdout === "string" ? candidate.stdout : "",
    stderr: typeof candidate.stderr === "string" ? candidate.stderr : ""
  };
}
