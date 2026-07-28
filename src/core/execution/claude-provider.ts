import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveModelTier } from "../../config/models.js";
import type { LeanRigorConfig } from "../../config/schema.js";
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
  safeArgs?: string[];
  maxTurns: number;
  permissionMode: string;
  environmentMode: "bare" | "safe-mode" | "default";
  pid?: number;
  artifactDir: string;
  statusPath: string;
  stdoutPath: string;
  stderrPath: string;
  sessionId?: string;
  resumeMode?: "fresh" | "same-session" | "compact-retry";
  resolvedModel?: string;
  toolEnforcement: string;
  workerControls?: PhaseExecutionInput["workerControls"];
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
  environmentMode?: "bare" | "safe-mode" | "default";
  config?: LeanRigorConfig;
}

export class ClaudeCliExecutionProvider implements ExecutionProvider {
  readonly id = "claude-cli";
  private executions = new Map<string, ClaudeExecution>();
  private providerVersion?: string;

  constructor(private readonly options: ClaudeCliExecutionProviderOptions = {}) {}

  async capabilities(): Promise<ExecutionCapabilities> {
    try {
      const version = await execFileAsync(this.options.command ?? "claude", ["--version"], { timeout: 5000, encoding: "utf8" }) as { stdout: string; stderr: string };
      this.providerVersion = (version.stdout || version.stderr).trim() || undefined;
    } catch (error) {
      throw new ExecutionError("provider_unavailable", "Claude CLI is not available on PATH.", { cause: error instanceof Error ? error.message : String(error) });
    }
    return {
      parallel: false,
      cancellation: true,
      heartbeats: false,
      maxConcurrent: 1,
      structuredResults: true,
      sessions: { persistent: true, resume: true, fork: true },
      diagnostics: ["claude CLI print mode", "JSON result parsing", "persistent session IDs", "bounded worker environment"]
    };
  }

  async dispatch(input: PhaseExecutionInput): Promise<ExecutionHandle> {
    const executionId = `claude-${input.workflowId}-${input.phaseId}-${Date.now()}`;
    const canResume = input.resume?.mode === "same-session"
      && input.resume.providerSession?.providerId === this.id
      && input.resume.providerSession.workflowId === input.workflowId
      && input.resume.providerSession.phaseId === input.phaseId
      && input.resume.providerSession.workingDirectory === input.workspacePath
      && input.resume.providerSession.resumePermitted;
    const sessionId = canResume ? input.resume!.providerSession!.sessionId : randomUUID();
    const resumeMode = canResume ? "same-session" : input.resume ? "compact-retry" : "fresh";
    const prompt = resumeMode === "same-session" ? resumePrompt(input) : phaseWorkerPrompt(input);
    const maxTurns = this.options.maxTurns ?? maxTurnsForMode(input.selectedMode);
    const environmentMode = this.options.environmentMode ?? this.options.config?.execution.workerControls.environment ?? "bare";
    const permissionMode = this.options.permissionMode ?? "bypassPermissions";
    const resolved = resolveClaudeModel(input, this.options);
    const args = buildClaudeArgs({
      prompt,
      maxTurns,
      permissionMode,
      environmentMode,
      model: resolved.model,
      sessionId,
      resume: canResume
    });
    const safeArgs = buildSafeArgs({
      maxTurns,
      permissionMode,
      environmentMode,
      model: resolved.model,
      sessionId,
      resume: canResume
    });
    const startedAt = new Date().toISOString();
    const artifactDir = path.join(input.repositoryRoot, ".leanrigor", "executions", input.workflowId, input.phaseId, executionId);
    await mkdir(artifactDir, { recursive: true });
    const statusPath = path.join(artifactDir, "status.json");
    const stdoutPath = path.join(artifactDir, "stdout.json");
    const stderrPath = path.join(artifactDir, "stderr.txt");
    const providerMetadata: PersistedClaudeMetadata = {
      command: this.options.command ?? "claude",
      safeArgs,
      maxTurns,
      permissionMode,
      environmentMode,
      artifactDir,
      statusPath,
      stdoutPath,
      stderrPath,
      sessionId,
      resumeMode,
      resolvedModel: resolved.model,
      toolEnforcement: permissionMode === "bypassPermissions" ? "allowedTools_not_assumed_under_bypass" : "allowedTools_requested",
      workerControls: input.workerControls
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
      providerMetadata: providerMetadata as unknown as Record<string, unknown>,
      providerSession: {
        providerId: this.id,
        sessionId,
        workflowId: input.workflowId,
        phaseId: input.phaseId,
        executionAttemptId: executionId,
        workingDirectory: input.workspacePath,
        createdAt: canResume ? input.resume!.providerSession!.createdAt : startedAt,
        updatedAt: startedAt,
        status: "running",
        requestedTier: input.modelTier,
        resolvedModel: resolved.model,
        providerVersion: this.providerVersion,
        safeCliArgs: safeArgs,
        resumePermitted: true,
        resumedFromSessionId: canResume ? sessionId : undefined,
        replacementReason: resumeMode === "compact-retry" ? input.resume?.failureReason : undefined
      },
      nativeSessionId: sessionId
    };
    const controller = new AbortController();
    const stdout = await open(stdoutPath, "w");
    const stderr = await open(stderrPath, "w");
    const invocation = windowsBatchInvocation(this.options.command ?? "claude", args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: input.workspacePath,
      detached: process.platform !== "win32",
      stdio: ["ignore", stdout.fd, stderr.fd],
      signal: controller.signal,
      env: boundedClaudeEnv(process.env)
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
      return { status: persisted.status, heartbeatAt: persisted.status === "running" ? new Date().toISOString() : persisted.completedAt, diagnostics: { ...persisted.diagnostics, artifactDir: metadata?.artifactDir, sessionId: metadata?.sessionId, resumeMode: metadata?.resumeMode } };
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
        return failureResult(handle, metadata, stdout, stderr, status, "Claude CLI exited before returning a successful provider result.");
      }
      try {
        const result = parseClaudeResult(stdout, stderr);
        return { ...result, providerDiagnostics: { ...result.providerDiagnostics, ...artifactDiagnostics(handle, metadata, stdout, stderr, status) } };
      } catch (error) {
        const message = `${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`;
        if (/login|auth|api key|unauthorized/i.test(message)) throw new ExecutionError("provider_unauthenticated", "Claude CLI is not authenticated.", { message: redact(message) });
        return failureResult(handle, metadata, stdout, stderr, status, error instanceof Error ? error.message : String(error), { providerErrorCode: errorCode(error), ...errorDetailsFromUnknown(error) });
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

function windowsBatchInvocation(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) return { command, args };
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/c", "call", command, ...args]
  };
}

async function writeStatus(statusPath: string, status: PersistedClaudeStatus): Promise<void> {
  const content = `${JSON.stringify(status, null, 2)}\n`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tempPath = `${statusPath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
    try {
      await writeFile(tempPath, content, "utf8");
      await rename(tempPath, statusPath);
      return;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  try {
    await writeFile(statusPath, content, "utf8");
  } catch {
    throw lastError;
  }
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

function buildClaudeArgs(args: {
  prompt: string;
  maxTurns: number;
  permissionMode: string;
  environmentMode: "bare" | "safe-mode" | "default";
  model?: string;
  sessionId: string;
  resume: boolean;
}): string[] {
  const cliArgs: string[] = [];
  if (args.environmentMode === "bare") cliArgs.push("--bare");
  if (args.environmentMode === "safe-mode") cliArgs.push("--safe-mode");
  if (args.resume) cliArgs.push("--resume", args.sessionId, "-p", args.prompt);
  else cliArgs.push("-p", args.prompt, "--session-id", args.sessionId);
  cliArgs.push(
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(phaseExecutionResultJsonSchema()),
    "--max-turns",
    String(args.maxTurns),
    "--permission-mode",
    args.permissionMode,
    "--tools",
    "Read,Edit,MultiEdit,Write,Bash,Glob,Grep",
    "--allowedTools",
    "Read,Edit,MultiEdit,Write,Bash,Glob,Grep",
    "--disallowedTools",
    "WebFetch,WebSearch,Task",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--disable-slash-commands",
    "--setting-sources",
    "user"
  );
  if (args.model) cliArgs.push("--model", args.model);
  return cliArgs;
}

function buildSafeArgs(args: {
  maxTurns: number;
  permissionMode: string;
  environmentMode: "bare" | "safe-mode" | "default";
  model?: string;
  sessionId: string;
  resume: boolean;
}): string[] {
  const safe: string[] = [];
  if (args.environmentMode === "bare") safe.push("--bare");
  if (args.environmentMode === "safe-mode") safe.push("--safe-mode");
  if (args.resume) safe.push("--resume", args.sessionId, "-p", "[compact-resume-prompt]");
  else safe.push("-p", "[bounded-phase-prompt]", "--session-id", args.sessionId);
  safe.push(
    "--output-format",
    "json",
    "--json-schema",
    "[phase-execution-result-schema]",
    "--max-turns",
    String(args.maxTurns),
    "--permission-mode",
    args.permissionMode,
    "--tools",
    "Read,Edit,MultiEdit,Write,Bash,Glob,Grep",
    "--allowedTools",
    "Read,Edit,MultiEdit,Write,Bash,Glob,Grep",
    "--disallowedTools",
    "WebFetch,WebSearch,Task",
    "--strict-mcp-config",
    "--mcp-config",
    "{\"mcpServers\":{}}",
    "--disable-slash-commands",
    "--setting-sources",
    "user"
  );
  if (args.model) safe.push("--model", args.model);
  return safe;
}

function maxTurnsForMode(mode: PhaseExecutionInput["selectedMode"]): number {
  if (mode === "fast") return 8;
  if (mode === "rigorous") return 16;
  return 12;
}

function resolveClaudeModel(input: PhaseExecutionInput, options: ClaudeCliExecutionProviderOptions): { model?: string } {
  if (options.model) return { model: options.model };
  if (!options.config) return {};
  const resolved = resolveModelTier(input.modelTier, "claude", options.config);
  return { model: resolved.resolvedModel };
}

function resumePrompt(input: PhaseExecutionInput): string {
  return [
    "LeanRigor compact resume request",
    `Workflow: ${input.workflowId}`,
    `Phase: ${input.phaseId}`,
    `Workspace: ${input.workspacePath}`,
    `Objective: ${input.objective}`,
    input.resume ? `Recoverable failure: ${input.resume.failureReason}` : undefined,
    input.previousCheckpoint ? `Existing changed files: ${input.previousCheckpoint.changedFiles.join(", ") || "(none)"}` : undefined,
    input.previousCheckpoint?.diffSummary.text ? `Bounded diff summary:\n${input.previousCheckpoint.diffSummary.text}` : undefined,
    "Remaining acceptance criteria:",
    ...input.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "Validation commands:",
    ...input.validationExpectations.map((command) => `- ${command}`),
    "Continue from the existing session and worktree. Do not restart broad repository discovery. Return only the JSON object required by the supplied json-schema."
  ].filter((line): line is string => line !== undefined).join("\n");
}

function boundedClaudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1"
  };
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

function failureResult(handle: ExecutionHandle, metadata: PersistedClaudeMetadata, stdout: string, stderr: string, status: PersistedClaudeStatus | undefined, summary: string, details: Record<string, unknown> = {}): PhaseExecutionResult {
  const message = `${summary}\n${stdout}\n${stderr}`;
  if (/login|auth|api key|unauthorized/i.test(message)) throw new ExecutionError("provider_unauthenticated", "Claude CLI is not authenticated.", { message: redact(message) });
  try {
    const parsed = parseClaudeResult(stdout, stderr);
    if (parsed.status !== "completed") {
      return { ...parsed, providerDiagnostics: { ...parsed.providerDiagnostics, ...artifactDiagnostics(handle, metadata, stdout, stderr, status), ...details } };
    }
  } catch {
    // Preserve the provider failure envelope below.
  }
  const diagnostics = { ...artifactDiagnostics(handle, metadata, stdout, stderr, status), ...details };
  const terminalReason = typeof diagnostics.providerErrorCode === "string" ? diagnostics.providerErrorCode : typeof diagnostics.terminalReason === "string" ? diagnostics.terminalReason : "provider_process_exited";
  return {
    status: "failed",
    summary: `Claude provider failed (${terminalReason}). Partial work, if any, was preserved in the phase worktree but not accepted.`,
    changedFiles: [],
    validation: [],
    criterionEvidence: [],
    assumptions: [],
    scopeDeviations: [],
    remainingRisks: [],
    providerDiagnostics: diagnostics
  };
}

function artifactDiagnostics(handle: ExecutionHandle, metadata: PersistedClaudeMetadata, stdout: string, stderr: string, status: PersistedClaudeStatus | undefined): Record<string, unknown> {
  const envelope = parseClaudeDiagnostics(stdout);
  return redactDiagnostics({
    providerExecutionId: handle.providerExecutionId,
    artifactDir: metadata.artifactDir,
    statusPath: metadata.statusPath,
    stdoutPath: metadata.stdoutPath,
    stderrPath: metadata.stderrPath,
    sessionId: metadata.sessionId ?? envelope.sessionId,
    resumeMode: metadata.resumeMode,
    resolvedModel: metadata.resolvedModel,
    maxTurns: metadata.maxTurns,
    permissionMode: metadata.permissionMode,
    environmentMode: metadata.environmentMode,
    toolEnforcement: metadata.toolEnforcement,
    safeArgs: metadata.safeArgs,
    workerControls: metadata.workerControls,
    exitCode: status?.exitCode,
    signal: status?.signal,
    terminalReason: envelope.terminalReason,
    stopReason: envelope.stopReason,
    turnCount: envelope.turnCount,
    usage: envelope.usage,
    modelUsage: envelope.modelUsage,
    costUsd: envelope.costUsd,
    stdoutExcerpt: redact(stdout).slice(0, 1000),
    stderrExcerpt: redact(stderr).slice(0, 1000),
    partialProgressAccepted: false
  });
}

function parseClaudeDiagnostics(stdout: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const toolCounts: Record<string, number> = {};
  const readCounts: Record<string, number> = {};
  const largeToolResults: Array<{ toolUseId?: string; bytes: number }> = [];
  let toolIndex = 0;
  let firstEditToolIndex: number | undefined;
  for (const envelope of parseClaudeOutputLenient(stdout)) {
    if (!envelope || typeof envelope !== "object") continue;
    const record = envelope as Record<string, unknown>;
    if (typeof record.session_id === "string") out.sessionId = record.session_id;
    if (typeof record.sessionId === "string") out.sessionId = record.sessionId;
    if (typeof record.subtype === "string") out.terminalReason = record.subtype;
    if (typeof record.stop_reason === "string") out.stopReason = record.stop_reason;
    if (typeof record.num_turns === "number") out.turnCount = record.num_turns;
    if (typeof record.total_cost_usd === "number") out.costUsd = record.total_cost_usd;
    if (record.usage && typeof record.usage === "object") out.usage = record.usage;
    if (record.modelUsage && typeof record.modelUsage === "object") out.modelUsage = record.modelUsage;
    if (record.is_error === true && typeof record.result === "string" && !out.terminalReason) out.terminalReason = compactReason(record.result);
    for (const tool of toolUsesFromEnvelope(record)) {
      toolIndex += 1;
      toolCounts[tool.name] = (toolCounts[tool.name] ?? 0) + 1;
      if ((tool.name === "Edit" || tool.name === "MultiEdit" || tool.name === "Write") && firstEditToolIndex === undefined) firstEditToolIndex = toolIndex;
      if (tool.name === "Read" && tool.filePath) readCounts[tool.filePath] = (readCounts[tool.filePath] ?? 0) + 1;
    }
    for (const result of toolResultsFromEnvelope(record)) {
      if (result.bytes > 32768) largeToolResults.push(result);
    }
  }
  const repeatedReads = Object.entries(readCounts).filter(([, count]) => count > 2).map(([file, count]) => ({ file, count }));
  if (Object.keys(toolCounts).length > 0) out.toolCounts = toolCounts;
  if (repeatedReads.length > 0) out.repeatedReads = repeatedReads;
  if (largeToolResults.length > 0) out.largeToolResults = largeToolResults;
  if (firstEditToolIndex !== undefined) out.firstEditToolIndex = firstEditToolIndex;
  return out;
}

function toolUsesFromEnvelope(record: Record<string, unknown>): Array<{ name: string; filePath?: string }> {
  const message = record.message;
  const content = message && typeof message === "object" ? (message as { content?: unknown }).content : record.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ name: string; filePath?: string }> = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type !== "tool_use" || typeof entry.name !== "string") continue;
    const input = entry.input && typeof entry.input === "object" ? entry.input as Record<string, unknown> : {};
    const filePath = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : undefined;
    out.push({ name: entry.name, filePath });
  }
  return out;
}

function toolResultsFromEnvelope(record: Record<string, unknown>): Array<{ toolUseId?: string; bytes: number }> {
  const content = record.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ toolUseId?: string; bytes: number }> = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type !== "tool_result") continue;
    const text = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content ?? "");
    out.push({ toolUseId: typeof entry.tool_use_id === "string" ? entry.tool_use_id : undefined, bytes: Buffer.byteLength(text) });
  }
  return out;
}

function parseClaudeOutputLenient(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    return [JSON.parse(trimmed)];
  } catch {
    const out: unknown[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate.startsWith("{")) continue;
      try {
        out.push(JSON.parse(candidate));
      } catch {
        // Ignore malformed metadata lines.
      }
    }
    return out;
  }
}

function compactReason(reason: string): string {
  const compact = reason.replace(/\s+/g, " ").trim();
  if (/max[-\s]?turns|turn limit|maximum turns|reached.*turn/i.test(compact)) return "error_max_turns";
  if (/budget|cost|spend/i.test(compact)) return "error_max_budget_usd";
  return compact.slice(0, 120);
}

function errorDetailsFromUnknown(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {};
  const details = (error as { details?: unknown }).details;
  return details && typeof details === "object" ? details as Record<string, unknown> : {};
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
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
