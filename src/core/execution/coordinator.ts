import type { LeanRigorConfig } from "../../config/schema.js";
import {
  completePhase,
  heartbeatPhase,
  integratePhase,
  integrationStatus,
  leasePhase,
  loadFlowState,
  recoverLeases,
  releasePhase,
  updateFlowState,
  validateIntegration,
  workspaceCreatePhase,
  workspaceInit
} from "../flow.js";
import { calculateReadyPhases, dependencyIds } from "../scheduler.js";
import type { PhaseExecutionRecord, PhaseExecutionRecordStatus, SequentialWorkflowState, WorkflowPhase } from "../types.js";
import type { ExecutionProvider } from "./provider.js";
import type { CoordinatorResult, DispatchSummary, ExecutionHandle, ExecutionNextAction, PhaseExecutionInput, PhaseExecutionResult } from "./types.js";
import { toValidationEvidence } from "./types.js";

const ACTIVE_EXECUTION_STATUSES = new Set<PhaseExecutionRecordStatus>(["dispatching", "running", "collecting"]);

export interface ExecutionCoordinatorOptions {
  root: string;
  workflowId: string;
  config: LeanRigorConfig;
  provider: ExecutionProvider;
  coordinatorId?: string;
  clock?: () => Date;
}

export class ExecutionCoordinator {
  private readonly root: string;
  private readonly workflowId: string;
  private readonly config: LeanRigorConfig;
  private readonly provider: ExecutionProvider;
  private readonly coordinatorId: string;
  private readonly clock: () => Date;

  constructor(options: ExecutionCoordinatorOptions) {
    this.root = options.root;
    this.workflowId = options.workflowId;
    this.config = options.config;
    this.provider = options.provider;
    this.coordinatorId = options.coordinatorId ?? `lr-coordinator-${process.pid}`;
    this.clock = options.clock ?? (() => new Date());
  }

  async runNext(): Promise<CoordinatorResult> {
    const before = await loadFlowState(this.root, this.workflowId);
    if (this.activeRecords(before).length > 0) return this.poll();
    const dispatched = await this.dispatchReady();
    if (dispatched.dispatched.length > 0) return dispatched;
    return this.poll();
  }

  async runUntilGate(maxIterations = 20): Promise<CoordinatorResult> {
    let result = await this.runNext();
    for (let i = 0; i < maxIterations && ["dispatch", "poll", "validate_integration"].includes(result.nextAction); i += 1) {
      if (result.nextAction === "poll") result = await this.poll();
      else result = await this.runNext();
      if (result.running.length > 0) break;
    }
    return result;
  }

  async dispatchReady(): Promise<CoordinatorResult> {
    await this.provider.capabilities();
    let state = await loadFlowState(this.root, this.workflowId);
    if (state.state !== "executing") return this.result(state, [], this.nextActionForState(state), "Workflow is not in an executable state.");
    if (!state.git) state = await workspaceInit({ root: this.root, workflowId: this.workflowId, config: this.config, mutation: { ownerId: this.coordinatorId, ownerType: "system" } });

    const selected = this.selectDispatchable(state);
    const dispatched: DispatchSummary[] = [];
    for (const phase of selected) {
      const ownerId = this.ownerId(phase.id);
      try {
        await leasePhase({ root: this.root, workflowId: this.workflowId, phaseId: phase.id, ownerId, ownerType: "agent", config: this.config, mutation: { ownerId } });
        const withWorkspace = await workspaceCreatePhase({ root: this.root, workflowId: this.workflowId, phaseId: phase.id, ownerId, config: this.config, mutation: { ownerId } });
        const workspace = withWorkspace.git?.phaseWorkspaces[phase.id];
        if (!workspace) throw new Error(`Phase ${phase.id} workspace was not created.`);
        const input = this.inputForPhase(withWorkspace, phase.id, workspace.path, ownerId);
        const handle = await this.provider.dispatch(input);
        await this.persistHandle(handle);
        dispatched.push({ phaseId: phase.id, provider: handle.providerId, status: "running", workspacePath: workspace.path, leaseOwnerId: ownerId });
      } catch (error) {
        await this.markPhaseStopped(phase.id, ownerId, "failed", `Dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const current = await loadFlowState(this.root, this.workflowId);
    return this.result(current, dispatched, dispatched.length > 0 ? "poll" : this.nextActionForState(current), dispatched.length > 0 ? "Dispatched ready phase execution." : "No phase was dispatchable.");
  }

  async poll(): Promise<CoordinatorResult> {
    let state = await loadFlowState(this.root, this.workflowId);
    const records = this.activeRecords(state).filter((record) => record.providerId === this.provider.id);
    const completed: DispatchSummary[] = [];
    const blocked: Array<{ phaseId: string; reason: string }> = [];

    for (const record of records) {
      const handle = this.handleFromRecord(record, state.id);
      const elapsedMs = this.clock().getTime() - Date.parse(record.startedAt);
      if (elapsedMs > this.config.execution.workerTimeoutSeconds * 1000) {
        await this.provider.cancel(handle, "worker timeout").catch(() => undefined);
        await this.markPhaseStopped(record.phaseId, record.leaseOwnerId, "timed_out", "Execution timed out; workspace preserved for review.");
        blocked.push({ phaseId: record.phaseId, reason: "Execution timed out." });
        continue;
      }

      const status = await this.provider.getStatus(handle);
      if (status.status === "running" || status.status === "queued") {
        if (status.heartbeatAt) {
          await heartbeatPhase({ root: this.root, workflowId: this.workflowId, phaseId: record.phaseId, ownerId: record.leaseOwnerId, config: this.config, mutation: { ownerId: record.leaseOwnerId } });
          await this.updateRecord(record.phaseId, { status: "running", heartbeatAt: status.heartbeatAt, diagnostics: status.diagnostics });
        } else if (this.missingHeartbeatExpired(record)) {
          await this.markPhaseStopped(record.phaseId, record.leaseOwnerId, "failed", "Provider heartbeat was missing beyond the grace window.");
          blocked.push({ phaseId: record.phaseId, reason: "Provider heartbeat missing." });
        }
        continue;
      }

      if (status.status === "unknown") {
        await this.markPhaseStopped(record.phaseId, record.leaseOwnerId, "failed", "Provider no longer knows this execution.");
        blocked.push({ phaseId: record.phaseId, reason: "Execution not found by provider." });
        continue;
      }

      await this.updateRecord(record.phaseId, { status: "collecting", diagnostics: status.diagnostics });
      const result = await this.provider.collectResult(handle);
      const accepted = await this.recordResult(record, result);
      completed.push({ phaseId: record.phaseId, provider: record.providerId, status: accepted, workspacePath: record.workspacePath, leaseOwnerId: record.leaseOwnerId });
      if (accepted !== "result_recorded") blocked.push({ phaseId: record.phaseId, reason: result.summary });
    }

    state = await this.progressDeterministicTransitions();
    return this.result(state, completed, this.nextActionForState(state), completed.length > 0 ? "Execution polling collected results." : "Execution polling completed.");
  }

  async cancelPhase(phaseId: string, reason = "Cancelled by user."): Promise<CoordinatorResult> {
    const state = await loadFlowState(this.root, this.workflowId);
    const record = state.execution.records[phaseId];
    if (record && ACTIVE_EXECUTION_STATUSES.has(record.status)) {
      await this.provider.cancel(this.handleFromRecord(record, state.id), reason).catch(() => undefined);
      await this.markPhaseStopped(phaseId, record.leaseOwnerId, "cancelled", reason);
    }
    const current = await loadFlowState(this.root, this.workflowId);
    return this.result(current, [], this.nextActionForState(current), `Phase ${phaseId} cancellation recorded.`);
  }

  async recover(): Promise<CoordinatorResult> {
    await recoverLeases({ root: this.root, workflowId: this.workflowId, now: this.clock(), mutation: { ownerId: this.coordinatorId, ownerType: "system" } });
    const state = await loadFlowState(this.root, this.workflowId);
    for (const record of this.activeRecords(state)) {
      const lease = state.phaseLeases[record.phaseId];
      if (!lease || lease.releasedAt || lease.ownerId !== record.leaseOwnerId) {
        await this.updateRecord(record.phaseId, { status: "failed", completedAt: this.now(), resultSummary: "Execution lease was lost during recovery." });
      }
    }
    const current = await loadFlowState(this.root, this.workflowId);
    return this.result(current, [], this.nextActionForState(current), "Execution recovery completed.");
  }

  executionStatus(state: SequentialWorkflowState): CoordinatorResult {
    return this.result(state, [], this.nextActionForState(state), "Execution status loaded.");
  }

  private selectDispatchable(state: SequentialWorkflowState): WorkflowPhase[] {
    if (!state.plan) return [];
    const active = this.activeRecords(state).length;
    const slots = Math.max(0, this.config.execution.maxParallelPhases - active);
    if (slots === 0) return [];
    const activePhaseIds = new Set(this.activeRecords(state).map((record) => record.phaseId));
    const selected: WorkflowPhase[] = [];
    const schedule = calculateReadyPhases(state, this.config);
    for (const ready of schedule.readyPhases) {
      if (selected.length >= slots) break;
      if (ready.blockedBy.length > 0) continue;
      if (ready.conflictsWith.some((conflict) => activePhaseIds.has(conflict.phaseA) || activePhaseIds.has(conflict.phaseB))) continue;
      if (ready.conflictsWith.some((conflict) => selected.some((phase) => phase.id === conflict.phaseA || phase.id === conflict.phaseB))) continue;
      const phase = state.plan.phases.find((candidate) => candidate.id === ready.phaseId);
      if (phase) selected.push(phase);
    }
    return selected;
  }

  private async recordResult(record: PhaseExecutionRecord, result: PhaseExecutionResult): Promise<PhaseExecutionRecordStatus> {
    if (result.status === "completed" || result.status === "blocked") {
      if (result.status === "blocked") {
        await completePhase({
          root: this.root,
          workflowId: this.workflowId,
          phaseId: record.phaseId,
          config: this.config,
          blockedReason: result.summary,
          mutation: { ownerId: record.leaseOwnerId }
        });
        await this.updateRecord(record.phaseId, { status: "blocked", completedAt: this.now(), resultSummary: result.summary, diagnostics: result.providerDiagnostics });
        return "blocked";
      }
      const validation = result.validation.map((entry) => toValidationEvidence(record.phaseId, entry));
      await completePhase({
        root: this.root,
        workflowId: this.workflowId,
        phaseId: record.phaseId,
        config: this.config,
        criteria: result.criterionEvidence,
        filesChanged: result.changedFiles,
        commandsRun: result.validation.map((entry) => entry.command),
        validation,
        scopeDeviations: result.scopeDeviations.map((deviation) => deviation.path ? `${deviation.path}: ${deviation.reason}` : deviation.reason),
        assumptions: result.assumptions,
        remainingRisks: result.remainingRisks,
        mutation: { ownerId: record.leaseOwnerId }
      });
      await this.updateRecord(record.phaseId, { status: "result_recorded", completedAt: this.now(), resultSummary: result.summary, diagnostics: result.providerDiagnostics });
      return "result_recorded";
    }
    await this.markPhaseStopped(record.phaseId, record.leaseOwnerId, result.status, result.summary, result.providerDiagnostics);
    return result.status;
  }

  private async progressDeterministicTransitions(): Promise<SequentialWorkflowState> {
    let state = await loadFlowState(this.root, this.workflowId);
    const completed = state.plan?.phases.filter((phase) => phase.status === "completed") ?? [];
    for (const phase of completed.sort((a, b) => a.id.localeCompare(b.id))) {
      const status = integrationStatus(state);
      if (status.integratedPhaseIds.includes(phase.id) || status.conflictedPhaseIds.includes(phase.id)) continue;
      const result = await integratePhase({ root: this.root, workflowId: this.workflowId, phaseId: phase.id, ownerId: this.coordinatorId, mutation: { ownerId: this.coordinatorId, ownerType: "system" } });
      state = result.state;
      if (!result.ok) return state;
    }
    const currentStatus = integrationStatus(state);
    const allComplete = Boolean(state.plan?.phases.length && state.plan.phases.every((phase) => phase.status === "completed"));
    if (allComplete && currentStatus.pendingPhaseIds.length === 0 && currentStatus.conflictedPhaseIds.length === 0 && !currentStatus.finalReviewEligible) {
      state = await validateIntegration({ root: this.root, workflowId: this.workflowId, mutation: { ownerId: this.coordinatorId, ownerType: "system" } });
    }
    return state;
  }

  private async persistHandle(handle: ExecutionHandle): Promise<void> {
    await updateFlowState(this.root, this.workflowId, (state) => {
      state.execution.coordinatorId = this.coordinatorId;
      state.execution.records[handle.phaseId] = {
        phaseId: handle.phaseId,
        providerId: handle.providerId,
        providerExecutionId: handle.providerExecutionId,
        leaseOwnerId: handle.leaseOwnerId,
        workspacePath: handle.workspacePath,
        status: "running",
        startedAt: handle.startedAt,
        heartbeatAt: handle.startedAt,
        providerMetadata: handle.providerMetadata
      };
      return state;
    }, { ownerId: this.coordinatorId, ownerType: "system", operation: "execution_handle_persist" });
  }

  private async updateRecord(phaseId: string, patch: Partial<PhaseExecutionRecord>): Promise<void> {
    await updateFlowState(this.root, this.workflowId, (state) => {
      const existing = state.execution.records[phaseId];
      if (existing) state.execution.records[phaseId] = { ...existing, ...patch };
      return state;
    }, { ownerId: this.coordinatorId, ownerType: "system", operation: "execution_record_update" });
  }

  private async markPhaseStopped(phaseId: string, ownerId: string, status: "failed" | "cancelled" | "timed_out" | "blocked", summary: string, diagnostics?: Record<string, unknown>): Promise<void> {
    await updateFlowState(this.root, this.workflowId, (state) => {
      const phase = state.plan?.phases.find((candidate) => candidate.id === phaseId);
      const lease = state.phaseLeases[phaseId];
      if (lease && !lease.releasedAt && lease.ownerId === ownerId) state.phaseLeases[phaseId] = { ...lease, releasedAt: this.now() };
      if (phase && phase.status !== "completed") phase.status = status === "cancelled" ? "cancelled" : "needs_review";
      const workspace = state.git?.phaseWorkspaces[phaseId];
      if (workspace) state.git!.phaseWorkspaces[phaseId] = { ...workspace, status: status === "cancelled" ? "abandoned" : "needs_repair", updatedAt: this.now() };
      const existing = state.execution.records[phaseId];
      if (existing) {
        state.execution.records[phaseId] = {
          ...existing,
          status,
          completedAt: this.now(),
          resultSummary: summary,
          diagnostics
        };
      }
      return state;
    }, { ownerId: this.coordinatorId, ownerType: "system", operation: "execution_phase_stopped" });
    if (status === "cancelled") {
      await releasePhase({ root: this.root, workflowId: this.workflowId, phaseId, ownerId, mutation: { ownerId } }).catch(() => undefined);
    }
  }

  private inputForPhase(state: SequentialWorkflowState, phaseId: string, workspacePath: string, ownerId: string): PhaseExecutionInput {
    const phase = state.plan?.phases.find((candidate) => candidate.id === phaseId);
    if (!phase || !state.git || !state.plan) throw new Error(`Cannot build execution input for ${phaseId}.`);
    return {
      workflowId: state.id,
      workflowRevision: state.revision,
      phaseId: phase.id,
      objective: phase.objective,
      acceptanceCriteria: phase.acceptanceCriteria,
      dependencies: dependencyIds(phase),
      selectedMode: state.mode,
      modelTier: phase.modelTier,
      workspacePath,
      repositoryRoot: state.git.context.repositoryRoot,
      allowedReadAreas: phase.expectedReadAreas,
      allowedWriteAreas: phase.expectedWriteAreas.length > 0 ? phase.expectedWriteAreas : phase.expectedFilesOrAreas,
      methodologyReferences: [`methodology/modes/${state.mode}.md`, "methodology/evidence.md", "methodology/safeguards.md"],
      validationExpectations: phase.validationCommands,
      leaseOwnerId: ownerId,
      timeoutSeconds: this.config.execution.workerTimeoutSeconds,
      userRequest: state.request,
      planContext: state.plan.summary,
      safetyInstructions: [
        "Use only the assigned phase workspace.",
        "Return structured result evidence; LeanRigor will decide whether the phase is accepted.",
        "Do not commit, push, merge, deploy, or edit outside the workspace."
      ]
    };
  }

  private handleFromRecord(record: PhaseExecutionRecord, workflowId: string): ExecutionHandle {
    return {
      providerId: record.providerId,
      providerExecutionId: record.providerExecutionId,
      workflowId,
      phaseId: record.phaseId,
      leaseOwnerId: record.leaseOwnerId,
      workspacePath: record.workspacePath,
      startedAt: record.startedAt,
      lastKnownStatus: record.status,
      providerMetadata: record.providerMetadata
    };
  }

  private activeRecords(state: SequentialWorkflowState): PhaseExecutionRecord[] {
    return Object.values(state.execution.records).filter((record) => ACTIVE_EXECUTION_STATUSES.has(record.status));
  }

  private missingHeartbeatExpired(record: PhaseExecutionRecord): boolean {
    const heartbeatAt = record.heartbeatAt ?? record.startedAt;
    return this.clock().getTime() - Date.parse(heartbeatAt) > this.config.execution.heartbeatGraceSeconds * 1000;
  }

  private ownerId(phaseId: string): string {
    return `lr-exec-${this.workflowId}-${this.provider.id}-${phaseId}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
  }

  private result(state: SequentialWorkflowState, dispatched: DispatchSummary[], nextAction: ExecutionNextAction, message: string): CoordinatorResult {
    const records = Object.values(state.execution.records);
    return {
      workflowId: state.id,
      revision: state.revision,
      state: state.state,
      running: records.filter((record) => ACTIVE_EXECUTION_STATUSES.has(record.status)).map((record) => ({ phaseId: record.phaseId, provider: record.providerId, status: record.status })),
      completed: records.filter((record) => ["completed", "result_recorded"].includes(record.status)).map((record) => ({ phaseId: record.phaseId, provider: record.providerId, status: record.status })),
      blocked: [
        ...records.filter((record) => ["failed", "cancelled", "timed_out", "blocked"].includes(record.status)).map((record) => ({ phaseId: record.phaseId, reason: record.resultSummary ?? record.status })),
        ...state.blockers.map((reason) => ({ phaseId: "workflow", reason }))
      ],
      dispatched,
      nextAction,
      message
    };
  }

  private nextActionForState(state: SequentialWorkflowState): ExecutionNextAction {
    if (this.activeRecords(state).length > 0) return "poll";
    const status = integrationStatus(state);
    if (status.conflictedPhaseIds.length > 0) return "resolve_conflict";
    if (state.state === "awaiting_commit_approval") return "commit_proposal";
    if (state.state === "reviewing") return "final_review";
    if (state.state === "validating") return "validate_integration";
    if (state.state !== "executing") return state.state === "completed" ? "complete" : "await_user";
    const phase = state.plan?.phases.find((candidate) => ["needs_repair", "needs_review", "needs_replan", "blocked"].includes(candidate.status));
    if (phase?.status === "needs_repair") return "repair";
    if (phase?.status === "needs_review") return "review";
    if (phase?.status === "needs_replan") return "replan";
    if (phase?.status === "blocked") return "await_user";
    if (this.selectDispatchable(state).length > 0) return "dispatch";
    return "await_user";
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
