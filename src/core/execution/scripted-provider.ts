import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ExecutionError } from "./errors.js";
import type { ExecutionProvider } from "./provider.js";
import type {
  ExecutionCapabilities,
  ExecutionHandle,
  ExecutionStatus,
  ExecutionValidationResult,
  PhaseExecutionInput,
  PhaseExecutionResult,
  ScopeDeviation
} from "./types.js";

export type ScriptedPhaseResult = PhaseExecutionResult["status"];

export interface ScriptedEdit {
  path: string;
  content?: string;
  delete?: boolean;
  untracked?: boolean;
}

export interface ScriptedPhase {
  edits?: ScriptedEdit[];
  validation?: ExecutionValidationResult[];
  result?: ScriptedPhaseResult;
  summary?: string;
  criteria?: "all-met" | "missing" | "uncertain";
  assumptions?: string[];
  scopeDeviations?: Array<string | ScopeDeviation>;
  remainingRisks?: string[];
  sleepMs?: number;
  heartbeat?: boolean;
  stopHeartbeating?: boolean;
  malformedEvidence?: boolean;
  diagnostics?: Record<string, unknown>;
}

interface ScriptedExecution {
  input: PhaseExecutionInput;
  handle: ExecutionHandle;
  script: ScriptedPhase;
  readyAt: number;
  cancelled: boolean;
  dispatchedAt: number;
}

export class ScriptedExecutionProvider implements ExecutionProvider {
  readonly id = "scripted";
  private executions = new Map<string, ScriptedExecution>();

  constructor(private readonly scripts: Record<string, ScriptedPhase> = {}, private readonly clock: () => number = () => Date.now()) {}

  async capabilities(): Promise<ExecutionCapabilities> {
    return {
      parallel: true,
      cancellation: true,
      heartbeats: true,
      structuredResults: true,
      diagnostics: ["scripted deterministic file edits", "scripted status and result outcomes"]
    };
  }

  async dispatch(input: PhaseExecutionInput): Promise<ExecutionHandle> {
    const script = this.scripts[input.phaseId] ?? { result: "completed", criteria: "all-met", validation: [] };
    if (script.result === "failed" && script.summary === "provider_unavailable") {
      throw new ExecutionError("provider_unavailable", "Scripted provider is unavailable.");
    }
    await this.applyEdits(input.workspacePath, script.edits ?? []);
    const id = `scripted-${input.workflowId}-${input.phaseId}-${randomUUID().slice(0, 12)}`;
    const handle: ExecutionHandle = {
      providerId: this.id,
      providerExecutionId: id,
      workflowId: input.workflowId,
      phaseId: input.phaseId,
      leaseOwnerId: input.leaseOwnerId,
      workspacePath: input.workspacePath,
      startedAt: new Date(this.clock()).toISOString(),
      lastKnownStatus: "running",
      providerMetadata: {
        scripted: true,
        readyAt: this.clock() + (script.sleepMs ?? 0),
        stopHeartbeating: Boolean(script.stopHeartbeating),
        heartbeat: script.heartbeat,
        result: script.malformedEvidence ? undefined : this.buildResult(input, script)
      }
    };
    this.executions.set(id, {
      input,
      handle,
      script,
      readyAt: this.clock() + (script.sleepMs ?? 0),
      cancelled: false,
      dispatchedAt: this.clock()
    });
    return handle;
  }

  async getStatus(handle: ExecutionHandle): Promise<ExecutionStatus> {
    const execution = this.executions.get(handle.providerExecutionId) ?? this.executionFromHandle(handle);
    if (execution.cancelled) return { status: "cancelled", message: "Scripted execution was cancelled." };
    if (this.clock() < execution.readyAt) {
      return {
        status: "running",
        heartbeatAt: execution.script.stopHeartbeating ? undefined : new Date(this.clock()).toISOString(),
        message: "Scripted execution is running."
      };
    }
    return {
      status: execution.script.result === "blocked" ? "blocked" : execution.script.result === "timed_out" ? "timed_out" : execution.script.result ?? "completed",
      heartbeatAt: execution.script.heartbeat === false || execution.script.stopHeartbeating ? undefined : new Date(this.clock()).toISOString(),
      message: execution.script.summary
    };
  }

  async collectResult(handle: ExecutionHandle): Promise<PhaseExecutionResult> {
    const execution = this.executions.get(handle.providerExecutionId) ?? this.executionFromHandle(handle);
    if (execution.script.malformedEvidence) {
      throw new ExecutionError("result_malformed", "Scripted provider returned malformed evidence.");
    }
    if (execution.cancelled) {
      return {
        status: "cancelled",
        summary: "Scripted execution cancelled.",
        changedFiles: [],
        validation: [],
        criterionEvidence: [],
        assumptions: [],
        scopeDeviations: [],
        remainingRisks: []
      };
    }
    return this.buildResult(execution.input, execution.script);
  }

  async cancel(handle: ExecutionHandle, _reason?: string): Promise<void> {
    const execution = this.executions.get(handle.providerExecutionId);
    if (!execution) return;
    execution.cancelled = true;
  }

  private async applyEdits(workspacePath: string, edits: ScriptedEdit[]): Promise<void> {
    for (const edit of edits) {
      const target = path.resolve(workspacePath, edit.path);
      const relative = path.relative(workspacePath, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new ExecutionError("workspace_mismatch", `Scripted edit escapes workspace: ${edit.path}`);
      }
      if (edit.delete) {
        await rm(target, { force: true, recursive: true });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, edit.content ?? "", "utf8");
    }
  }

  private executionFromHandle(handle: ExecutionHandle): ScriptedExecution {
    const metadata = handle.providerMetadata as { readyAt?: unknown; result?: unknown; stopHeartbeating?: unknown; heartbeat?: unknown } | undefined;
    if (!metadata || metadata.result === undefined) throw new ExecutionError("execution_not_found", `Unknown scripted execution: ${handle.providerExecutionId}`);
    const result = metadata.result as PhaseExecutionResult;
    return {
      input: {
        workflowId: handle.workflowId,
        workflowRevision: 0,
        phaseId: handle.phaseId,
        objective: "",
        acceptanceCriteria: result.criterionEvidence.map((criterion) => criterion.criterion),
        dependencies: [],
        selectedMode: "standard",
        modelTier: "inherit",
        workspacePath: handle.workspacePath,
        repositoryRoot: handle.workspacePath,
        allowedReadAreas: [],
        allowedWriteAreas: [],
        methodologyReferences: [],
        validationExpectations: result.validation.map((entry) => entry.command),
        leaseOwnerId: handle.leaseOwnerId,
        timeoutSeconds: 0,
        userRequest: "",
        planContext: "",
        safetyInstructions: []
      },
      handle,
      script: {
        result: result.status,
        summary: result.summary,
        validation: result.validation,
        assumptions: result.assumptions,
        scopeDeviations: result.scopeDeviations,
        remainingRisks: result.remainingRisks,
        stopHeartbeating: Boolean(metadata.stopHeartbeating),
        heartbeat: typeof metadata.heartbeat === "boolean" ? metadata.heartbeat : undefined
      },
      readyAt: typeof metadata.readyAt === "number" ? metadata.readyAt : this.clock(),
      cancelled: false,
      dispatchedAt: Date.parse(handle.startedAt)
    };
  }

  private buildResult(input: PhaseExecutionInput, script: ScriptedPhase): PhaseExecutionResult {
    const criteriaMode = script.criteria ?? "all-met";
    return {
      status: script.result ?? "completed",
      summary: script.summary ?? `Scripted result for ${input.phaseId}.`,
      changedFiles: (script.edits ?? []).map((edit) => edit.path).sort(),
      validation: script.validation ?? [],
      criterionEvidence: criteriaMode === "missing"
        ? []
        : input.acceptanceCriteria.map((criterion) => ({
          criterion,
          status: criteriaMode === "uncertain" ? "uncertain" : "met",
          evidence: criteriaMode === "uncertain" ? ["Scripted evidence is uncertain."] : [`Scripted evidence for ${input.phaseId}.`]
        })),
      assumptions: script.assumptions ?? [],
      scopeDeviations: (script.scopeDeviations ?? []).map((deviation) => typeof deviation === "string" ? { reason: deviation } : deviation),
      remainingRisks: script.remainingRisks ?? [],
      providerDiagnostics: script.diagnostics
    };
  }
}
