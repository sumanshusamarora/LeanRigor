import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ExecutionError } from "./errors.js";
import type { ExecutionProvider } from "./provider.js";
import { phaseWorkerPrompt } from "./prompt.js";
import type { ExecutionCapabilities, ExecutionHandle, ExecutionStatus, PhaseExecutionInput, PhaseExecutionResult } from "./types.js";

const execFileAsync = promisify(execFile);

interface ClaudeExecution {
  handle: ExecutionHandle;
  controller: AbortController;
  status: "running" | "completed" | "failed" | "cancelled" | "timed_out";
  startedAt: string;
  completedAt?: string;
  diagnostics: Record<string, unknown>;
}

interface PersistedClaudeMetadata {
  command: string;
  args?: string[];
  maxTurns: number;
  permissionMode: string;
  pid?: number;
  artifactDir: string;
  statusPath: string;
  stdoutPath: string;
  stderrPath: string;
}

interface PersistedClaudeStatus {
  status: "running" | "completed" | "failed" | "cancelled" | "timed_out";
  pid?: number;
  startedAt: string;
  completedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  diagnostics?: Record<string, unknown>;
}

export interface ClaudeCliExecutionProviderOptions {
  command?: string;
  maxTurns?: number;
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "manual" | "bypassPermissions";
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
    const prompt = `${phaseWorkerPrompt(input)}\n\nReturn exactly one machine-readable final JSON object matching this schema. Do not include prose outside the final JSON object. Do not include hidden reasoning. Use the validation array for command evidence only:\n${JSON.stringify(exampleResult(input), null, 2)}`;
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(phaseExecutionResultJsonSchema()),
      "--max-turns",
      String(this.options.maxTurns ?? 12),
      "--permission-mode",
      this.options.permissionMode ?? "bypassPermissions",
      "--no-session-persistence"
    ];
    if (this.options.model) args.push("--model", this.options.model);
    const startedAt = new Date().toISOString();
    const artifactDir = path.join(input.repositoryRoot, ".leanrigor", "executions", input.workflowId, input.phaseId, executionId);
    await mkdir(artifactDir, { recursive: true });
    const statusPath = path.join(artifactDir, "status.json");
    const stdoutPath = path.join(artifactDir, "stdout.json");
    const stderrPath = path.join(artifactDir, "stderr.txt");
    const providerMetadata: PersistedClaudeMetadata = {
      command: this.options.command ?? "claude",
      args,
      maxTurns: this.options.maxTurns ?? 12,
      permissionMode: this.options.permissionMode ?? "bypassPermissions",
      artifactDir,
      statusPath,
      stdoutPath,
      stderrPath
    };
    const handle: ExecutionHandle = {
      providerId: this.id,
      providerExecutionId: executionId,
      workflowId: input.workflowId,
      phaseId: input.phaseId,
      leaseOwnerId: input.leaseOwnerId,
      workspacePath: input.workspacePath,
      startedAt,
      lastKnownStatus: "running",
      providerMetadata: providerMetadata as unknown as Record<string, unknown>
    };
    const controller = new AbortController();
    const stdout = await open(stdoutPath, "w");
    const stderr = await open(stderrPath, "w");
    const child = spawn(this.options.command ?? "claude", args, {
      cwd: input.workspacePath,
      detached: true,
      stdio: ["ignore", stdout.fd, stderr.fd],
      signal: controller.signal,
      env: { ...process.env, CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1" }
    });
    await stdout.close();
    await stderr.close();
    providerMetadata.pid = child.pid;
    await writeStatus(statusPath, { status: "running", pid: child.pid, startedAt });
    const execution: ClaudeExecution = {
      handle,
      controller,
      status: "running",
      startedAt,
      diagnostics: {}
    };
    this.executions.set(executionId, execution);
    const timeout = setTimeout(() => {
      controller.abort();
      if (child.pid) killProcessGroup(child.pid, "SIGTERM");
    }, input.timeoutSeconds * 1000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      execution.status = controller.signal.aborted ? "timed_out" : code === 0 ? "completed" : "failed";
      execution.completedAt = new Date().toISOString();
      execution.diagnostics = signal || code ? { exitCode: code, signal } : {};
      void writeStatus(statusPath, {
        status: execution.status,
        pid: child.pid,
        startedAt,
        completedAt: execution.completedAt,
        exitCode: code,
        signal,
        diagnostics: execution.diagnostics
      });
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      execution.status = "failed";
      execution.completedAt = new Date().toISOString();
      execution.diagnostics = redactDiagnostics({ error: error.message });
      void writeStatus(statusPath, { status: "failed", pid: child.pid, startedAt, completedAt: execution.completedAt, diagnostics: execution.diagnostics });
    });
    child.unref();
    return handle;
  }

  async getStatus(handle: ExecutionHandle): Promise<ExecutionStatus> {
    const persisted = await readPersistedStatus(handle);
    if (persisted) {
      if (persisted.status === "running" && persisted.pid && !pidIsRunning(persisted.pid)) {
        return { status: "completed", heartbeatAt: new Date().toISOString(), diagnostics: { ...persisted.diagnostics, pid: persisted.pid, statusInferredFromPid: true } };
      }
      const metadata = claudeMetadata(handle);
      return { status: persisted.status, heartbeatAt: persisted.status === "running" ? new Date().toISOString() : persisted.completedAt, diagnostics: { ...persisted.diagnostics, artifactDir: metadata?.artifactDir } };
    }
    const execution = this.executions.get(handle.providerExecutionId);
    if (!execution) throw new ExecutionError("execution_not_found", `Unknown Claude execution: ${handle.providerExecutionId}`);
    return {
      status: execution.status,
      heartbeatAt: execution.status === "running" ? new Date().toISOString() : execution.completedAt,
      diagnostics: execution.diagnostics
    };
  }

  async collectResult(handle: ExecutionHandle): Promise<PhaseExecutionResult> {
    const metadata = claudeMetadata(handle);
    if (metadata) {
      const status = await readCollectibleStatus(handle);
      if (status?.status === "timed_out") return emptyResult("timed_out", "Claude execution timed out.");
      if (status?.status === "cancelled") return emptyResult("cancelled", "Claude execution was cancelled.");
      const stdout = await readFile(metadata.stdoutPath, "utf8").catch(() => "");
      const stderr = await readFile(metadata.stderrPath, "utf8").catch(() => "");
      if (status?.status === "failed") {
        throw withArtifactDiagnostics(new ExecutionError("provider_process_exited", "Claude CLI exited before returning a successful provider result."), handle, metadata, stdout, stderr, status);
      }
      try {
        return parseClaudeResult(stdout, stderr);
      } catch (error) {
        const message = `${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`;
        if (/login|auth|api key|unauthorized/i.test(message)) throw new ExecutionError("provider_unauthenticated", "Claude CLI is not authenticated.", { message: redact(message) });
        throw withArtifactDiagnostics(error, handle, metadata, stdout, stderr, status);
      }
    }
    const execution = this.executions.get(handle.providerExecutionId);
    if (!execution) throw new ExecutionError("execution_not_found", `Unknown Claude execution: ${handle.providerExecutionId}`);
    throw new ExecutionError("execution_not_found", `Claude execution has no persisted result artifacts: ${handle.providerExecutionId}`);
  }

  async cancel(handle: ExecutionHandle, reason?: string): Promise<void> {
    const metadata = claudeMetadata(handle);
    if (metadata) {
      const status = await readPersistedStatus(handle);
      if (status?.pid && pidIsRunning(status.pid)) killProcessGroup(status.pid, "SIGTERM");
      await writeStatus(metadata.statusPath, { status: "cancelled", pid: status?.pid, startedAt: status?.startedAt ?? handle.startedAt, completedAt: new Date().toISOString(), diagnostics: { reason } });
    }
    const execution = this.executions.get(handle.providerExecutionId);
    if (!execution) return;
    execution.status = "cancelled";
    execution.completedAt = new Date().toISOString();
    execution.diagnostics = { reason };
    execution.controller.abort();
  }
}

async function writeStatus(statusPath: string, status: PersistedClaudeStatus): Promise<void> {
  const tempPath = `${statusPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await rename(tempPath, statusPath);
}

async function readPersistedStatus(handle: ExecutionHandle): Promise<PersistedClaudeStatus | undefined> {
  const metadata = claudeMetadata(handle);
  if (!metadata) return undefined;
  try {
    await stat(metadata.statusPath);
    return JSON.parse(await readFile(metadata.statusPath, "utf8")) as PersistedClaudeStatus;
  } catch {
    return undefined;
  }
}

async function readCollectibleStatus(handle: ExecutionHandle): Promise<PersistedClaudeStatus | undefined> {
  let status = await readPersistedStatus(handle);
  if (status?.status === "running" && status.pid && !pidIsRunning(status.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = await readPersistedStatus(handle);
  }
  return status;
}

function claudeMetadata(handle: ExecutionHandle): PersistedClaudeMetadata | undefined {
  const metadata = handle.providerMetadata as Partial<PersistedClaudeMetadata> | undefined;
  if (!metadata || typeof metadata.statusPath !== "string" || typeof metadata.stdoutPath !== "string" || typeof metadata.stderrPath !== "string") return undefined;
  return metadata as PersistedClaudeMetadata;
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

export function parseClaudeResult(stdout: string, stderr: string): PhaseExecutionResult {
  const envelopes = parseClaudeOutput(stdout, stderr);
  for (const envelope of envelopes) {
    const candidate = extractPhaseResultCandidate(envelope);
    if (candidate === undefined) continue;
    if (!isPhaseExecutionResult(candidate)) throw new ExecutionError("result_malformed", "Claude result did not match the phase execution result contract.");
    return candidate;
  }
  throw new ExecutionError("result_malformed", "No structured phase result was found in Claude's result envelope.");
}

function parseClaudeOutput(stdout: string, stderr: string): unknown[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) throw new ExecutionError("provider_protocol_error", "Claude CLI returned empty stdout.", { stderr: redact(stderr).slice(0, 1000) });
  try {
    return [JSON.parse(trimmed)];
  } catch {
    const envelopes: unknown[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(candidate);
        if (isClaudeResultEnvelope(parsed)) envelopes.push(parsed);
      } catch {
        // Ignore non-JSON metadata lines; malformed JSON result lines are handled below.
      }
    }
    if (envelopes.length > 0) return envelopes;
    throw new ExecutionError("provider_protocol_error", "Claude CLI did not return a documented JSON result envelope.", { stdout: redact(trimmed).slice(0, 1000), stderr: redact(stderr).slice(0, 1000) });
  }
}

function extractPhaseResultCandidate(envelope: unknown): unknown {
  if (!envelope || typeof envelope !== "object") return envelope;
  const record = envelope as Record<string, unknown>;
  if (record.is_error && /login|auth|api key|unauthorized/i.test(String(record.result ?? ""))) {
    throw new ExecutionError("provider_unauthenticated", "Claude CLI is not authenticated.", { message: redact(String(record.result ?? "")) });
  }
  if (isPhaseExecutionResult(record.structured_output)) return record.structured_output;
  if (record.structured_output !== undefined) return record.structured_output;
  if (record.type === "result" && "result" in record) return parseResultField(record.result);
  return envelope;
}

function parseResultField(value: unknown): unknown {
  if (typeof value === "object" && value !== null) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
    if (fenced) {
      try {
        return JSON.parse(fenced[1] ?? "");
      } catch {
        throw new ExecutionError("result_malformed", "Claude result contained malformed fenced JSON.");
      }
    }
    return undefined;
  }
}

function isClaudeResultEnvelope(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "result");
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

function phaseExecutionResultJsonSchema(): Record<string, unknown> {
  const validation = {
    type: "object",
    properties: {
      command: { type: "string" },
      exitCode: { type: ["number", "null"] },
      status: { enum: ["passed", "failed", "skipped"] },
      result: { type: "string" },
      skipped: { type: "boolean" },
      skippedReason: { type: "string" },
      timestamp: { type: "string" }
    },
    required: ["command", "status", "result"],
    additionalProperties: false
  };
  const criterion = {
    type: "object",
    properties: {
      criterion: { type: "string" },
      status: { enum: ["met", "not_met", "uncertain", "not_applicable"] },
      evidence: { type: "array", items: { type: "string" } }
    },
    required: ["criterion", "status", "evidence"],
    additionalProperties: false
  };
  const deviation = {
    type: "object",
    properties: {
      path: { type: "string" },
      reason: { type: "string" }
    },
    required: ["reason"],
    additionalProperties: false
  };
  return {
    type: "object",
    properties: {
      status: { enum: ["completed", "failed", "cancelled", "timed_out", "blocked"] },
      summary: { type: "string" },
      changedFiles: { type: "array", items: { type: "string" } },
      validation: { type: "array", items: validation },
      criterionEvidence: { type: "array", items: criterion },
      assumptions: { type: "array", items: { type: "string" } },
      scopeDeviations: { type: "array", items: deviation },
      remainingRisks: { type: "array", items: { type: "string" } }
    },
    required: ["status", "summary", "changedFiles", "validation", "criterionEvidence", "assumptions", "scopeDeviations", "remainingRisks"],
    additionalProperties: false
  };
}

function withArtifactDiagnostics(error: unknown, handle: ExecutionHandle, metadata: PersistedClaudeMetadata, stdout: string, stderr: string, status: PersistedClaudeStatus | undefined): ExecutionError {
  const base = error instanceof ExecutionError
    ? error
    : new ExecutionError("result_malformed", error instanceof Error ? error.message : String(error));
  return new ExecutionError(base.code, base.message, {
    ...base.details,
    providerExecutionId: handle.providerExecutionId,
    artifactDir: metadata.artifactDir,
    statusPath: metadata.statusPath,
    stdoutPath: metadata.stdoutPath,
    stderrPath: metadata.stderrPath,
    exitCode: status?.exitCode,
    signal: status?.signal,
    stdoutExcerpt: redact(stdout).slice(0, 1000),
    stderrExcerpt: redact(stderr).slice(0, 1000),
    nextStep: `Inspect ${metadata.artifactDir} and rerun leanrigor flow execution-poll ${handle.workflowId} --provider claude-cli after repairing provider output.`
  });
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
