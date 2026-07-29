import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LeanRigorConfig } from "../../config/schema.js";
import { preparePhaseWorkspace } from "../workspace-preparation.js";
import {
  dependencyReadyCandidates,
  evaluatePhaseDispatchEligibility,
  PHASE_PREPARATION_CAPABILITY,
} from "../dispatch-eligibility.js";
import { briefIsCurrent, briefStalenessReasons } from "../approval.js";
import { supplementalValidationCommands } from "../validation-policy.js";
import { adviseSupplementalValidation } from "../validation-advisory.js";
import {
  completePhase,
  heartbeatPhase,
  integratePhase,
  integrationStatus,
  leasePhase,
  loadFlowState,
  preparePhaseExecutionBrief,
  recoverLeases,
  releasePhase,
  updateFlowState,
  validateIntegration,
  workspaceCreatePhase,
  workspaceInit
} from "../flow.js";
import type { PhaseExecutionRecord, PhaseExecutionRecordStatus, SequentialWorkflowState, WorkflowPhase } from "../types.js";
import { requirePendingDecision, resolvePendingDecision, setPendingDecision } from "../workflow-decision.js";
import { phaseResultView, workflowDecisionEnvelope } from "../workflow-envelope.js";
import type { ExecutionProvider } from "./provider.js";
import type { StructuredDecisionProvider } from "../structured-decision.js";
import type { CoordinatorResult, DispatchSummary, ExecutionHandle, ExecutionNextAction, PhaseExecutionInput, PhaseExecutionResult, PhaseWorkspaceCheckpoint, ProviderSessionRef, ProviderSessionStatus } from "./types.js";
import { toValidationEvidence } from "./types.js";

const ACTIVE_EXECUTION_STATUSES = new Set<PhaseExecutionRecordStatus>(["dispatching", "running", "collecting"]);
const execFileAsync = promisify(execFile);
const CHECKPOINT_DIFF_BYTES = 32 * 1024;

export interface ExecutionCoordinatorOptions {
  root: string;
  workflowId: string;
  config: LeanRigorConfig;
  provider: ExecutionProvider;
  validationAdvisor?: StructuredDecisionProvider;
  coordinatorId?: string;
  clock?: () => Date;
}

export class ExecutionCoordinator {
  private readonly root: string;
  private readonly workflowId: string;
  private readonly config: LeanRigorConfig;
  private readonly provider: ExecutionProvider;
  private readonly validationAdvisor?: StructuredDecisionProvider;
  private readonly coordinatorId: string;
  private readonly clock: () => Date;

  constructor(options: ExecutionCoordinatorOptions) {
    this.root = options.root;
    this.workflowId = options.workflowId;
    this.config = options.config;
    this.provider = options.provider;
    this.validationAdvisor = options.validationAdvisor;
    this.coordinatorId = options.coordinatorId ?? `lr-coordinator-${process.pid}`;
    this.clock = options.clock ?? (() => new Date());
  }

  async runNext(): Promise<CoordinatorResult> {
    const before = await loadFlowState(this.root, this.workflowId);
    if (before.approval?.pendingDecision?.status === "pending" || Object.keys(before.phaseBriefFailures ?? {}).length > 0) {
      return this.result(before, [], "await_user", "A valid Phase Execution Brief and exact approval are required before coordinator execution.");
    }
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
    let state = await loadFlowState(this.root, this.workflowId);
    if (state.approval?.pendingDecision?.status === "pending" || Object.keys(state.phaseBriefFailures ?? {}).length > 0) {
      return this.result(state, [], "await_user", "A valid Phase Execution Brief and exact approval are required before coordinator execution.");
    }
    if (state.state !== "executing") return this.result(state, [], this.nextActionForState(state), "Workflow is not in an executable state.");
    const staleBrief = dependencyReadyCandidates(state).find((phase) => state.phaseBriefs?.[phase.id] && !briefIsCurrent(state, phase.id));
    if (staleBrief) {
      state = await preparePhaseExecutionBrief({
        root: this.root,
        workflowId: this.workflowId,
        phaseId: staleBrief.id,
        config: this.config,
        refresh: true,
        requireApproval: true,
        mutation: { ownerId: this.coordinatorId, ownerType: "system" }
      });
      return this.result(state, [], "await_user", `Phase ${staleBrief.id} brief was stale and has been regenerated for exact reapproval.`);
    }
    const missingBrief = dependencyReadyCandidates(state).find((phase) => !state.phaseBriefs?.[phase.id]);
    if (missingBrief) {
      state = await preparePhaseExecutionBrief({
        root: this.root,
        workflowId: this.workflowId,
        phaseId: missingBrief.id,
        config: this.config,
        requireApproval: true,
        mutation: { ownerId: this.coordinatorId, ownerType: "system" }
      });
      if (state.approval?.pendingDecision || state.phaseBriefFailures?.[missingBrief.id]) {
        return this.result(state, [], "await_user", `Phase ${missingBrief.id} requires a current detailed brief decision before workspace preparation.`);
      }
    }
    await this.provider.capabilities();
    const selected = this.selectPreparationCandidates(state);
    const dispatched: DispatchSummary[] = [];
    for (const phase of selected) {
      const existingLease = state.phaseLeases[phase.id];
      const canUseExistingLease = Boolean(phase.status === "running" && existingLease && !existingLease.releasedAt && Date.parse(existingLease.expiresAt) > this.clock().getTime());
      const ownerId = canUseExistingLease && existingLease ? existingLease.ownerId : this.ownerId(phase.id);
      let providerDispatchStarted = false;
      try {
        const preflight = evaluatePhaseDispatchEligibility(state, phase.id, this.config, {
          stage: "preparation",
          explicitlySelected: true,
          ownerId,
          now: this.clock()
        });
        if (!preflight.eligible) continue;
        if (!state.git) state = await workspaceInit({ root: this.root, workflowId: this.workflowId, config: this.config, mutation: { ownerId: this.coordinatorId, ownerType: "system" } });
        const afterWorkspaceInit = evaluatePhaseDispatchEligibility(state, phase.id, this.config, {
          stage: "preparation",
          explicitlySelected: true,
          ownerId,
          now: this.clock()
        });
        if (!afterWorkspaceInit.eligible) {
          if (afterWorkspaceInit.blockers.some((blocker) => blocker.code.startsWith("brief_"))) {
            state = await preparePhaseExecutionBrief({
              root: this.root,
              workflowId: this.workflowId,
              phaseId: phase.id,
              config: this.config,
              refresh: true,
              requireApproval: true,
              mutation: { ownerId: this.coordinatorId, ownerType: "system" }
            });
          }
          continue;
        }
        if (!canUseExistingLease) {
          await leasePhase({
            root: this.root,
            workflowId: this.workflowId,
            phaseId: phase.id,
            ownerId,
            ownerType: "agent",
            config: this.config,
            internalCapability: PHASE_PREPARATION_CAPABILITY,
            mutation: { ownerId }
          });
        } else {
          await this.reserveResumeDispatch(phase.id, ownerId);
        }
        const withWorkspace = await workspaceCreatePhase({ root: this.root, workflowId: this.workflowId, phaseId: phase.id, ownerId, config: this.config, mutation: { ownerId } });
        const workspace = withWorkspace.git?.phaseWorkspaces[phase.id];
        if (!workspace) throw new Error(`Phase ${phase.id} workspace was not created.`);
        const existingPreparation = workspace.preparation;
        const approvedBootstrap = this.approvedBootstrap(withWorkspace, phase.id);
        const preparationRevision = approvedBootstrap?.preparationRevision
          ?? (existingPreparation?.preparationRevision ?? 0) + 1;
        const preparation = existingPreparation
          && ["available", "prepared"].includes(existingPreparation.status)
          && existingPreparation.preparationRevision
          && existingPreparation.workspaceIdentity
          && existingPreparation.basis?.commit === workspace.baseCommit
          ? existingPreparation
          : await preparePhaseWorkspace({
              workspacePath: workspace.path,
              repositoryRoot: withWorkspace.git!.context.repositoryRoot,
              repositoryIdentity: withWorkspace.git!.context.repositoryIdentity,
              basis: { branch: workspace.branch, commit: workspace.baseCommit },
              validationCommands: withWorkspace.phaseBriefs?.[phase.id]?.validationCommands ?? phase.validationCommands,
              config: this.config,
              preparationRevision,
              approvedBootstrap
            });
        await this.persistWorkspacePreparation(phase.id, preparation);
        if (preparation.status === "blocked" || preparation.status === "failed") {
          await releasePhase({ root: this.root, workflowId: this.workflowId, phaseId: phase.id, ownerId, mutation: { ownerId, ownerType: "system" } });
          state = await loadFlowState(this.root, this.workflowId);
          continue;
        }
        const preparedState = await loadFlowState(this.root, this.workflowId);
        const eligibility = evaluatePhaseDispatchEligibility(preparedState, phase.id, this.config, {
          explicitlySelected: true,
          ownerId,
          now: this.clock()
        });
        if (!eligibility.eligible) {
          await releasePhase({ root: this.root, workflowId: this.workflowId, phaseId: phase.id, ownerId, mutation: { ownerId, ownerType: "system" } });
          state = await loadFlowState(this.root, this.workflowId);
          continue;
        }
        const input = await this.inputForPhase(preparedState, phase.id, workspace.path, ownerId);
        providerDispatchStarted = true;
        const handle = await this.provider.dispatch(input);
        this.assertHandleIdentity(input, handle);
        await this.persistHandle(handle);
        dispatched.push({ phaseId: phase.id, provider: handle.providerId, status: "running", workspacePath: workspace.path, leaseOwnerId: ownerId });
      } catch (error) {
        if (providerDispatchStarted) {
          await this.markPhaseStopped(phase.id, ownerId, "failed", `Dispatch failed: ${error instanceof Error ? error.message : String(error)}`, errorDetails(error));
        } else {
          await releasePhase({ root: this.root, workflowId: this.workflowId, phaseId: phase.id, ownerId, mutation: { ownerId, ownerType: "system" } }).catch(() => undefined);
        }
      }
      state = await loadFlowState(this.root, this.workflowId);
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

      let status;
      try {
        status = await this.provider.getStatus(handle);
      } catch (error) {
        const message = `Provider status failed: ${error instanceof Error ? error.message : String(error)}`;
        await this.markPhaseStopped(record.phaseId, record.leaseOwnerId, "failed", message, errorDetails(error));
        blocked.push({ phaseId: record.phaseId, reason: message });
        continue;
      }
      if (status.status === "running" || status.status === "queued") {
        if (status.heartbeatAt) {
          await heartbeatPhase({ root: this.root, workflowId: this.workflowId, phaseId: record.phaseId, ownerId: record.leaseOwnerId, config: this.config, mutation: { ownerId: record.leaseOwnerId } });
          await this.updateRecord(record.phaseId, { status: "running", heartbeatAt: status.heartbeatAt, diagnostics: mergeDiagnostics(record.diagnostics, status.diagnostics) });
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

      await this.updateRecord(record.phaseId, { status: "collecting", diagnostics: mergeDiagnostics(record.diagnostics, status.diagnostics) });
      let result: PhaseExecutionResult;
      try {
        result = await this.provider.collectResult(handle);
      } catch (error) {
        const message = `Provider result collection failed: ${error instanceof Error ? error.message : String(error)}`;
        await this.markPhaseStopped(record.phaseId, record.leaseOwnerId, "failed", message, errorDetails(error));
        blocked.push({ phaseId: record.phaseId, reason: message });
        continue;
      }
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

  async continueExecution(decisionId: string, expectedRevision: number): Promise<CoordinatorResult> {
    let phaseId = "";
    let ownerId = "";
    await updateFlowState(this.root, this.workflowId, (state) => {
      const decision = requirePendingDecision(state, "execution-recovery", "continue-execution", decisionId);
      if (!decision?.phaseId || !decision.additionalTurns) throw new Error("The current recovery decision does not authorize additional provider turns.");
      const phase = state.plan?.phases.find((candidate) => candidate.id === decision.phaseId);
      const record = state.execution.records[decision.phaseId];
      if (!phase || !record?.checkpoint) throw new Error(`Phase ${decision.phaseId} has no recoverable execution checkpoint.`);
      if (record.diagnostics?.terminalReason !== "error_max_turns") throw new Error(`Phase ${decision.phaseId} did not stop because of the provider turn limit.`);
      if (!briefIsCurrent(state, decision.phaseId)) throw new Error(`Phase ${decision.phaseId} brief is stale; revise or regenerate the brief before continuing.`);
      const initialTurnLimit = record.executionBudget?.initialTurnLimit
        ?? (typeof record.diagnostics?.maxTurns === "number" ? record.diagnostics.maxTurns : this.config.execution.workerControls.maxTurns[state.mode]);
      const extensionTurnLimit = record.executionBudget?.extensionTurnLimit ?? this.config.execution.workerControls.extensionTurns[state.mode];
      const extensionApprovals = record.executionBudget?.extensionApprovals ?? 0;
      if (extensionApprovals >= 1) throw new Error(`Phase ${decision.phaseId} has already used its additional-turn allowance.`);
      if (decision.additionalTurns !== extensionTurnLimit) throw new Error(`Recovery decision turn allowance is stale; expected ${extensionTurnLimit}, received ${decision.additionalTurns}.`);
      phaseId = decision.phaseId;
      ownerId = this.ownerId(phaseId);
      phase.status = "ready";
      record.executionBudget = {
        initialTurnLimit,
        effectiveTurnLimit: extensionTurnLimit,
        extensionTurnLimit,
        extensionApprovals: extensionApprovals + 1,
        cumulativeAuthorizedTurns: initialTurnLimit + extensionTurnLimit,
        attempts: record.executionBudget?.attempts ?? attemptEvidence(record)
      };
      resolvePendingDecision(state, "approved", "continue-execution", "user", decisionId);
      return state;
    }, {
      expectedRevision,
      ownerId: this.coordinatorId,
      ownerType: "system",
      decisionId,
      operation: "execution_continuation_authorized"
    });

    return this.dispatchResumedPhase(phaseId, ownerId, "Continued");
  }

  async retryExecution(decisionId: string, expectedRevision: number): Promise<CoordinatorResult> {
    let phaseId = "";
    let ownerId = "";
    await updateFlowState(this.root, this.workflowId, (state) => {
      const decision = requirePendingDecision(state, "execution-recovery", "retry-execution", decisionId);
      if (!decision?.phaseId) throw new Error("The current recovery decision does not identify a phase to retry.");
      const phase = state.plan?.phases.find((candidate) => candidate.id === decision.phaseId);
      const record = state.execution.records[decision.phaseId];
      if (!phase || !record?.checkpoint) throw new Error(`Phase ${decision.phaseId} has no recoverable execution checkpoint.`);
      if (record.diagnostics?.terminalReason === "error_max_turns") throw new Error(`Phase ${decision.phaseId} requires an explicit additional-turn decision.`);
      if (!briefIsCurrent(state, decision.phaseId)) throw new Error(`Phase ${decision.phaseId} brief is stale; revise or regenerate the brief before retrying.`);
      phaseId = decision.phaseId;
      ownerId = this.ownerId(phaseId);
      phase.status = "ready";
      resolvePendingDecision(state, "approved", "retry-execution", "user", decisionId);
      return state;
    }, {
      expectedRevision,
      ownerId: this.coordinatorId,
      ownerType: "system",
      decisionId,
      operation: "execution_retry_authorized"
    });
    return this.dispatchResumedPhase(phaseId, ownerId, "Retried");
  }

  async discardOutOfScopeAndRetry(decisionId: string, expectedRevision: number): Promise<CoordinatorResult> {
    let phaseId = "";
    let ownerId = "";
    await updateFlowState(this.root, this.workflowId, async (state) => {
      const decision = requirePendingDecision(state, "execution-recovery", "discard-out-of-scope-and-retry", decisionId);
      if (!decision?.phaseId) throw new Error("The current recovery decision does not identify a phase to clean up.");
      const phase = state.plan?.phases.find((candidate) => candidate.id === decision.phaseId);
      const brief = state.phaseBriefs?.[decision.phaseId];
      const workspace = state.git?.phaseWorkspaces[decision.phaseId];
      const record = state.execution.records[decision.phaseId];
      if (!phase || !brief || !workspace || !record?.checkpoint) throw new Error(`Phase ${decision.phaseId} has no recoverable execution checkpoint.`);
      if (!briefIsCurrent(state, decision.phaseId)) throw new Error(`Phase ${decision.phaseId} brief is stale; revise or regenerate the brief before retrying.`);
      const unexpectedWrites = record.checkpoint.changedFiles.filter((file) => !brief.writeAreas.some((area) => pathWithinArea(file, area)));
      if (unexpectedWrites.length === 0) throw new Error(`Phase ${decision.phaseId} has no out-of-scope changes to discard.`);
      await discardOutOfScopeChanges(record.workspacePath, workspace.baseCommit, record.checkpoint, unexpectedWrites);
      const checkpoint = await capturePhaseWorkspaceCheckpoint(record.workspacePath, brief.validationCommands);
      const remainingUnexpected = checkpoint.changedFiles.filter((file) => !brief.writeAreas.some((area) => pathWithinArea(file, area)));
      if (remainingUnexpected.length > 0) {
        throw new Error(`Out-of-scope cleanup was incomplete: ${remainingUnexpected.join(", ")}`);
      }
      phaseId = decision.phaseId;
      ownerId = this.ownerId(phaseId);
      phase.status = "ready";
      workspace.status = "ready";
      workspace.updatedAt = this.now();
      state.execution.records[phaseId] = {
        ...record,
        status: "blocked",
        checkpoint,
        resultSummary: `Discarded out-of-scope changes (${unexpectedWrites.join(", ")}); preserved approved-scope work for a compact retry.`,
        diagnostics: mergeDiagnostics(record.diagnostics, {
          terminalReason: "provider_scope_cleanup",
          discardedOutOfScopeWrites: unexpectedWrites,
          cleanupCompletedAt: this.now(),
          partialProgressPreserved: checkpoint.dirty,
          partialProgressAccepted: false
        }),
        providerSession: updateSessionStatus(record.providerSession, "failed", this.now(), "provider_scope_cleanup")
      };
      resolvePendingDecision(state, "approved", "discard-out-of-scope-and-retry", "user", decisionId);
      return state;
    }, {
      expectedRevision,
      ownerId: this.coordinatorId,
      ownerType: "system",
      decisionId,
      operation: "execution_scope_cleanup_authorized"
    });
    return this.dispatchResumedPhase(phaseId, ownerId, "Cleaned and retried");
  }

  private async dispatchResumedPhase(phaseId: string, ownerId: string, verb: string): Promise<CoordinatorResult> {
    try {
      await leasePhase({
        root: this.root,
        workflowId: this.workflowId,
        phaseId,
        ownerId,
        ownerType: "agent",
        config: this.config,
        mutation: { ownerId: this.coordinatorId, ownerType: "system" }
      });
      const state = await loadFlowState(this.root, this.workflowId);
      const workspace = state.git?.phaseWorkspaces[phaseId];
      if (!workspace) throw new Error(`Phase ${phaseId} workspace is unavailable for continuation.`);
      const input = await this.inputForPhase(state, phaseId, workspace.path, ownerId);
      const handle = await this.provider.dispatch(input);
      this.assertHandleIdentity(input, handle);
      await this.persistHandle(handle);
      const current = await loadFlowState(this.root, this.workflowId);
      return this.result(current, [{ phaseId, provider: handle.providerId, status: "running", workspacePath: handle.workspacePath, leaseOwnerId: ownerId }], "poll", `${verb} ${phaseId} with up to ${input.turnBudget?.effectiveTurnLimit ?? "the approved"} turns.`);
    } catch (error) {
      await this.markPhaseStopped(phaseId, ownerId, "failed", `Continuation dispatch failed: ${error instanceof Error ? error.message : String(error)}`, errorDetails(error));
      const current = await loadFlowState(this.root, this.workflowId);
      return this.result(current, [], "await_user", `Continuation dispatch failed for ${phaseId}; partial work remains unaccepted.`);
    }
  }

  executionStatus(state: SequentialWorkflowState): CoordinatorResult {
    return this.result(state, [], this.nextActionForState(state), "Execution status loaded.");
  }

  private selectPreparationCandidates(state: SequentialWorkflowState): WorkflowPhase[] {
    if (!state.plan) return [];
    const active = this.activeRecords(state).length;
    const slots = Math.max(0, this.config.execution.maxParallelPhases - active);
    if (slots === 0) return [];
    const activePhaseIds = new Set(this.activeRecords(state).map((record) => record.phaseId));
    const resumable = state.plan.phases.find((phase) => {
      if (phase.status !== "running") return false;
      if (activePhaseIds.has(phase.id)) return false;
      const lease = state.phaseLeases[phase.id];
      if (!lease || lease.releasedAt || Date.parse(lease.expiresAt) <= this.clock().getTime()) return false;
      const record = state.execution.records[phase.id];
      if (!record || ACTIVE_EXECUTION_STATUSES.has(record.status) || record.status === "cancelled") return false;
      return phase.repairAttempts.length > 0 && record.checkpoint !== undefined;
    });
    if (resumable) return [resumable];
    const selected: WorkflowPhase[] = [];
    for (const phase of dependencyReadyCandidates(state)) {
      if (selected.length >= slots) break;
      const eligibility = evaluatePhaseDispatchEligibility(state, phase.id, this.config, {
        stage: "preparation",
        explicitlySelected: true,
        now: this.clock()
      });
      if (eligibility.eligible) selected.push(phase);
    }
    return selected;
  }

  private async recordResult(record: PhaseExecutionRecord, result: PhaseExecutionResult): Promise<PhaseExecutionRecordStatus> {
    const checkpoint = await this.captureCheckpoint(record, result);
    const state = await loadFlowState(this.root, this.workflowId);
    const brief = state.phaseBriefs?.[record.phaseId];
    const workspace = state.git?.phaseWorkspaces[record.phaseId];
    const unexpectedWrites = checkpoint.changedFiles.filter((file) => !brief || !brief.writeAreas.some((area) => pathWithinArea(file, area)));
    const identityIssues = executionIdentityIssues(record, result, state);
    if (identityIssues.length > 0) {
      await this.quarantineRecoveryResult(record, checkpoint, `Provider result identity rejected: ${identityIssues.join("; ")}`, "provider_protocol_error", {
        resultIdentity: result.executionIdentity,
        identityIssues,
        unexpectedWrites
      });
      return "blocked";
    }
    const supplementalValidation = supplementalValidationCommands(
      result.validation.map((entry) => entry.command),
      brief?.validationCommands ?? []
    );
    const supplementalValidationAdvisory = this.validationAdvisor && supplementalValidation.length > 0
      ? await adviseSupplementalValidation({
          provider: this.validationAdvisor,
          root: this.root,
          config: this.config,
          approvedCommands: brief?.validationCommands ?? [],
          supplemental: supplementalValidation
        })
      : undefined;
    const reportedScopeExpansion = result.scopeDeviations
      .filter((deviation) => deviation.path && !brief?.writeAreas.some((area) => pathWithinArea(deviation.path!, area)));
    const materialDiscovery = result.discoveredMaterialChanges.filter((change) => change.material);
    if (unexpectedWrites.length > 0 && reportedScopeExpansion.length === 0 && materialDiscovery.length === 0 && result.status !== "needs_replan") {
      await this.quarantineRecoveryResult(
        record,
        checkpoint,
        `Provider wrote outside the approved phase scope: ${unexpectedWrites.join(", ")}. Discard those writes and retry, or revise the plan if they are genuinely required.`,
        "provider_scope_violation",
        { unexpectedWrites, workspaceIdentity: workspace?.preparation?.workspaceIdentity }
      );
      return "blocked";
    }
    if (reportedScopeExpansion.length > 0 || materialDiscovery.length > 0 || result.status === "needs_replan") {
      const reasons = [
        unexpectedWrites.length > 0 ? `Unexpected write paths: ${unexpectedWrites.join(", ")}` : undefined,
        reportedScopeExpansion.length > 0 ? `Reported scope expansion: ${reportedScopeExpansion.map((deviation) => deviation.path).join(", ")}` : undefined,
        materialDiscovery.length > 0 ? `Provider reported ${materialDiscovery.length} material change(s).` : undefined,
        result.status === "needs_replan" ? result.summary : undefined
      ].filter((value): value is string => Boolean(value));
      await this.quarantineResult(record, checkpoint, "needs_replan", reasons.join(" "), {
        unexpectedWrites,
        reportedScopeExpansion,
        discoveredMaterialChanges: result.discoveredMaterialChanges,
        workspaceIdentity: workspace?.preparation?.workspaceIdentity
      });
      return "blocked";
    }
    if (result.status === "needs_review") {
      await this.quarantineResult(record, checkpoint, "needs_review", result.summary, { discoveredMaterialChanges: result.discoveredMaterialChanges });
      return "blocked";
    }
    const diagnostics = mergeDiagnostics(record.diagnostics, result.providerDiagnostics, {
      checkpoint,
      changedFileReconciliation: reconcileChangedFiles(result.changedFiles, checkpoint.changedFiles),
      supplementalValidation: supplementalValidation.length > 0 ? {
        commands: supplementalValidation,
        advisory: supplementalValidationAdvisory
      } : undefined
    });
    if (result.status === "completed" || result.status === "blocked") {
      if (result.status === "blocked") {
        await completePhase({
          root: this.root,
          workflowId: this.workflowId,
          phaseId: record.phaseId,
          config: this.config,
          blockedReason: result.summary,
          mutation: { ownerId: record.leaseOwnerId, ownerType: "system" }
        });
        await this.updateRecord(record.phaseId, {
          status: "blocked",
          completedAt: this.now(),
          resultSummary: result.summary,
          diagnostics,
          checkpoint,
          executionBudget: finalizeExecutionBudget(record, diagnostics, this.config, state.mode, this.now())
        });
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
        mutation: { ownerId: record.leaseOwnerId, ownerType: "system" }
      });
      await this.updateRecord(record.phaseId, {
        status: "result_recorded",
        completedAt: this.now(),
        resultSummary: result.summary,
        diagnostics,
        checkpoint,
        executionBudget: finalizeExecutionBudget(record, diagnostics, this.config, state.mode, this.now()),
        providerSession: updateSessionStatus(record.providerSession, "completed", this.now())
      });
      return "result_recorded";
    }
    if (shouldAutomaticallyRetryUnavailableSession(record, diagnostics)) {
      await this.markPhaseStopped(record.phaseId, record.leaseOwnerId, "failed", result.summary, diagnostics);
      await this.retryUnavailableSessionInFreshContext(record.phaseId);
      return "running";
    }
    await this.markPhaseStopped(record.phaseId, record.leaseOwnerId, result.status, result.summary, diagnostics);
    return result.status;
  }

  /**
   * A continuation authorised by the user may first attempt to resume the
   * provider's native session. That session is optional provider state: if it
   * has disappeared, preserve the checkpoint and spend the already-authorised
   * continuation allowance in one fresh compact session instead of asking the
   * user to repeat the same recovery decision.
   */
  private async retryUnavailableSessionInFreshContext(phaseId: string): Promise<void> {
    let ownerId = "";
    await updateFlowState(this.root, this.workflowId, (state) => {
      const record = state.execution.records[phaseId];
      const phase = state.plan?.phases.find((candidate) => candidate.id === phaseId);
      const decision = state.approval?.pendingDecision;
      if (!record?.checkpoint || !phase || !briefIsCurrent(state, phaseId)) {
        throw new Error(`Phase ${phaseId} cannot automatically retry because its approved checkpoint is no longer current.`);
      }
      if (!shouldAutomaticallyRetryUnavailableSession(record, record.diagnostics)) {
        throw new Error(`Phase ${phaseId} is not eligible for an automatic fresh-session retry.`);
      }
      if (!decision || decision.type !== "execution-recovery" || decision.phaseId !== phaseId || !decision.allowedActions.includes("retry-execution")) {
        throw new Error(`Phase ${phaseId} has no compatible recovery decision for an automatic fresh-session retry.`);
      }
      ownerId = this.ownerId(phaseId);
      phase.status = "ready";
      state.execution.records[phaseId] = {
        ...record,
        diagnostics: mergeDiagnostics(record.diagnostics, {
          automaticCompactRetry: true,
          automaticCompactRetryReason: "provider_session_unavailable"
        })
      };
      resolvePendingDecision(state, "approved", "retry-execution", "system", decision.id);
      return state;
    }, { ownerId: this.coordinatorId, ownerType: "system", operation: "execution_session_unavailable_compact_retry" });
    await this.dispatchResumedPhase(phaseId, ownerId, "Automatically retried after the provider session became unavailable");
  }

  private async quarantineResult(
    record: PhaseExecutionRecord,
    checkpoint: PhaseWorkspaceCheckpoint,
    disposition: "needs_replan" | "needs_review",
    summary: string,
    diagnostics: Record<string, unknown>
  ): Promise<void> {
    await updateFlowState(this.root, this.workflowId, (state) => {
      const phase = state.plan?.phases.find((candidate) => candidate.id === record.phaseId);
      const lease = state.phaseLeases[record.phaseId];
      if (lease && !lease.releasedAt && lease.ownerId === record.leaseOwnerId) lease.releasedAt = this.now();
      if (phase) phase.status = disposition;
      const workspace = state.git?.phaseWorkspaces[record.phaseId];
      if (workspace) workspace.status = "needs_repair";
      state.execution.records[record.phaseId] = {
        ...record,
        status: "blocked",
        completedAt: this.now(),
        resultSummary: summary,
        diagnostics: mergeDiagnostics(record.diagnostics, {
          ...diagnostics,
          resultAccepted: false,
          disposition,
          partialProgressPreserved: checkpoint.dirty,
          partialProgressAccepted: false
        }),
        checkpoint,
        providerSession: updateSessionStatus(record.providerSession, "failed", this.now())
      };
      setPendingDecision(state, {
        type: "material-drift-review",
        phaseId: record.phaseId,
        briefRevision: state.phaseBriefs?.[record.phaseId]?.briefRevision,
        question: summary,
        allowedActions: ["review-material-drift", "revise-plan", "revise-phase-brief", "view-details", "cancel-workflow"]
      });
      return state;
    }, { ownerId: this.coordinatorId, ownerType: "system", operation: "execution_result_quarantined" });
  }

  private async quarantineRecoveryResult(
    record: PhaseExecutionRecord,
    checkpoint: PhaseWorkspaceCheckpoint,
    summary: string,
    terminalReason: "provider_protocol_error" | "provider_scope_violation",
    diagnostics: Record<string, unknown>
  ): Promise<void> {
    await updateFlowState(this.root, this.workflowId, (state) => {
      const phase = state.plan?.phases.find((candidate) => candidate.id === record.phaseId);
      const lease = state.phaseLeases[record.phaseId];
      if (lease && !lease.releasedAt && lease.ownerId === record.leaseOwnerId) lease.releasedAt = this.now();
      if (phase) phase.status = "needs_review";
      const workspace = state.git?.phaseWorkspaces[record.phaseId];
      if (workspace) workspace.status = "needs_repair";
      const unexpectedWrites = Array.isArray(diagnostics.unexpectedWrites)
        ? diagnostics.unexpectedWrites.filter((value): value is string => typeof value === "string")
        : [];
      state.execution.records[record.phaseId] = {
        ...record,
        status: "blocked",
        completedAt: this.now(),
        resultSummary: summary,
        diagnostics: mergeDiagnostics(record.diagnostics, {
          ...diagnostics,
          terminalReason,
          resultAccepted: false,
          disposition: "needs_review",
          partialProgressPreserved: checkpoint.dirty,
          partialProgressAccepted: false
        }),
        checkpoint,
        providerSession: updateSessionStatus(record.providerSession, "failed", this.now(), terminalReason)
      };
      setPendingDecision(state, {
        type: "execution-recovery",
        phaseId: record.phaseId,
        briefRevision: state.phaseBriefs?.[record.phaseId]?.briefRevision,
        question: summary,
        allowedActions: [
          ...(unexpectedWrites.length > 0 ? ["discard-out-of-scope-and-retry"] : []),
          ...(unexpectedWrites.length === 0 ? ["retry-execution"] : ["revise-phase-brief"]),
          "view-details",
          "revise-plan",
          "cancel-workflow"
        ]
      });
      return state;
    }, { ownerId: this.coordinatorId, ownerType: "system", operation: "execution_result_recovery_quarantined" });
  }

  private async progressDeterministicTransitions(): Promise<SequentialWorkflowState> {
    let state = await loadFlowState(this.root, this.workflowId);
    const completed = state.plan?.phases.filter((phase) => phase.status === "completed") ?? [];
    for (const phase of completed.sort((a, b) => a.id.localeCompare(b.id))) {
      const status = integrationStatus(state);
      if (status.integratedPhaseIds.includes(phase.id) || status.conflictedPhaseIds.includes(phase.id)) continue;
      const result = await integratePhase({ root: this.root, workflowId: this.workflowId, phaseId: phase.id, ownerId: this.coordinatorId, config: this.config, mutation: { ownerId: this.coordinatorId, ownerType: "system" } });
      state = result.state;
      if (!result.ok) {
        return updateFlowState(this.root, this.workflowId, (current) => {
          setPendingDecision(current, {
            type: "integration-conflict",
            phaseId: phase.id,
            briefRevision: current.phaseBriefs?.[phase.id]?.briefRevision,
            integrationRevision: current.revision + 1,
            question: `Phase ${phase.id} integration is conflicted and requires a persisted repair decision.`,
            allowedActions: ["view-details", "retry-execution", "revise-plan", "cancel-workflow"]
          });
          return current;
        }, { ownerId: this.coordinatorId, ownerType: "system", operation: "integration_conflict_decision" });
      }
    }
    const nextPreflight = dependencyReadyCandidates(state).find((phase) => !state.phaseBriefs?.[phase.id] || !briefIsCurrent(state, phase.id));
    if (nextPreflight) {
      return preparePhaseExecutionBrief({
        root: this.root,
        workflowId: this.workflowId,
        phaseId: nextPreflight.id,
        config: this.config,
        refresh: Boolean(state.phaseBriefs?.[nextPreflight.id]),
        requireApproval: state.approval?.policy === "phase-by-phase",
        mutation: { ownerId: this.coordinatorId, ownerType: "system" }
      });
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
      const phase = state.plan?.phases.find((candidate) => candidate.id === handle.phaseId);
      const existing = state.execution.records[handle.phaseId];
      const eligibility = evaluatePhaseDispatchEligibility(state, handle.phaseId, this.config, {
        explicitlySelected: true,
        ownerId: handle.leaseOwnerId,
        now: this.clock()
      });
      if (!eligibility.eligible) throw new Error(`Provider handle rejected: ${eligibility.blockers.map((blocker) => blocker.message).join("; ")}`);
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
        providerMetadata: handle.providerMetadata,
        providerSession: handle.providerSession,
        diagnostics: existing?.diagnostics,
        checkpoint: existing?.checkpoint,
        executionBudget: handle.turnBudget ? {
          ...handle.turnBudget,
          attempts: existing?.executionBudget?.attempts ?? []
        } : existing?.executionBudget,
        executionIdentity: handle.executionIdentity
      };
      if (phase) {
        phase.status = "running";
        phase.startedAt ??= handle.startedAt;
      }
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

  private async persistWorkspacePreparation(phaseId: string, preparation: NonNullable<WorkflowPhase["workspace"]>["preparation"]): Promise<void> {
    await updateFlowState(this.root, this.workflowId, (state) => {
      const workspace = state.git?.phaseWorkspaces[phaseId];
      if (workspace) {
        state.git!.phaseWorkspaces[phaseId] = { ...workspace, preparation, updatedAt: this.now() };
        const phase = state.plan?.phases.find((candidate) => candidate.id === phaseId);
        if (phase?.workspace) phase.workspace = state.git!.phaseWorkspaces[phaseId];
        const brief = state.phaseBriefs?.[phaseId];
        if (preparation?.status === "blocked" && preparation.approvalRequired && preparation.bootstrapCommand && preparation.preparationRevision && preparation.workspaceIdentity && brief && state.approval) {
          setPendingDecision(state, {
            type: "workspace-bootstrap-approval",
            workflowRevision: state.revision + 1,
            stateRevision: state.revision + 1,
            phaseId,
            briefRevision: brief.briefRevision,
            preparationRevision: preparation.preparationRevision,
            workspaceIdentity: preparation.workspaceIdentity,
            command: preparation.bootstrapCommand,
            riskSummary: workspaceRiskSummary(preparation),
            question: `Approve workspace bootstrap command '${preparation.bootstrapCommand}' for Phase ${phaseId}?`,
            allowedActions: ["approve-bootstrap", "retry-preparation", "view-details", "cancel-workflow"],
            source: "system"
          });
        }
      }
      return state;
    }, { ownerId: this.coordinatorId, ownerType: "system", operation: "workspace_prepare_phase" });
  }

  private async reserveResumeDispatch(phaseId: string, ownerId: string): Promise<void> {
    await updateFlowState(this.root, this.workflowId, (state) => {
      const phase = state.plan?.phases.find((candidate) => candidate.id === phaseId);
      const lease = state.phaseLeases[phaseId];
      const record = state.execution.records[phaseId];
      if (!phase || phase.status !== "running") throw new Error(`Phase ${phaseId} is not in an explicit repair/resume state.`);
      if (!lease || lease.releasedAt || lease.ownerId !== ownerId || Date.parse(lease.expiresAt) <= this.clock().getTime()) {
        throw new Error(`Phase ${phaseId} resume requires an active lease held by ${ownerId}.`);
      }
      if (!record || ACTIVE_EXECUTION_STATUSES.has(record.status) || record.status === "cancelled" || !record.checkpoint) {
        throw new Error(`Phase ${phaseId} has no recoverable execution checkpoint to resume.`);
      }
      state.execution.records[phaseId] = { ...record, status: "dispatching", heartbeatAt: this.now() };
      return state;
    }, { ownerId: this.coordinatorId, ownerType: "system", operation: "execution_resume_reserved" });
  }

  private async markPhaseStopped(phaseId: string, ownerId: string, status: "failed" | "cancelled" | "timed_out" | "blocked", summary: string, diagnostics?: Record<string, unknown>): Promise<void> {
    const current = await loadFlowState(this.root, this.workflowId).catch(() => undefined);
    const existingRecord = current?.execution.records[phaseId];
    const workspacePath = existingRecord?.workspacePath ?? current?.git?.phaseWorkspaces[phaseId]?.path;
    const phase = current?.plan?.phases.find((candidate) => candidate.id === phaseId);
    const checkpoint = existingRecord
      ? await this.captureCheckpoint(existingRecord)
      : workspacePath
        ? await capturePhaseWorkspaceCheckpoint(workspacePath, phase?.validationCommands ?? [])
        : undefined;
    const mergedDiagnostics = mergeDiagnostics(diagnostics, checkpoint ? {
      checkpoint,
      partialProgressPreserved: checkpoint.dirty,
      partialProgressAccepted: false
    } : undefined);
    const sessionStatus = status === "cancelled" ? "cancelled" : status === "timed_out" || status === "blocked" ? "failed" : status;
    await updateFlowState(this.root, this.workflowId, (state) => {
      const phase = state.plan?.phases.find((candidate) => candidate.id === phaseId);
      const lease = state.phaseLeases[phaseId];
      if (lease && !lease.releasedAt && lease.ownerId === ownerId) state.phaseLeases[phaseId] = { ...lease, releasedAt: this.now() };
      if (phase && phase.status !== "completed") phase.status = status === "cancelled" ? "cancelled" : "needs_review";
      const workspace = state.git?.phaseWorkspaces[phaseId];
      if (workspace) state.git!.phaseWorkspaces[phaseId] = { ...workspace, status: status === "cancelled" ? "abandoned" : "needs_repair", updatedAt: this.now() };
      const existing = state.execution.records[phaseId];
      if (existing) {
        const executionBudget = finalizeExecutionBudget(existing, mergedDiagnostics, this.config, state.mode, this.now());
        state.execution.records[phaseId] = {
          ...existing,
          status,
          completedAt: this.now(),
          resultSummary: summary,
          diagnostics: mergedDiagnostics,
          checkpoint,
          executionBudget,
          providerSession: updateSessionStatus(
            existing.providerSession,
            sessionStatus,
            this.now(),
            typeof mergedDiagnostics?.terminalReason === "string" ? mergedDiagnostics.terminalReason : undefined
          )
        };
      }
      if (status !== "cancelled") {
        const record = state.execution.records[phaseId];
        const maxTurnFailure = record?.diagnostics?.terminalReason === "error_max_turns";
        const extensionAvailable = maxTurnFailure && (record.executionBudget?.extensionApprovals ?? 0) < 1;
        const additionalTurns = extensionAvailable ? record.executionBudget?.extensionTurnLimit : undefined;
        const configuredTurns = record?.executionBudget?.effectiveTurnLimit ?? record?.diagnostics?.maxTurns;
        const reportedTurns = record?.diagnostics?.turnCount;
        const question = extensionAvailable && additionalTurns
          ? `The provider reached the ${String(configuredTurns)}-turn execution limit${typeof reportedTurns === "number" ? ` after reporting ${reportedTurns} turns` : ""} before returning the required final result. Partial changes were preserved but not accepted. Allow up to ${additionalTurns} additional turns to continue from the existing work?`
          : maxTurnFailure
            ? `The provider also exhausted the approved additional-turn allowance before returning the required final result. Partial changes were preserved but not accepted. Review the evidence, revise the Workflow Plan, or cancel the workflow.`
            : summary;
        setPendingDecision(state, {
          type: "execution-recovery",
          phaseId,
          briefRevision: state.phaseBriefs?.[phaseId]?.briefRevision,
          additionalTurns,
          question,
          allowedActions: extensionAvailable
            ? ["continue-execution", "view-details", "revise-plan", "cancel-workflow"]
            : maxTurnFailure
              ? ["view-details", "revise-plan", "cancel-workflow"]
              : ["retry-execution", "view-details", "revise-plan", "cancel-workflow"]
        });
      }
      return state;
    }, { ownerId: this.coordinatorId, ownerType: "system", operation: "execution_phase_stopped" });
    if (status === "cancelled") {
      await releasePhase({ root: this.root, workflowId: this.workflowId, phaseId, ownerId, mutation: { ownerId } }).catch(() => undefined);
    }
  }

  private async inputForPhase(state: SequentialWorkflowState, phaseId: string, workspacePath: string, ownerId: string): Promise<PhaseExecutionInput> {
    const phase = state.plan?.phases.find((candidate) => candidate.id === phaseId);
    const brief = state.phaseBriefs?.[phaseId];
    const workspace = state.git?.phaseWorkspaces[phaseId];
    if (!phase || !brief || !state.git || !state.plan || !workspace?.preparation?.workspaceIdentity) throw new Error(`Cannot build execution input for ${phaseId}.`);
    const existing = state.execution.records[phaseId];
    const initialTurnLimit = existing?.executionBudget?.initialTurnLimit
      ?? (typeof existing?.diagnostics?.maxTurns === "number" ? existing.diagnostics.maxTurns : this.config.execution.workerControls.maxTurns[state.mode]);
    const extensionTurnLimit = existing?.executionBudget?.extensionTurnLimit ?? this.config.execution.workerControls.extensionTurns[state.mode];
    const extensionApprovals = existing?.executionBudget?.extensionApprovals ?? 0;
    const effectiveTurnLimit = existing?.executionBudget?.effectiveTurnLimit ?? initialTurnLimit;
    const previousCheckpoint = existing?.checkpoint ?? await capturePhaseWorkspaceCheckpoint(workspacePath, brief.validationCommands);
    const resume = buildResumeRequest(existing, state.id, phaseId, workspacePath, phase.repairAttempts.length);
    const dispatchedAt = this.now();
    const executionIdentity = {
      workflowId: state.id,
      workflowRevision: state.revision,
      phaseId: phase.id,
      briefRevision: brief.briefRevision,
      workspaceIdentity: workspace.preparation.workspaceIdentity,
      workspacePath,
      baseCommit: workspace.baseCommit,
      constraintHash: brief.repository.constraintHash,
      providerId: this.provider.id,
      dispatchedAt
    };
    return {
      workflowId: state.id,
      workflowRevision: state.revision,
      phaseId: phase.id,
      briefRevision: brief.briefRevision,
      executionIdentity,
      approvedBrief: structuredClone(brief),
      objective: brief.objective,
      deliverable: brief.deliverable,
      currentBehaviour: brief.currentBehaviour,
      implementationApproach: brief.implementationApproach,
      acceptanceCriteria: brief.acceptanceCriteria,
      testObligations: brief.testObligations,
      dependencies: brief.dependencies,
      assumptions: brief.assumptions,
      exclusions: brief.exclusions,
      risks: brief.risks,
      materialChanges: brief.materialChangesFromWorkflowPlan,
      relevantFiles: brief.relevantFiles,
      relevantSymbols: brief.relevantSymbols,
      inspectionProvenance: brief.inspectionResult.provenance,
      selectedMode: state.mode,
      modelTier: brief.modelTier ?? phase.modelTier,
      workspacePath,
      repositoryRoot: state.git.context.repositoryRoot,
      allowedReadAreas: brief.readAreas,
      allowedWriteAreas: brief.writeAreas,
      methodologyReferences: [`methodology/modes/${state.mode}.md`, "methodology/evidence.md", "methodology/safeguards.md"],
      validationExpectations: brief.validationCommands,
      leaseOwnerId: ownerId,
      timeoutSeconds: this.config.execution.workerTimeoutSeconds,
      userRequest: state.request,
      planContext: state.plan.summary,
      approvedConstraints: state.constraints?.effective.map((constraint) => constraint.text) ?? state.triage?.constraints.mustNot ?? [],
      safetyInstructions: [
        "Use only the assigned phase workspace.",
        "Return structured result evidence; LeanRigor will decide whether the phase is accepted.",
        "Do not commit, push, merge, deploy, or edit outside the workspace.",
        phase.workspace?.preparation?.dependencies === "available"
          ? "Workspace dependencies were prepared by LeanRigor before dispatch."
          : "Do not install dependencies. If dependencies are unavailable, stop and return blocked status with the missing command."
      ],
      turnBudget: {
        initialTurnLimit,
        effectiveTurnLimit,
        extensionTurnLimit,
        extensionApprovals,
        cumulativeAuthorizedTurns: existing?.executionBudget?.cumulativeAuthorizedTurns ?? initialTurnLimit
      },
      previousCheckpoint: previousCheckpoint.dirty ? previousCheckpoint : undefined,
      workspacePreparation: workspace.preparation,
      resume,
      codeIntelligence: await detectCodeIntelligence(workspacePath, state.git.context.repositoryRoot),
      workerControls: workerControlsForMode(this.config, state.mode)
    };
  }

  private handleFromRecord(record: PhaseExecutionRecord, workflowId: string): ExecutionHandle {
    if (!record.executionIdentity) throw new Error(`Execution record ${record.phaseId} has no compatible Phase 3 execution identity.`);
    return {
      providerId: record.providerId,
      providerExecutionId: record.providerExecutionId,
      workflowId,
      phaseId: record.phaseId,
      leaseOwnerId: record.leaseOwnerId,
      workspacePath: record.workspacePath,
      startedAt: record.startedAt,
      lastKnownStatus: record.status,
      providerMetadata: record.providerMetadata,
      providerSession: record.providerSession,
      nativeSessionId: record.providerSession?.sessionId,
      executionIdentity: record.executionIdentity
    };
  }

  private approvedBootstrap(state: SequentialWorkflowState, phaseId: string): { preparationRevision: number; workspaceIdentity: string; command: string } | undefined {
    const workspace = state.git?.phaseWorkspaces[phaseId];
    const preparation = workspace?.preparation;
    if (!preparation?.preparationRevision || !preparation.workspaceIdentity || !preparation.bootstrapCommand) return undefined;
    const approved = state.approval?.decisionHistory.find((decision) =>
      decision.type === "workspace-bootstrap-approval"
      && decision.status === "approved"
      && decision.phaseId === phaseId
      && decision.preparationRevision === preparation.preparationRevision
      && decision.workspaceIdentity === preparation.workspaceIdentity
      && decision.command === preparation.bootstrapCommand);
    return approved?.type === "workspace-bootstrap-approval" ? {
      preparationRevision: approved.preparationRevision,
      workspaceIdentity: approved.workspaceIdentity,
      command: approved.command
    } : undefined;
  }

  private assertHandleIdentity(input: PhaseExecutionInput, handle: ExecutionHandle): void {
    const expected = input.executionIdentity;
    const actual = handle.executionIdentity;
    if (
      !actual
      || actual.workflowId !== expected.workflowId
      || actual.workflowRevision !== expected.workflowRevision
      || actual.phaseId !== expected.phaseId
      || actual.briefRevision !== expected.briefRevision
      || actual.workspaceIdentity !== expected.workspaceIdentity
      || actual.workspacePath !== expected.workspacePath
      || actual.baseCommit !== expected.baseCommit
      || actual.constraintHash !== expected.constraintHash
      || actual.providerId !== expected.providerId
      || actual.dispatchedAt !== expected.dispatchedAt
    ) {
      throw new Error("Provider handle did not preserve the exact approved brief and workspace execution identity.");
    }
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
    return coordinatorResultForState(state, this.provider.id, dispatched, nextAction, message);
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
    if (this.selectPreparationCandidates(state).length > 0) return "dispatch";
    return "await_user";
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private async captureCheckpoint(record: PhaseExecutionRecord, result?: PhaseExecutionResult): Promise<PhaseWorkspaceCheckpoint> {
    return capturePhaseWorkspaceCheckpoint(record.workspacePath, result?.validation.map((entry) => entry.command) ?? record.checkpoint?.validationCommands ?? [], result);
  }
}

export function coordinatorResultForState(
  state: SequentialWorkflowState,
  providerId: string,
  dispatched: DispatchSummary[],
  nextAction: ExecutionNextAction,
  message: string
): CoordinatorResult {
  const records = Object.values(state.execution.records);
  const latestRecord = [...records].sort((a, b) => Date.parse(b.completedAt ?? b.heartbeatAt ?? b.startedAt) - Date.parse(a.completedAt ?? a.heartbeatAt ?? a.startedAt))[0];
  const activePhase = state.plan?.phases.find((phase) => ["leased", "running", "completion_pending"].includes(phase.status));
  const gatePhase = activePhase ?? state.plan?.phases.find((phase) => ["needs_repair", "needs_review", "needs_replan", "blocked"].includes(phase.status));
  const integrated = state.git ? integrationStatus(state) : undefined;
  const envelope = workflowDecisionEnvelope(state);
  const resultPhaseId = latestRecord?.phaseId ?? envelope.status.phaseId;
  const normalizedNextAction = envelope.decision
    ? "await_user"
    : nextAction === "await_user"
      ? operationNextAction(envelope.nextOperation?.type, state.state)
      : nextAction;
  return {
    ...envelope,
    revision: state.revision,
    executionMode: "coordinator",
    provider: providerId,
    phaseResult: resultPhaseId ? phaseResultView(state, resultPhaseId) : undefined,
    runningPhase: activePhase?.id,
    lastProviderStatus: latestRecord ? `${latestRecord.phaseId}: ${latestRecord.status}` : undefined,
    phaseGateStatus: gatePhase ? `${gatePhase.id}: ${gatePhase.completion?.decision ?? gatePhase.status}` : undefined,
    integrationStatus: state.git?.integration.status,
    combinedValidationStatus: integrated?.validation ? `${integrated.validation.status} @ ${integrated.validation.integrationCommit.slice(0, 12)}` : "not_run",
    pendingUserGate: envelope.decision?.type ?? null,
    nextValidAction: normalizedNextAction,
    running: records.filter((record) => ACTIVE_EXECUTION_STATUSES.has(record.status)).map((record) => ({ phaseId: record.phaseId, provider: record.providerId, status: record.status })),
    completed: records.filter((record) => ["completed", "result_recorded"].includes(record.status)).map((record) => ({ phaseId: record.phaseId, provider: record.providerId, status: record.status })),
    providerSessions: records.filter((record) => record.providerSession).map((record) => ({
      phaseId: record.phaseId,
      provider: record.providerId,
      providerExecutionId: record.providerExecutionId,
      sessionId: record.providerSession!.sessionId,
      workingDirectory: record.providerSession!.workingDirectory,
      status: record.providerSession!.status,
      resumePermitted: record.providerSession!.resumePermitted,
      resolvedModel: record.providerSession!.resolvedModel
    })),
    blocked: [
      ...records.filter((record) => ["failed", "cancelled", "timed_out", "blocked"].includes(record.status)).map((record) => ({ phaseId: record.phaseId, reason: record.resultSummary ?? record.status })),
      ...state.blockers.map((reason) => ({ phaseId: "workflow", reason }))
    ],
    dispatched,
    nextAction: normalizedNextAction,
    message
  };
}

function operationNextAction(type: string | undefined, state: SequentialWorkflowState["state"]): ExecutionNextAction {
  if (type === "execute-next") return "dispatch";
  if (type === "execution-poll") return "poll";
  if (type === "validate-integration") return "validate_integration";
  if (state === "completed") return "complete";
  return "refresh";
}

async function capturePhaseWorkspaceCheckpoint(workspacePath: string, validationCommands: string[], result?: PhaseExecutionResult): Promise<PhaseWorkspaceCheckpoint> {
  const trackedModified = uniqueStrings([
    ...await gitLines(workspacePath, ["diff", "--name-only", "--diff-filter=ACMRT", "HEAD", "--"]),
    ...await gitLines(workspacePath, ["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "--"])
  ]);
  const deletedFiles = uniqueStrings([
    ...await gitLines(workspacePath, ["diff", "--name-only", "--diff-filter=D", "HEAD", "--"]),
    ...await gitLines(workspacePath, ["diff", "--cached", "--name-only", "--diff-filter=D", "--"])
  ]);
  const untrackedFiles = await gitNul(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const status = (await gitText(workspacePath, ["status", "--short"])).trim();
  const statText = (await gitText(workspacePath, ["diff", "--stat", "HEAD", "--"])).trim();
  const nameStatus = (await gitText(workspacePath, ["diff", "--name-status", "HEAD", "--"])).trim();
  const diffExcerpt = (await gitText(workspacePath, ["diff", "--", "."])).trim();
  const untrackedSummary = untrackedFiles.length > 0 ? `Untracked files:\n${untrackedFiles.map((file) => `?? ${file}`).join("\n")}` : "";
  const rawSummary = [status && `Status:\n${status}`, nameStatus && `Changed files:\n${nameStatus}`, statText && `Diff stat:\n${statText}`, untrackedSummary, diffExcerpt && `Diff excerpt:\n${diffExcerpt}`].filter(Boolean).join("\n\n");
  const bounded = boundText(rawSummary, CHECKPOINT_DIFF_BYTES);
  const changedFiles = uniqueStrings([...trackedModified, ...deletedFiles, ...untrackedFiles]);
  return {
    capturedAt: new Date().toISOString(),
    workspacePath,
    dirty: changedFiles.length > 0,
    trackedModified,
    untrackedFiles,
    deletedFiles,
    changedFiles,
    diffSummary: bounded,
    validationCommands: uniqueStrings(validationCommands),
    validationResults: (result?.validation ?? []).map((entry) => ({
      command: entry.command,
      status: entry.status,
      exitCode: entry.exitCode,
      result: entry.result ? entry.result.slice(0, 1000) : undefined
    })),
    note: changedFiles.length > 0
      ? "Partial work was preserved in the phase worktree but was not accepted, committed, merged, or integrated."
      : "No uncommitted phase worktree changes were detected."
  };
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: CHECKPOINT_DIFF_BYTES * 4 }) as { stdout: string };
    return result.stdout;
  } catch {
    return "";
  }
}

async function gitLines(cwd: string, args: string[]): Promise<string[]> {
  return (await gitText(cwd, args)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function gitNul(cwd: string, args: string[]): Promise<string[]> {
  return (await gitText(cwd, args)).split("\0").map((line) => line.trim()).filter(Boolean);
}

async function discardOutOfScopeChanges(
  workspacePath: string,
  baseCommit: string,
  checkpoint: PhaseWorkspaceCheckpoint,
  files: string[]
): Promise<void> {
  const workspace = path.resolve(workspacePath);
  const untracked = new Set(checkpoint.untrackedFiles.map(normalizeRelative));
  const tracked: string[] = [];
  for (const file of uniqueStrings(files)) {
    const normalized = normalizeRelative(file);
    if (!safeWorkspaceRelativePath(normalized)) throw new Error(`Refusing to clean unsafe workspace path: ${file}`);
    const target = path.resolve(workspace, normalized);
    if (target !== workspace && !target.startsWith(`${workspace}${path.sep}`)) throw new Error(`Refusing to clean path outside the phase workspace: ${file}`);
    if (untracked.has(normalized)) await rm(target, { force: true, recursive: true });
    else tracked.push(normalized);
  }
  if (tracked.length > 0) {
    await execFileAsync("git", ["restore", `--source=${baseCommit}`, "--staged", "--worktree", "--", ...tracked], {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: CHECKPOINT_DIFF_BYTES * 4
    });
  }
}

function safeWorkspaceRelativePath(value: string): boolean {
  return Boolean(value)
    && !path.isAbsolute(value)
    && !value.split("/").includes("..")
    && value !== ".";
}

function boundText(text: string, maxBytes: number): PhaseWorkspaceCheckpoint["diffSummary"] {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { text, bytes, truncated: false };
  const suffix = `\n[diff summary truncated at ${maxBytes} bytes]`;
  return { text: `${text.slice(0, Math.max(0, maxBytes - suffix.length))}${suffix}`, bytes, truncated: true };
}

function reconcileChangedFiles(claimed: string[], actual: string[]): Record<string, unknown> {
  const claimedSet = new Set(claimed);
  const actualSet = new Set(actual);
  const missingFromProvider = actual.filter((file) => !claimedSet.has(file));
  const notChangedInWorkspace = claimed.filter((file) => !actualSet.has(file));
  return {
    claimedChangedFiles: claimed,
    actualChangedFiles: actual,
    changedFilesMatch: missingFromProvider.length === 0 && notChangedInWorkspace.length === 0,
    missingFromProvider,
    notChangedInWorkspace
  };
}

function executionIdentityIssues(
  record: PhaseExecutionRecord,
  result: PhaseExecutionResult,
  state: SequentialWorkflowState
): string[] {
  const expected = record.executionIdentity;
  const actual = result.executionIdentity;
  if (!expected) return ["persisted execution record has no compatible identity"];
  if (!actual) return ["provider result omitted execution identity"];
  const issues: string[] = [];
  for (const key of ["workflowId", "workflowRevision", "phaseId", "briefRevision", "workspaceIdentity", "workspacePath", "baseCommit", "constraintHash", "providerId", "providerSessionId", "dispatchedAt"] as const) {
    if (actual[key] !== expected[key]) issues.push(`${key} mismatch`);
  }
  const brief = state.phaseBriefs?.[record.phaseId];
  const workspace = state.git?.phaseWorkspaces[record.phaseId];
  if (!brief || brief.briefRevision !== expected.briefRevision || brief.approvalStatus !== "approved") issues.push("approved brief was superseded");
  if (!workspace || workspace.preparation?.workspaceIdentity !== expected.workspaceIdentity) issues.push("workspace identity is no longer current");
  issues.push(...briefStalenessReasons(state, record.phaseId).map((reason) => reason.message));
  return uniqueStrings(issues);
}

function pathWithinArea(file: string, area: string): boolean {
  const normalizedFile = normalizeRelative(file);
  const normalizedArea = normalizeRelative(area).replace(/\/\*\*.*$/, "").replace(/\/\*.*$/, "");
  if (!normalizedArea || normalizedArea === ".") return false;
  return normalizedFile === normalizedArea || normalizedFile.startsWith(`${normalizedArea}/`);
}

function normalizeRelative(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function workspaceRiskSummary(preparation: NonNullable<WorkflowPhase["workspace"]>["preparation"]): string[] {
  if (!preparation) return [];
  const risks: string[] = [];
  if (preparation.commandRisk.network) risks.push("may access the network");
  if (preparation.commandRisk.lifecycleScripts) risks.push("may execute dependency lifecycle scripts");
  if (preparation.commandRisk.localWrite) risks.push("writes dependency artifacts in the isolated workspace");
  if (!preparation.commandRisk.lockfilePreserving) risks.push("is not guaranteed to preserve the lockfile");
  if (preparation.commandRisk.manifestMutationExpected) risks.push("may modify package manifests or lockfiles");
  return risks.length > 0 ? risks : ["bounded local workspace preparation"];
}

function buildResumeRequest(record: PhaseExecutionRecord | undefined, workflowId: string, phaseId: string, workspacePath: string, attempt: number): PhaseExecutionInput["resume"] | undefined {
  if (!record?.checkpoint) return undefined;
  const session = record.providerSession;
  const maxTurnRecovery = record.diagnostics?.terminalReason === "error_max_turns";
  const sessionUnavailable = ["provider_session_unavailable", "provider_protocol_error", "provider_scope_violation", "provider_scope_cleanup"].includes(String(record.diagnostics?.terminalReason))
    || (typeof record.diagnostics?.stderrExcerpt === "string" && /no conversation found with session id/i.test(record.diagnostics.stderrExcerpt));
  const sameLineage = session
    && session.workflowId === workflowId
    && session.phaseId === phaseId
    && session.workingDirectory === workspacePath
    && session.resumePermitted
    && session.status !== "cancelled"
    // A max-turn recovery already has a complete checkpoint. Native-session
    // retention is provider-owned and may be unavailable, especially in bare
    // mode, so start the authorised continuation in a compact fresh context.
    && !maxTurnRecovery
    && !sessionUnavailable;
  return {
    providerSession: sameLineage ? session : undefined,
    failureReason: record.resultSummary ?? record.status,
    attempt,
    mode: sameLineage ? "same-session" : "compact-retry"
  };
}

function shouldAutomaticallyRetryUnavailableSession(record: PhaseExecutionRecord, diagnostics: Record<string, unknown> | undefined): boolean {
  return diagnostics?.terminalReason === "provider_session_unavailable"
    && Boolean(record.providerSession?.resumedFromSessionId)
    && !diagnostics.automaticCompactRetry;
}

function updateSessionStatus(session: ProviderSessionRef | undefined, status: ProviderSessionStatus, updatedAt: string, terminalReason?: string): ProviderSessionRef | undefined {
  if (!session) return undefined;
  const sessionUnavailable = terminalReason === "provider_session_unavailable";
  const freshSessionRequired = sessionUnavailable || terminalReason === "provider_protocol_error" || terminalReason === "provider_scope_violation" || terminalReason === "provider_scope_cleanup";
  const resolvedStatus = sessionUnavailable ? "unavailable" : status;
  return {
    ...session,
    status: resolvedStatus,
    updatedAt,
    resumePermitted: !freshSessionRequired && (resolvedStatus === "failed" || resolvedStatus === "unavailable"),
    replacementReason: freshSessionRequired ? "The prior provider session cannot be trusted for this retry; use a fresh compact session." : session.replacementReason
  };
}

export async function detectCodeIntelligence(workspacePath: string, repositoryRoot: string): Promise<PhaseExecutionInput["codeIntelligence"]> {
  if (await codeGraphUsable(workspacePath)) {
    return { codegraph: "exact-worktree", note: "CodeGraph index is available for the exact assigned phase worktree." };
  }
  const root = path.resolve(repositoryRoot);
  const workspace = path.resolve(workspacePath);
  if (root !== workspace && await codeGraphUsable(root)) {
    return { codegraph: "root-advisory", note: "CodeGraph is available only for the repository root; results may not match this phase worktree." };
  }
  return { codegraph: "unavailable", note: "No valid CodeGraph index was detected for the assigned phase worktree." };
}

async function codeGraphUsable(target: string): Promise<boolean> {
  try {
    await stat(path.join(target, ".codegraph"));
  } catch {
    return false;
  }
  try {
    const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "codegraph";
    const args = process.platform === "win32" ? ["/d", "/c", "codegraph", "status", target] : ["status", target];
    await execFileAsync(command, args, { encoding: "utf8", timeout: 3000, maxBuffer: 32 * 1024 });
    return true;
  } catch {
    return false;
  }
}

function mergeDiagnostics(...items: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  for (const item of items) {
    if (!item) continue;
    Object.assign(merged, item);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function attemptEvidence(record: PhaseExecutionRecord, diagnostics = record.diagnostics, completedAt = record.completedAt): NonNullable<PhaseExecutionRecord["executionBudget"]>["attempts"] {
  const maxTurns = typeof diagnostics?.maxTurns === "number"
    ? diagnostics.maxTurns
    : record.executionBudget?.effectiveTurnLimit;
  if (!maxTurns) return record.executionBudget?.attempts ?? [];
  const prior = record.executionBudget?.attempts ?? [];
  if (prior.some((attempt) => attempt.providerExecutionId === record.providerExecutionId)) return prior;
  return [...prior, {
    providerExecutionId: record.providerExecutionId,
    maxTurns,
    reportedTurnsUsed: typeof diagnostics?.turnCount === "number" ? diagnostics.turnCount : undefined,
    terminalReason: typeof diagnostics?.terminalReason === "string" ? diagnostics.terminalReason : undefined,
    costUsd: typeof diagnostics?.costUsd === "number" ? diagnostics.costUsd : undefined,
    completedAt
  }];
}

function finalizeExecutionBudget(
  record: PhaseExecutionRecord,
  diagnostics: Record<string, unknown> | undefined,
  config: LeanRigorConfig,
  mode: SequentialWorkflowState["mode"],
  completedAt: string
): NonNullable<PhaseExecutionRecord["executionBudget"]> {
  const initialTurnLimit = record.executionBudget?.initialTurnLimit
    ?? (typeof diagnostics?.maxTurns === "number" ? diagnostics.maxTurns : config.execution.workerControls.maxTurns[mode]);
  const extensionTurnLimit = record.executionBudget?.extensionTurnLimit ?? config.execution.workerControls.extensionTurns[mode];
  return {
    initialTurnLimit,
    effectiveTurnLimit: record.executionBudget?.effectiveTurnLimit ?? initialTurnLimit,
    extensionTurnLimit,
    extensionApprovals: record.executionBudget?.extensionApprovals ?? 0,
    cumulativeAuthorizedTurns: record.executionBudget?.cumulativeAuthorizedTurns ?? initialTurnLimit,
    attempts: attemptEvidence(record, diagnostics, completedAt)
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function workerControlsForMode(config: LeanRigorConfig, mode: SequentialWorkflowState["mode"]): NonNullable<PhaseExecutionInput["workerControls"]> {
  return {
    maxDiscoveryTurns: config.execution.workerControls.maxDiscoveryTurns[mode],
    reservedValidationTurns: config.execution.workerControls.reservedValidationTurns[mode],
    reservedFinalResultTurns: config.execution.workerControls.reservedFinalResultTurns[mode],
    repeatedReadWarningThreshold: config.execution.workerControls.repeatedReadWarningThreshold,
    largeToolOutputBytes: config.execution.workerControls.largeToolOutputBytes
  };
}

function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const details = (error as { details?: unknown }).details;
  return details && typeof details === "object" ? details as Record<string, unknown> : undefined;
}
