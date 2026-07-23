import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import type { LeanRigorConfig, ModelTier } from "../config/schema.js";
import { resolveModelTier } from "../config/models.js";
import { commitCommands, proposeCommits } from "./commit-planner.js";
import type { TriageProvider, TriageRunResult } from "./triage-runner.js";
import { runTriage } from "./triage-runner.js";
import type {
  ApproachRecommendation,
  CommitPlan,
  CompletionGateDecision,
  CriterionCompletionEvidence,
  ExecutionGraph,
  ExecutionPlan,
  IntegratedReviewResult,
  ModelProfile,
  PhaseCompletionRecord,
  PhaseRepairAttempt,
  RiskLevel,
  SequentialWorkflowState,
  TriageOutput,
  ValidationEvidence,
  WorkflowLifecycleState,
  WorkflowMode,
  WorkflowPhase
} from "./types.js";

export const WORKFLOW_DIR = path.join(".leanrigor", "workflows");
export const STATE_VERSION = 2;
const require = createRequire(import.meta.url);

const lifecycleStateSchema = z.enum([
  "created",
  "triaging",
  "awaiting_clarification",
  "awaiting_approach_approval",
  "planning",
  "awaiting_plan_approval",
  "executing",
  "validating",
  "reviewing",
  "awaiting_commit_approval",
  "completed",
  "blocked",
  "cancelled"
]);

const riskSchema = z.enum(["none", "low", "medium", "high"]);
const modelProfileSchema = z.enum(["small", "medium", "large", "inherit"]);
const criterionStatusSchema = z.enum(["met", "not_met", "uncertain", "not_applicable"]);
const completionDecisionSchema = z.enum(["completed", "needs_repair", "needs_review", "needs_replan", "blocked"]);

const triageSchema = z.object({
  version: z.literal(1),
  task: z.object({
    type: z.enum(["bug", "feature", "refactor", "investigation", "maintenance", "documentation", "unknown"]),
    summary: z.string()
  }),
  assessment: z.object({
    complexity: z.enum(["low", "medium", "high"]),
    ambiguity: z.enum(["low", "medium", "high"]),
    blastRadius: z.enum(["low", "medium", "high"]),
    architecturalImpact: z.enum(["low", "medium", "high"]),
    securityRisk: riskSchema,
    dataIntegrityRisk: riskSchema,
    operationalRisk: riskSchema
  }),
  workflow: z.object({
    modelRecommendation: z.enum(["fast", "standard", "rigorous"]),
    finalMode: z.enum(["fast", "standard", "rigorous"]),
    confidence: z.number(),
    parallelism: z.enum(["sequential", "candidate"]),
    reviewLevel: z.enum(["sanity", "integrated", "deep", "specialist"]),
    testLevel: z.enum(["none", "sanity", "targeted", "package", "full"]),
    overridden: z.boolean(),
    overrideReason: z.string().nullable()
  }),
  clarification: z.object({
    required: z.boolean(),
    question: z.string().nullable(),
    reason: z.string().nullable()
  }),
  inspection: z.object({
    required: z.boolean(),
    targets: z.array(z.string())
  }),
  escalationReasons: z.array(z.string()),
  assumptions: z.array(z.string()),
  constraints: z.object({ mustNot: z.array(z.string()) })
});

const validationEvidenceSchema = z.object({
  phaseId: z.string().optional(),
  command: z.string().min(1),
  exitStatus: z.number().int().nullable(),
  result: z.string(),
  status: z.enum(["passed", "failed", "skipped"]),
  skipped: z.boolean(),
  skippedReason: z.string().optional(),
  timestamp: z.string()
}).superRefine((value, ctx) => {
  if (value.skipped && !value.skippedReason) {
    ctx.addIssue({ code: "custom", path: ["skippedReason"], message: "Skipped validation requires a reason." });
  }
  if (!value.skipped && value.exitStatus === null) {
    ctx.addIssue({ code: "custom", path: ["exitStatus"], message: "Non-skipped validation requires an exit status." });
  }
});

const criterionCompletionSchema = z.object({
  criterion: z.string().min(1),
  status: criterionStatusSchema,
  evidence: z.array(z.string().min(1))
});

const phaseRepairAttemptSchema = z.object({
  attempt: z.number().int().min(1),
  reason: z.string().min(1),
  requestedScope: z.string().min(1),
  validation: z.array(validationEvidenceSchema),
  outcome: completionDecisionSchema.optional(),
  timestamp: z.string()
});

const phaseCompletionRecordSchema = z.object({
  phaseId: z.string().min(1),
  objective: z.string().min(1),
  criteria: z.array(criterionCompletionSchema),
  filesChanged: z.array(z.string()),
  validation: z.object({
    status: z.enum(["passed", "failed", "skipped", "missing"]),
    commands: z.array(validationEvidenceSchema),
    skipped: z.array(z.object({ command: z.string().min(1), reason: z.string().min(1) }))
  }),
  scopeDeviations: z.array(z.string()),
  assumptions: z.array(z.string()),
  remainingRisks: z.array(z.string()),
  dependentPhasesMayProceed: z.boolean(),
  decision: completionDecisionSchema,
  reason: z.string(),
  repairAttempt: z.number().int().min(0),
  timestamp: z.string(),
  workflowRevision: z.number().int().min(0)
});

const phaseSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  rationale: z.string().min(1),
  dependencies: z.array(z.string()),
  expectedFilesOrAreas: z.array(z.string()),
  acceptanceCriteria: z.array(z.string().min(1)),
  validationCommands: z.array(z.string()),
  riskLevel: riskSchema,
  modelTier: modelProfileSchema,
  status: z.enum(["pending", "active", "completed", "needs_repair", "needs_review", "needs_replan", "blocked"]),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  filesChanged: z.array(z.string()),
  commandsRun: z.array(z.string()),
  validationResults: z.array(validationEvidenceSchema),
  scopeDeviations: z.array(z.string()),
  completion: phaseCompletionRecordSchema.optional(),
  repairAttempts: z.array(phaseRepairAttemptSchema).default([])
});

const planSchema = z.object({
  version: z.literal(1),
  summary: z.string().min(1),
  principles: z.array(z.string().min(1)),
  phases: z.array(phaseSchema).min(1),
  approvedAt: z.string().optional(),
  revisionRequests: z.array(z.object({ feedback: z.string().min(1), timestamp: z.string() }))
}).superRefine((plan, ctx) => {
  const ids = new Set(plan.phases.map((phase) => phase.id));
  if (ids.size !== plan.phases.length) {
    ctx.addIssue({ code: "custom", path: ["phases"], message: "Phase IDs must be unique." });
  }
  for (const phase of plan.phases) {
    for (const dependency of phase.dependencies) {
      if (!ids.has(dependency)) {
        ctx.addIssue({ code: "custom", path: ["phases", phase.id, "dependencies"], message: `Missing dependency ${dependency}.` });
      }
    }
  }
  for (const issue of validatePlanQuality(plan)) {
    ctx.addIssue({ code: "custom", path: ["phases"], message: issue });
  }
});

const workflowStateSchema = z.object({
  version: z.literal(STATE_VERSION),
  id: z.string().min(1),
  revision: z.number().int().min(0),
  state: lifecycleStateSchema,
  request: z.string().min(1),
  root: z.string().min(1),
  mode: z.enum(["fast", "standard", "rigorous"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  triage: triageSchema.optional(),
  triageRun: z.object({
    source: z.enum(["model", "deterministic-fallback"]),
    provider: z.string(),
    model: z.string().optional(),
    attempts: z.number().int(),
    warnings: z.array(z.string())
  }).optional(),
  clarification: z.object({
    question: z.string().min(1),
    reason: z.string().min(1),
    answer: z.string().optional(),
    answeredAt: z.string().optional()
  }).optional(),
  approach: z.object({
    required: z.boolean(),
    approved: z.boolean(),
    proposed: z.string().min(1),
    preferredBecause: z.string().min(1),
    alternatives: z.array(z.string()),
    primaryRisks: z.array(z.string()),
    validationStrategy: z.array(z.string()),
    rejectedReason: z.string().optional()
  }).optional(),
  plan: planSchema.optional(),
  validation: z.array(validationEvidenceSchema),
  review: z.object({
    status: z.enum(["passed", "needs_repair", "needs_replan", "blocked"]),
    summary: z.string(),
    findings: z.array(z.string()),
    repairScope: z.string().optional(),
    reviewedAt: z.string()
  }).optional(),
  commitPlan: z.object({
    generatedAt: z.string(),
    groups: z.array(z.object({
      message: z.string(),
      files: z.array(z.string()),
      rationale: z.string(),
      commands: z.array(z.string())
    })),
    note: z.string()
  }).optional(),
  repairAttempts: z.number().int().min(0),
  blockers: z.array(z.string()),
  events: z.array(z.object({
    state: lifecycleStateSchema,
    message: z.string(),
    timestamp: z.string()
  }))
});

export class WorkflowNotFoundError extends Error {}
export class WorkflowStateError extends Error {}
export class InvalidTransitionError extends Error {}
export class StaleWorkflowError extends Error {}
export class CorruptedWorkflowError extends Error {}

export interface FlowStartOptions {
  request: string;
  root: string;
  config: LeanRigorConfig;
  provider?: TriageProvider;
}

export async function startFlow(options: FlowStartOptions): Promise<SequentialWorkflowState> {
  const root = path.resolve(options.root);
  const now = timestamp();
  let state: SequentialWorkflowState = {
    version: STATE_VERSION,
    id: workflowId(),
    revision: 0,
    state: "created",
    request: options.request,
    root,
    mode: "standard",
    createdAt: now,
    updatedAt: now,
    validation: [],
    repairAttempts: 0,
    blockers: [],
    events: [{ state: "created", message: "Workflow created.", timestamp: now }]
  };

  await saveFlowState(root, state, { create: true });
  state = await updateFlowState(root, state.id, (current) => transition(current, "triaging", "Task triage started."));

  const triageRun = await runTriage({
    request: options.request,
    root,
    config: options.config,
    provider: options.provider
  });

  return updateFlowState(root, state.id, (current) => applyTriageResult(current, triageRun, options.config));
}

export async function answerClarification(args: {
  root: string;
  workflowId: string;
  answer: string;
  config: LeanRigorConfig;
  provider?: TriageProvider;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, async (state) => {
    assertState(state, ["awaiting_clarification"]);
    if (!state.clarification) throw new WorkflowStateError("Workflow is awaiting clarification but has no persisted question.");
    const answered = structuredClone(state);
    answered.clarification = {
      question: state.clarification.question,
      reason: state.clarification.reason,
      answer: args.answer,
      answeredAt: timestamp()
    };
    answered.events.push({ state: answered.state, message: "Blocking clarification answered.", timestamp: timestamp() });

    const triageRun = await runTriage({
      request: `${answered.request}\n\nClarification answer: ${args.answer}`,
      root: answered.root,
      config: args.config,
      provider: args.provider
    });
    const next = applyTriageResult(answered, triageRun, args.config, { clarificationAlreadyAnswered: true });
    return next;
  });
}

export async function approveApproach(root: string, workflowId: string, config?: LeanRigorConfig): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, (state) => {
    assertState(state, ["awaiting_approach_approval"]);
    if (!state.approach) throw new WorkflowStateError("No approach recommendation is available.");
    const next = structuredClone(state);
    next.approach = { ...state.approach, approved: true };
    next.events.push({ state: "awaiting_approach_approval", message: "Approach approved.", timestamp: timestamp() });
    return withPlan(next, config);
  });
}

export async function rejectApproach(root: string, workflowId: string, reason: string): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, (state) => {
    assertState(state, ["awaiting_approach_approval"]);
    const next = structuredClone(state);
    next.approach = next.approach ? { ...next.approach, rejectedReason: reason } : undefined;
    next.blockers = [`Approach rejected: ${reason}`];
    return transition(next, "blocked", "Approach rejected; workflow blocked pending a new request or manual restart.");
  });
}

export async function revisePlan(root: string, workflowId: string, feedback: string, config?: LeanRigorConfig): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, (state) => {
    assertState(state, ["awaiting_plan_approval", "executing", "validating", "reviewing"]);
    if (!state.triage) throw new WorkflowStateError("Cannot revise a plan before triage completes.");
    const next = structuredClone(state);
    const triage = state.triage;
    const previousRequests = next.plan?.revisionRequests ?? [];
    next.plan = buildPlan(next.request, triage, next.root, config, {
      revisionRequests: [...previousRequests, { feedback, timestamp: timestamp() }]
    });
    next.review = undefined;
    next.commitPlan = undefined;
    next.blockers = [];
    return transition(next, "awaiting_plan_approval", "Plan revised and awaiting approval.");
  });
}

export async function approvePlan(root: string, workflowId: string): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, (state) => {
    assertState(state, ["awaiting_plan_approval"]);
    if (!state.plan) throw new WorkflowStateError("No plan is available for approval.");
    const next = structuredClone(state);
    const plan = state.plan;
    next.plan = { ...plan, approvedAt: timestamp() };
    next.plan.phases = plan.phases.map((phase, index) => index === 0
      ? { ...phase, status: "active", startedAt: timestamp() }
      : { ...phase, status: "pending" });
    return transition(next, "executing", `Plan approved. Phase ${next.plan.phases[0]?.id ?? "unknown"} is active.`);
  });
}

export async function startPhase(root: string, workflowId: string, phaseId?: string): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, (state) => {
    assertState(state, ["executing"]);
    const next = structuredClone(state);
    const phase = selectStartablePhase(next, phaseId);
    phase.status = "active";
    phase.startedAt = phase.startedAt ?? timestamp();
    next.events.push({ state: "executing", message: `Phase ${phase.id} started.`, timestamp: timestamp() });
    return next;
  });
}

export async function completePhase(args: {
  root: string;
  workflowId: string;
  phaseId: string;
  config?: LeanRigorConfig;
  criteria?: CriterionCompletionEvidence[];
  filesChanged?: string[];
  commandsRun?: string[];
  validation?: ValidationEvidence[];
  scopeDeviations?: string[];
  assumptions?: string[];
  remainingRisks?: string[];
  blockedReason?: string;
  requestedRepairScope?: string;
  modelDecision?: CompletionGateDecision;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, (state) => {
    assertState(state, ["executing"]);
    if (!state.plan) throw new WorkflowStateError("Cannot complete a phase without a plan.");
    const next = structuredClone(state);
    const plan = next.plan;
    if (!plan) throw new WorkflowStateError("Cannot complete a phase without a plan.");
    const phase = plan.phases.find((candidate) => candidate.id === args.phaseId);
    if (!phase) throw new WorkflowStateError(`Unknown phase: ${args.phaseId}`);
    if (phase.status !== "active") throw new InvalidTransitionError(`Phase ${phase.id} is ${phase.status}; only an active phase can enter the completion gate.`);
    phase.filesChanged = unique([...phase.filesChanged, ...(args.filesChanged ?? [])]);
    phase.commandsRun = [...phase.commandsRun, ...(args.commandsRun ?? [])];
    for (const evidence of args.validation ?? []) {
      validateWorkflowEvidence(evidence);
      next.validation.push(evidence);
      phase.validationResults.push(evidence);
    }
    const detectedDeviations = detectScopeDeviations(phase, args.config);
    phase.scopeDeviations = unique([...phase.scopeDeviations, ...(args.scopeDeviations ?? []), ...detectedDeviations]);

    const completion = buildCompletionRecord({
      state: next,
      phase,
      criteria: args.criteria,
      assumptions: args.assumptions,
      remainingRisks: args.remainingRisks,
      blockedReason: args.blockedReason,
      requestedRepairScope: args.requestedRepairScope,
      config: args.config
    });
    phase.completion = completion;
    phase.status = completion.decision;
    if (completion.decision === "completed") phase.completedAt = timestamp();
    const repair = phase.repairAttempts.at(-1);
    if (repair && !repair.outcome) {
      repair.validation = phase.validationResults;
      repair.outcome = completion.decision;
    }
    next.events.push({ state: "executing", message: `Phase ${phase.id} completion gate: ${completion.decision}. ${completion.reason}`, timestamp: timestamp() });

    if (completion.decision === "blocked") {
      next.blockers = [completion.reason];
      return transition(next, "blocked", `Phase ${phase.id} is blocked.`);
    }
    if (completion.decision !== "completed") return next;

    const nextPhase = plan.phases.find((candidate) => candidate.status === "pending" && candidate.dependencies.every((id) => phaseById(plan, id)?.status === "completed"));
    if (nextPhase) {
      nextPhase.status = "active";
      nextPhase.startedAt = timestamp();
      next.events.push({ state: "executing", message: `Phase ${nextPhase.id} started after completion gate passed.`, timestamp: timestamp() });
      return next;
    }

    const unfinished = plan.phases.find((candidate) => candidate.status !== "completed");
    if (unfinished) return next;
    return transition(next, "validating", "All phases completed; targeted validation is required.");
  });
}

export async function repairPhase(args: {
  root: string;
  workflowId: string;
  phaseId: string;
  reason: string;
  requestedScope?: string;
  config: LeanRigorConfig;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, (state) => {
    assertState(state, ["executing"]);
    if (!state.plan) throw new WorkflowStateError("Cannot repair a phase without a plan.");
    const next = structuredClone(state);
    const plan = next.plan;
    if (!plan) throw new WorkflowStateError("Cannot repair a phase without a plan.");
    const phase = phaseById(plan, args.phaseId);
    if (!phase) throw new WorkflowStateError(`Unknown phase: ${args.phaseId}`);
    if (phase.status !== "needs_repair") throw new InvalidTransitionError(`Phase ${phase.id} is ${phase.status}; only needs_repair can be repaired.`);
    const budget = args.config.completionGate.maxRepairAttempts[next.mode];
    if (phase.repairAttempts.length >= budget) {
      phase.status = "needs_review";
      if (phase.completion) {
        phase.completion.decision = "needs_review";
        phase.completion.dependentPhasesMayProceed = false;
        phase.completion.reason = `Repair budget exhausted after ${phase.repairAttempts.length} attempt(s).`;
      }
      next.events.push({ state: "executing", message: `Phase ${phase.id} repair budget exhausted.`, timestamp: timestamp() });
      return next;
    }
    const attempt: PhaseRepairAttempt = {
      attempt: phase.repairAttempts.length + 1,
      reason: args.reason,
      requestedScope: args.requestedScope ?? phase.completion?.reason ?? "Repair the bounded completion-gate issue.",
      validation: [],
      timestamp: timestamp()
    };
    phase.repairAttempts.push(attempt);
    phase.status = "active";
    phase.startedAt = timestamp();
    phase.completedAt = undefined;
    next.events.push({ state: "executing", message: `Phase ${phase.id} repair attempt ${attempt.attempt}/${budget} started.`, timestamp: timestamp() });
    return next;
  });
}

export async function recordValidation(args: {
  root: string;
  workflowId: string;
  phaseId?: string;
  command: string;
  exitStatus?: number | null;
  result: string;
  skipped?: boolean;
  skippedReason?: string;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, (state) => {
    assertState(state, ["executing", "validating", "reviewing"]);
    const evidence: ValidationEvidence = {
      phaseId: args.phaseId,
      command: args.command,
      exitStatus: args.skipped ? null : args.exitStatus ?? 0,
      result: args.result,
      status: args.skipped ? "skipped" : (args.exitStatus ?? 0) === 0 ? "passed" : "failed",
      skipped: args.skipped ?? false,
      skippedReason: args.skippedReason,
      timestamp: timestamp()
    };
    validateWorkflowEvidence(evidence);
    const next = structuredClone(state);
    next.validation.push(evidence);
    const phase = args.phaseId && next.plan ? phaseById(next.plan, args.phaseId) : undefined;
    if (phase) phase.validationResults.push(evidence);
    next.events.push({ state: next.state, message: `Validation recorded: ${evidence.command} (${evidence.status}).`, timestamp: timestamp() });
    return next;
  });
}

export async function recordReview(args: {
  root: string;
  workflowId: string;
  status: IntegratedReviewResult["status"];
  summary: string;
  findings?: string[];
  repairScope?: string;
  config: LeanRigorConfig;
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, (state) => {
    assertState(state, ["validating", "reviewing"]);
    if (!state.plan || state.plan.phases.some((phase) => phase.status !== "completed")) {
      throw new InvalidTransitionError("Final review requires all phases to be completed.");
    }
    if (!hasValidationEvidence(state)) {
      throw new InvalidTransitionError("Final review requires persisted validation evidence or an explicit skipped-validation reason.");
    }
    const next = structuredClone(state);
    next.review = {
      status: args.status,
      summary: args.summary,
      findings: args.findings ?? [],
      repairScope: args.repairScope,
      reviewedAt: timestamp()
    };

    if (args.status === "passed") {
      next.commitPlan = buildCommitPlan(next);
      return transition(next, "awaiting_commit_approval", "Integrated review passed; commit proposal is ready.");
    }
    if (args.status === "needs_repair") {
      const budget = args.config.budgets.repairRounds;
      if (next.repairAttempts >= budget) {
        next.blockers = [`Repair budget exhausted after ${next.repairAttempts} repair attempt(s).`];
        return transition(next, "blocked", "Integrated review still needs repair and the repair budget is exhausted.");
      }
      next.repairAttempts += 1;
      appendRepairPhase(next, args.repairScope ?? "Address the integrated review findings.");
      return transition(next, "executing", "Integrated review requested repair; a repair phase is active.");
    }
    if (args.status === "needs_replan") {
      next.blockers = ["Integrated review requires replanning before more execution."];
      return transition(next, "awaiting_plan_approval", "Integrated review requested replanning.");
    }
    next.blockers = args.findings?.length ? args.findings : [args.summary];
    return transition(next, "blocked", "Integrated review blocked the workflow.");
  });
}

export async function getCommitPlan(root: string, workflowId: string): Promise<CommitPlan> {
  const state = await loadFlowState(root, workflowId);
  if (state.state !== "awaiting_commit_approval" || !state.commitPlan) {
    throw new InvalidTransitionError(`Workflow ${workflowId} is ${state.state}; commit proposal is available only after review passes.`);
  }
  return state.commitPlan;
}

export async function completeFlow(root: string, workflowId: string): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, (state) => {
    assertState(state, ["awaiting_commit_approval"]);
    return transition(structuredClone(state), "completed", "Workflow completed by explicit user action. No commit was executed.");
  });
}

export async function cancelFlow(root: string, workflowId: string): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, (state) => {
    if (["completed", "cancelled"].includes(state.state)) throw new InvalidTransitionError(`Workflow is already ${state.state}.`);
    return transition(structuredClone(state), "cancelled", "Workflow cancelled by user.");
  });
}

export async function resumeFlow(root: string, workflowId: string): Promise<SequentialWorkflowState> {
  return loadFlowState(root, workflowId);
}

export async function listFlows(root: string): Promise<Array<{ id: string; state: WorkflowLifecycleState; mode: WorkflowMode; request: string; updatedAt: string }>> {
  const dir = path.join(path.resolve(root), WORKFLOW_DIR);
  let entries: string[];
  try {
    const fs = await import("node:fs/promises");
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const flows = await Promise.all(entries
    .filter((entry) => entry.endsWith(".json"))
    .map(async (entry) => {
      const state = await loadFlowState(root, entry.replace(/\.json$/, ""));
      return { id: state.id, state: state.state, mode: state.mode, request: state.request, updatedAt: state.updatedAt };
    }));
  return flows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadLatestFlow(root: string): Promise<SequentialWorkflowState | undefined> {
  const flows = await listFlows(root);
  if (flows.length === 0) return undefined;
  return loadFlowState(root, flows[0].id);
}

export async function loadFlowState(root: string, workflowId: string): Promise<SequentialWorkflowState> {
  const file = workflowPath(root, workflowId);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkflowNotFoundError(`Workflow not found: ${workflowId}`);
    throw error;
  }
  try {
    return workflowStateSchema.parse(JSON.parse(raw)) as SequentialWorkflowState;
  } catch (error) {
    throw new CorruptedWorkflowError(`Workflow state is corrupted: ${file}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveFlowState(root: string, state: SequentialWorkflowState, options: { create?: boolean; expectedRevision?: number } = {}): Promise<void> {
  const parsed = workflowStateSchema.parse({ ...state, updatedAt: state.updatedAt }) as SequentialWorkflowState;
  const dir = path.join(path.resolve(root), WORKFLOW_DIR);
  await mkdir(dir, { recursive: true });
  const target = workflowPath(root, parsed.id);

  if (options.create) {
    try {
      await readFile(target, "utf8");
      throw new StaleWorkflowError(`Workflow already exists: ${parsed.id}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  if (options.expectedRevision !== undefined) {
    const current = await loadFlowState(root, parsed.id);
    if (current.revision !== options.expectedRevision) {
      throw new StaleWorkflowError(`Workflow ${parsed.id} has revision ${current.revision}; expected ${options.expectedRevision}. Reload before writing.`);
    }
  }

  const temp = path.join(dir, `.${parsed.id}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(parsed, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  try {
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function updateFlowState(
  root: string,
  workflowId: string,
  mutate: (state: SequentialWorkflowState) => SequentialWorkflowState | Promise<SequentialWorkflowState>
): Promise<SequentialWorkflowState> {
  const current = await loadFlowState(root, workflowId);
  const mutated = await mutate(structuredClone(current));
  const next = workflowStateSchema.parse({
    ...mutated,
    revision: current.revision + 1,
    updatedAt: timestamp()
  }) as SequentialWorkflowState;
  await saveFlowState(root, next, { expectedRevision: current.revision });
  return next;
}

export function nextActions(state: SequentialWorkflowState): string[] {
  const id = state.id;
  switch (state.state) {
    case "awaiting_clarification":
      return [`leanrigor flow answer ${id} "<answer>" --root "${state.root}"`];
    case "awaiting_approach_approval":
      return [
        `leanrigor flow approve-approach ${id} --root "${state.root}"`,
        `leanrigor flow reject-approach ${id} --reason "<reason>" --root "${state.root}"`
      ];
    case "awaiting_plan_approval":
      return [
        `leanrigor flow approve-plan ${id} --root "${state.root}"`,
        `leanrigor flow revise-plan ${id} "<feedback>" --root "${state.root}"`
      ];
    case "executing": {
      const active = state.plan?.phases.find((phase) => phase.status === "active");
      const repair = state.plan?.phases.find((phase) => phase.status === "needs_repair");
      const review = state.plan?.phases.find((phase) => phase.status === "needs_review");
      const replan = state.plan?.phases.find((phase) => phase.status === "needs_replan");
      if (repair) return [`leanrigor flow repair ${id} ${repair.id} --reason "<reason>" --root "${state.root}"`];
      if (review) return [`leanrigor flow phase-status ${id} ${review.id} --root "${state.root}"`, `leanrigor flow revise-plan ${id} "<feedback>" --root "${state.root}"`];
      if (replan) return [`leanrigor flow revise-plan ${id} "<feedback>" --root "${state.root}"`];
      return active
        ? [
          `leanrigor flow record-validation ${id} --phase ${active.id} --command "<command>" --exit 0 --result "<summary>" --root "${state.root}"`,
          `leanrigor flow phase-complete ${id} ${active.id} --evidence-file "<path>" --root "${state.root}"`
        ]
        : [`leanrigor flow phase-start ${id} --root "${state.root}"`];
    }
    case "validating":
      return [
        `leanrigor flow record-validation ${id} --command "<command>" --exit 0 --result "<summary>" --root "${state.root}"`,
        `leanrigor flow record-review ${id} --status passed --summary "<summary>" --root "${state.root}"`
      ];
    case "reviewing":
      return [`leanrigor flow record-review ${id} --status passed --summary "<summary>" --root "${state.root}"`];
    case "awaiting_commit_approval":
      return [
        `leanrigor flow commit-plan ${id} --root "${state.root}"`,
        `leanrigor flow complete ${id} --root "${state.root}"`
      ];
    case "blocked":
      return [`leanrigor flow status ${id} --root "${state.root}"`, `leanrigor flow cancel ${id} --root "${state.root}"`];
    case "cancelled":
    case "completed":
      return [];
    default:
      return [`leanrigor flow status ${id} --root "${state.root}"`];
  }
}

function applyTriageResult(
  state: SequentialWorkflowState,
  triageRun: TriageRunResult,
  config: LeanRigorConfig,
  options: { clarificationAlreadyAnswered?: boolean } = {}
): SequentialWorkflowState {
  const next = structuredClone(state);
  const triage = enforceOneClarification(triageRun.output, options.clarificationAlreadyAnswered ?? false);
  next.triage = triage;
  next.triageRun = {
    source: triageRun.source,
    provider: triageRun.provider,
    model: triageRun.model,
    attempts: triageRun.attempts,
    warnings: triageRun.warnings
  };
  next.mode = triage.workflow.finalMode;
  next.blockers = [];
  next.events.push({ state: "triaging", message: `Triage completed in ${next.mode} mode.`, timestamp: timestamp() });

  if (triage.clarification.required && !options.clarificationAlreadyAnswered) {
    next.clarification = {
      question: triage.clarification.question ?? "What specific behaviour or outcome should change?",
      reason: triage.clarification.reason ?? "The request requires one blocking clarification."
    };
    return transition(next, "awaiting_clarification", "One blocking clarification is required before planning.");
  }

  next.approach = buildApproach(triage, config);
  if (next.approach.required) return transition(next, "awaiting_approach_approval", "Approach recommendation is awaiting approval.");
  return withPlan(next, config);
}

function enforceOneClarification(triage: TriageOutput, clarificationAlreadyAnswered: boolean): TriageOutput {
  if (!clarificationAlreadyAnswered || !triage.clarification.required) return triage;
  const next = structuredClone(triage);
  next.clarification = { required: false, question: null, reason: null };
  next.assumptions = unique([...next.assumptions, "A blocking clarification was already answered; no further clarification question is permitted."]).slice(0, 3);
  return next;
}

function withPlan(state: SequentialWorkflowState, config?: LeanRigorConfig): SequentialWorkflowState {
  if (!state.triage) throw new WorkflowStateError("Cannot plan before triage completes.");
  const planning = transition(state, "planning", "Sequential plan generation started.");
  planning.plan = buildPlan(planning.request, state.triage, planning.root, config, {
    revisionRequests: planning.plan?.revisionRequests ?? []
  });
  return transition(planning, "awaiting_plan_approval", "Sequential plan is awaiting explicit approval.");
}

function buildApproach(triage: TriageOutput, config: LeanRigorConfig): ApproachRecommendation {
  const mode = triage.workflow.finalMode;
  const required = mode !== "fast" || !canSkipApproachGate(triage);
  const routing = mode === "rigorous"
    ? `${config.routing.rigorousPlanning} planning and ${config.routing.rigorousImplementation} implementation`
    : mode === "standard"
      ? `${config.routing.standardPlanning} planning and ${config.routing.standardImplementation} implementation`
      : `${config.routing.fastImplementation} implementation`;
  return {
    required,
    approved: !required,
    proposed: `${label(mode)} sequential workflow using ${routing}; no parallel agents, worktrees, commits, or pushes.`,
    preferredBecause: preferredBecause(triage),
    alternatives: mode === "rigorous"
      ? ["A Standard workflow would reduce ceremony but is not appropriate for the identified safety or blast-radius triggers."]
      : mode === "standard"
        ? ["A Fast workflow would be lighter but would under-validate a behavioral or medium-risk change."]
        : [],
    primaryRisks: primaryRisks(triage),
    validationStrategy: validationStrategy(mode, triage)
  };
}

function buildPlan(request: string, triage: TriageOutput, root: string, config?: LeanRigorConfig, options?: { revisionRequests?: ExecutionPlan["revisionRequests"] }): ExecutionPlan {
  const mode = triage.workflow.finalMode;
  const validationCommands = defaultValidationCommands(root, mode, triage);
  const targets = triage.inspection.targets.length > 0 ? triage.inspection.targets : ["relevant implementation boundary", "nearby tests"];
  const revisionNote = options?.revisionRequests?.at(-1)?.feedback;
  const boundaries = inferBoundaries(request, triage, targets);
  const phases = mode === "fast"
    ? fastPhases(targets, validationCommands)
    : mode === "standard"
      ? standardPhases(targets, validationCommands, boundaries)
      : rigorousPhases(targets, validationCommands, triage, boundaries);

  const plan: ExecutionPlan = {
    version: 1,
    summary: revisionNote
      ? `Sequential plan for: ${request.trim()} (revised for: ${revisionNote})`
      : `Sequential plan for: ${request.trim()}`,
    principles: [
      "Execute one phase at a time; do not unlock a later phase until dependencies complete.",
      "Keep phases as small functional outcomes with one objective, a deliverable, criteria, bounded expected areas, and validation expectations.",
      "Run or explicitly skip declared validation, then submit criterion evidence for the completion gate.",
      "Record changed files, commands, validation evidence, assumptions, risks, and scope deviations before moving on.",
      "Claude Code performs edits in the active coding session; LeanRigor persists state and gates."
    ],
    phases,
    revisionRequests: options?.revisionRequests ?? []
  };
  const issues = validatePlanQuality(plan, mode, config);
  if (issues.length > 0) throw new WorkflowStateError(`Generated plan did not satisfy phase-sizing rules: ${issues.join("; ")}`);
  return plan;
}

function fastPhases(targets: string[], validationCommands: string[]): WorkflowPhase[] {
  return [phase({
    id: "phase-1",
    objective: "Apply the small low-risk requested change.",
    rationale: "Fast mode keeps ceremony compact when triage found low ambiguity, low blast radius, and no material safety risk.",
    dependencies: [],
    areas: targets,
    acceptance: ["The requested change is implemented without unrelated edits.", "A targeted sanity check or explicit skipped-validation reason is recorded."],
    validationCommands,
    riskLevel: "low",
    modelTier: "inherit"
  })];
}

function standardPhases(targets: string[], validationCommands: string[], boundaries: BoundarySet): WorkflowPhase[] {
  if (boundaries.backend && boundaries.frontend) {
    return [
      phase({
        id: "phase-1",
        objective: "Add the backend behavior or public contract for the requested outcome.",
        rationale: "The backend boundary is an independently reviewable dependency for the frontend consumer.",
        dependencies: [],
        areas: filterAreas(targets, ["backend", "api", "service", "server", "src"]),
        acceptance: ["The backend outcome is implemented without unrelated refactoring.", "The contract or behavior can be inspected independently of UI changes."],
        validationCommands: validationCommands.slice(0, 1),
        riskLevel: "medium",
        modelTier: "medium"
      }),
      phase({
        id: "phase-2",
        objective: "Update the frontend consumer for the approved behavior.",
        rationale: "The consumer depends on the backend behavior or contract from phase-1.",
        dependencies: ["phase-1"],
        areas: filterAreas(targets, ["frontend", "ui", "client", "component", "app"]),
        acceptance: ["The frontend path uses the approved backend behavior or contract.", "No database, migration, or production configuration changes are introduced."],
        validationCommands: validationCommands.slice(0, 1),
        riskLevel: "medium",
        modelTier: "medium"
      }),
      phase({
        id: "phase-3",
        objective: "Add focused regression coverage for the changed behavior.",
        rationale: "Regression evidence should be reviewable separately from implementation edits.",
        dependencies: ["phase-2"],
        areas: unique([...targets, "nearby tests or package checks"]),
        acceptance: ["Targeted evidence exists for the changed behavior.", "Any skipped check has a concise reason accepted by the completion policy."],
        validationCommands,
        riskLevel: "medium",
        modelTier: "medium"
      })
    ];
  }
  const phases = [
    phase({
      id: "phase-1",
      objective: boundaries.publicContract
        ? "Add the public contract for the requested behavior."
        : "Implement the primary behavior for the requested outcome.",
      rationale: boundaries.publicContract
        ? "The public contract must be reviewable before any consumer or coverage updates."
        : "Standard mode keeps implementation focused on the primary functional outcome.",
      dependencies: [],
      areas: targets,
      acceptance: boundaries.publicContract
        ? ["The public contract is explicit and compatible with the approved request.", "No unrelated consumer or documentation edits are mixed into the contract change."]
        : ["The requested behavior follows nearby patterns.", "Scope remains limited to the approved request."],
      validationCommands: validationCommands.slice(0, 1),
      riskLevel: "medium",
      modelTier: "medium"
    }),
    phase({
      id: "phase-2",
      objective: "Add focused regression coverage for the changed behavior.",
      rationale: "Coverage is materially distinct from implementation and proves the behavior under review.",
      dependencies: ["phase-1"],
      areas: unique([...targets, "nearby tests or package checks"]),
      acceptance: ["Targeted evidence exists for the changed behavior.", "Any skipped check has a concise reason accepted by the completion policy."],
      validationCommands,
      riskLevel: "medium",
      modelTier: "medium"
    })
  ];
  if (boundaries.documentation) {
    phases.push(phase({
      id: "phase-3",
      objective: "Update user-facing documentation for the changed behavior.",
      rationale: "Documentation can be reviewed after behavior and regression evidence are in place.",
      dependencies: ["phase-2"],
      areas: ["README.md", "docs/**", "commands/**"],
      acceptance: ["Documentation reflects verified behavior.", "No runtime behavior changes are introduced in the documentation phase."],
      validationCommands: ["git diff --check"],
      riskLevel: "low",
      modelTier: "small"
    }));
  }
  return phases;
}

function rigorousPhases(targets: string[], validationCommands: string[], triage: TriageOutput, boundaries: BoundarySet): WorkflowPhase[] {
  const highRiskAreas = unique([
    ...targets,
    ...triage.escalationReasons.map((reason) => `risk: ${reason}`)
  ]);
  const firstObjective = boundaries.migration
    ? "Isolate the migration contract and rollback-sensitive assumptions."
    : boundaries.security
      ? "Isolate the security-sensitive contract and invariants."
      : boundaries.publicContract
        ? "Isolate the public contract and compatibility expectations."
        : "Isolate the high-risk boundary and safety assumptions.";
  return [
    phase({
      id: "phase-1",
      objective: firstObjective,
      rationale: "Rigorous work separates high-risk boundaries before behavior changes.",
      dependencies: [],
      areas: highRiskAreas,
      acceptance: ["The high-risk boundary is explicit and independently reviewable.", "The approved scope still matches the original request."],
      validationCommands: validationCommands.slice(0, 1),
      riskLevel: "high",
      modelTier: "large"
    }),
    phase({
      id: "phase-2",
      objective: "Implement the approved high-risk behavior change.",
      rationale: "The implementation phase depends on the established risk boundary.",
      dependencies: ["phase-1"],
      areas: targets,
      acceptance: ["The change preserves relevant contracts and invariants.", "Scope deviations are recorded before continuing."],
      validationCommands,
      riskLevel: "high",
      modelTier: "large"
    }),
    phase({
      id: "phase-3",
      objective: "Add high-risk regression and integration validation evidence.",
      rationale: "Rigorous mode requires broader evidence before final integrated review.",
      dependencies: ["phase-2"],
      areas: unique([...targets, "targeted and broader tests", "security, migration, API, or production checks where relevant"]),
      acceptance: ["Targeted and broader checks are recorded or explicitly skipped with reasons.", "The diff is ready for deep integrated review."],
      validationCommands,
      riskLevel: "high",
      modelTier: "large"
    })
  ];
}

interface BoundarySet {
  backend: boolean;
  frontend: boolean;
  migration: boolean;
  security: boolean;
  publicContract: boolean;
  documentation: boolean;
}

function inferBoundaries(request: string, triage: TriageOutput, targets: string[]): BoundarySet {
  const text = `${request} ${targets.join(" ")} ${triage.escalationReasons.join(" ")}`.toLowerCase();
  return {
    backend: /\b(api|backend|server|service|database|db|persistence|schema)\b/.test(text),
    frontend: /\b(frontend|front-end|ui|client|component|editor|page|view)\b/.test(text),
    migration: /\b(migration|migrations|rollback|schema change|database)\b/.test(text),
    security: /\b(auth|authentication|authorization|permission|credential|secret|security)\b/.test(text),
    publicContract: /\b(api|contract|schema|openapi|graphql|proto|public)\b/.test(text),
    documentation: /\b(doc|docs|documentation|readme)\b/.test(text)
  };
}

function filterAreas(targets: string[], keywords: string[]): string[] {
  const filtered = targets.filter((target) => keywords.some((keyword) => target.toLowerCase().includes(keyword)));
  return filtered.length > 0 ? filtered : targets;
}

export function validatePlanQuality(plan: ExecutionPlan, mode?: WorkflowMode, config?: LeanRigorConfig): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const phase of plan.phases) {
    if (ids.has(phase.id)) issues.push(`Phase ${phase.id} is duplicated.`);
    ids.add(phase.id);
    if (!phase.objective.trim()) issues.push(`Phase ${phase.id} is missing an objective.`);
    if (hasMultiplePrimaryObjectives(phase.objective)) issues.push(`Phase ${phase.id} appears to have multiple primary objectives.`);
    if (isBroadContainer(phase.objective)) issues.push(`Phase ${phase.id} is a vague or overly broad container.`);
    if (phase.acceptanceCriteria.length === 0) issues.push(`Phase ${phase.id} has no acceptance criteria.`);
    if (phase.acceptanceCriteria.some((criterion) => !isInspectableCriterion(criterion))) {
      issues.push(`Phase ${phase.id} has non-testable or non-inspectable acceptance criteria.`);
    }
    if (phase.validationCommands.length === 0) issues.push(`Phase ${phase.id} has no validation command or check expectation.`);
    if (phase.expectedFilesOrAreas.length === 0) issues.push(`Phase ${phase.id} has no bounded expected write area.`);
    if (phase.expectedFilesOrAreas.length >= (config?.taskSizing.reviewSplitThresholdFiles ?? 8) && mode !== "fast") {
      issues.push(`Phase ${phase.id} lists many expected write areas and should be reviewed for splitting.`);
    }
  }
  for (const phase of plan.phases) {
    for (const dependency of phase.dependencies) {
      if (!ids.has(dependency)) issues.push(`Phase ${phase.id} depends on missing phase ${dependency}.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.phases.map((phase) => [phase.id, phase]));
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      issues.push(`Dependency cycle detected at ${id}.`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const phase of plan.phases) visit(phase.id);
  if (mode === "fast" && plan.phases.length === 1) return unique(issues);
  const broadPhase = plan.phases.find((phase) => boundaryWordCount(phase.objective) > 1 && !/coverage|validation|documentation/.test(phase.objective.toLowerCase()));
  if (broadPhase) issues.push(`Phase ${broadPhase.id} mixes architectural boundaries.`);
  return unique(issues);
}

function hasMultiplePrimaryObjectives(objective: string): boolean {
  const lower = objective.toLowerCase();
  if (/\b(backend|frontend|tests?|docs?|documentation|migration|schema|api|consumer)\b.*\band\b.*\b(backend|frontend|tests?|docs?|documentation|migration|schema|api|consumer)\b/.test(lower)) return true;
  return /\b(update|add|implement|refactor|change|fix)\b.*\band\b.*\b(update|add|implement|refactor|change|fix)\b/.test(lower);
}

function isBroadContainer(objective: string): boolean {
  return /\b(whole feature|backend, frontend|frontend, tests|tests and docs|some related|various|everything|all changes|whole task)\b/i.test(objective);
}

function isInspectableCriterion(criterion: string): boolean {
  const lower = criterion.toLowerCase();
  if (/^(done|works|complete|as needed|tbd)\.?$/.test(lower.trim())) return false;
  return lower.length >= 12;
}

function boundaryWordCount(value: string): number {
  const lower = value.toLowerCase();
  return [
    /\bbackend|api|service|server\b/.test(lower),
    /\bfrontend|ui|client|component\b/.test(lower),
    /\btests?|coverage|validation\b/.test(lower),
    /\bdocs?|documentation|readme\b/.test(lower),
    /\bmigration|database|schema\b/.test(lower),
    /\bauth|security|permission|credential\b/.test(lower)
  ].filter(Boolean).length;
}

function phase(args: {
  id: string;
  objective: string;
  rationale: string;
  dependencies: string[];
  areas: string[];
  acceptance: string[];
  validationCommands: string[];
  riskLevel: RiskLevel;
  modelTier: ModelProfile;
}): WorkflowPhase {
  return {
    id: args.id,
    objective: args.objective,
    rationale: args.rationale,
    dependencies: args.dependencies,
    expectedFilesOrAreas: args.areas,
    acceptanceCriteria: args.acceptance,
    validationCommands: args.validationCommands,
    riskLevel: args.riskLevel,
    modelTier: args.modelTier,
    status: "pending",
    filesChanged: [],
    commandsRun: [],
    validationResults: [],
    scopeDeviations: [],
    repairAttempts: []
  };
}

function defaultValidationCommands(root: string, mode: WorkflowMode, triage: TriageOutput): string[] {
  const packageJson = readPackageJsonSync(root);
  const scripts = packageJson?.scripts ?? {};
  const commands: string[] = [];
  if (triage.task.type === "documentation") {
    if (scripts.lint) commands.push("npm run lint");
    commands.push("git diff --check");
    return unique(commands);
  }
  if (mode === "fast") {
    if (scripts.typecheck) commands.push("npm run typecheck");
    if (scripts.test) commands.push("npm test -- --runInBand");
    commands.push("git diff --check");
    return unique(commands);
  }
  if (scripts.test) commands.push("npm test");
  if (scripts.typecheck) commands.push("npm run typecheck");
  if (scripts.lint) commands.push("npm run lint");
  if (mode === "rigorous" && scripts.build) commands.push("npm run build");
  commands.push("git diff --check");
  return unique(commands);
}

function readPackageJsonSync(root: string): { scripts?: Record<string, string> } | undefined {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  } catch {
    return undefined;
  }
}

function appendRepairPhase(state: SequentialWorkflowState, repairScope: string): void {
  if (!state.plan) throw new WorkflowStateError("Cannot append a repair phase without a plan.");
  for (const phase of state.plan.phases) {
    if (phase.status === "active") phase.status = "blocked";
  }
  const previous = state.plan.phases.at(-1)?.id;
  const id = `repair-${state.repairAttempts}`;
  state.plan.phases.push(phase({
    id,
    objective: repairScope,
    rationale: "Integrated review found the smallest necessary repair scope.",
    dependencies: previous ? [previous] : [],
    areas: ["review findings", "current diff"],
    acceptance: ["The review finding is repaired without unrelated scope expansion.", "Validation evidence is updated after the repair."],
    validationCommands: state.plan.phases.at(-1)?.validationCommands ?? ["git diff --check"],
    riskLevel: state.mode === "rigorous" ? "high" : "medium",
    modelTier: state.mode === "rigorous" ? "large" : "medium"
  }));
  const repair = state.plan.phases.at(-1);
  if (repair) {
    repair.status = "active";
    repair.startedAt = timestamp();
  }
}

function buildCommitPlan(state: SequentialWorkflowState): CommitPlan {
  if (!state.plan) throw new WorkflowStateError("Cannot propose commits without a plan.");
  const graph: ExecutionGraph = {
    version: 1,
    tasks: state.plan.phases.map((phase) => ({
      id: phase.id,
      objective: phase.objective,
      reads: [],
      writes: phase.filesChanged,
      dependsOn: phase.dependencies,
      validation: phase.validationCommands,
      status: "completed"
    }))
  };
  const proposals = proposeCommits(graph);
  const groups = proposals.length > 0 ? proposals.map((proposal) => ({
    message: proposal.message,
    files: proposal.files,
    rationale: `Cohesive changes from ${proposal.taskIds.join(", ")}.`,
    commands: commitCommands(proposal)
  })) : [{
    message: "chore: record leanrigor workflow result",
    files: [],
    rationale: "No changed files were recorded in workflow state; inspect `git diff HEAD` before committing.",
    commands: ["git diff HEAD", "git status --short"]
  }];
  return {
    generatedAt: timestamp(),
    groups,
    note: "Proposal only. LeanRigor never runs git commit or git push automatically."
  };
}

function buildCompletionRecord(args: {
  state: SequentialWorkflowState;
  phase: WorkflowPhase;
  criteria?: CriterionCompletionEvidence[];
  assumptions?: string[];
  remainingRisks?: string[];
  blockedReason?: string;
  requestedRepairScope?: string;
  config?: LeanRigorConfig;
}): PhaseCompletionRecord {
  const criteria = normaliseCriteria(args.phase, args.criteria);
  const validation = summarisePhaseValidation(args.phase, args.state.mode, args.config);
  const policy = decideCompletionGate({
    phase: args.phase,
    criteria,
    validationStatus: validation.status,
    blockedReason: args.blockedReason,
    remainingRisks: args.remainingRisks ?? [],
    config: args.config,
    mode: args.state.mode
  });
  const decision = policy.decision;
  return {
    phaseId: args.phase.id,
    objective: args.phase.objective,
    criteria,
    filesChanged: args.phase.filesChanged,
    validation,
    scopeDeviations: args.phase.scopeDeviations,
    assumptions: unique(args.assumptions ?? []),
    remainingRisks: unique(args.remainingRisks ?? []),
    dependentPhasesMayProceed: decision === "completed",
    decision,
    reason: args.blockedReason ?? policy.reason ?? args.requestedRepairScope ?? "Completion gate evaluated.",
    repairAttempt: args.phase.repairAttempts.length,
    timestamp: timestamp(),
    workflowRevision: args.state.revision
  };
}

function normaliseCriteria(phase: WorkflowPhase, supplied?: CriterionCompletionEvidence[]): CriterionCompletionEvidence[] {
  const byCriterion = new Map((supplied ?? []).map((criterion) => [criterion.criterion, criterion]));
  return phase.acceptanceCriteria.map((criterion) => {
    const suppliedCriterion = byCriterion.get(criterion);
    return {
      criterion,
      status: suppliedCriterion?.status ?? "uncertain",
      evidence: unique(suppliedCriterion?.evidence ?? [])
    };
  });
}

function summarisePhaseValidation(phase: WorkflowPhase, mode: WorkflowMode, config?: LeanRigorConfig): PhaseCompletionRecord["validation"] {
  const activeRepair = phase.repairAttempts.find((attempt) => !attempt.outcome);
  const commands = activeRepair
    ? phase.validationResults.filter((evidence) => evidence.timestamp >= activeRepair.timestamp)
    : phase.validationResults;
  const skipped = commands.filter((evidence) => evidence.skipped).map((evidence) => ({
    command: evidence.command,
    reason: evidence.skippedReason ?? "No reason recorded."
  }));
  if (commands.some((evidence) => evidence.status === "failed" || (evidence.exitStatus ?? 0) !== 0 && !evidence.skipped)) {
    return { status: "failed", commands, skipped };
  }
  const expected = phase.validationCommands;
  const missing = expected.filter((command) => !commands.some((evidence) => sameCommand(evidence.command, command)));
  if (commands.length === 0 || missing.length > 0) {
    if (!gateRequiresValidation(config)) return { status: "passed", commands, skipped };
    return { status: "missing", commands, skipped };
  }
  if (commands.every((evidence) => evidence.status === "skipped")) {
    return { status: allowSkippedValidation(mode, config) ? "skipped" : "failed", commands, skipped };
  }
  if (commands.some((evidence) => evidence.status === "skipped" && !allowSkippedValidation(mode, config))) {
    return { status: "failed", commands, skipped };
  }
  return { status: "passed", commands, skipped };
}

function decideCompletionGate(args: {
  phase: WorkflowPhase;
  criteria: CriterionCompletionEvidence[];
  validationStatus: PhaseCompletionRecord["validation"]["status"];
  blockedReason?: string;
  remainingRisks: string[];
  config?: LeanRigorConfig;
  mode: WorkflowMode;
}): { decision: CompletionGateDecision; reason?: string } {
  if (!args.config?.completionGate.enabled && args.criteria.every((criterion) => criterion.status === "met" || criterion.status === "not_applicable")) {
    return { decision: "completed", reason: "Completion gate is disabled by configuration." };
  }
  if (args.blockedReason) return { decision: "blocked", reason: args.blockedReason };
  const materialDeviation = args.phase.scopeDeviations.find((deviation) => isMaterialScopeDeviation(deviation));
  if (materialDeviation) return { decision: "needs_replan", reason: materialDeviation };
  const highRiskDeviation = args.phase.scopeDeviations.find((deviation) => isReviewScopeDeviation(deviation));
  if (highRiskDeviation) return { decision: "needs_review", reason: highRiskDeviation };
  const notMet = args.criteria.find((criterion) => criterion.status === "not_met");
  if (notMet) return { decision: "needs_repair", reason: `Criterion not met: ${notMet.criterion}` };
  const uncertain = args.criteria.find((criterion) => criterion.status === "uncertain");
  if (uncertain) return { decision: "needs_review", reason: `Criterion uncertain: ${uncertain.criterion}` };
  if (gateRequiresEvidence(args.config)) {
    const missingEvidence = args.criteria.find((criterion) => criterion.status === "met" && criterion.evidence.length === 0);
    if (missingEvidence) return { decision: "needs_review", reason: `Evidence missing for criterion: ${missingEvidence.criterion}` };
  }
  if (args.validationStatus === "failed") return { decision: "needs_repair", reason: "Validation failed or skipped validation is not allowed in this mode." };
  if (args.validationStatus === "missing") return { decision: "needs_repair", reason: "Declared validation evidence is missing." };
  const criticalRisk = args.remainingRisks.find((risk) => /\b(critical|severe|data loss|security|unsafe)\b/i.test(risk));
  if (criticalRisk) return { decision: "needs_review", reason: `Critical remaining risk: ${criticalRisk}` };
  return { decision: "completed", reason: "All required criteria and validation expectations are satisfied." };
}

function detectScopeDeviations(phase: WorkflowPhase, config?: LeanRigorConfig): string[] {
  const deviations: string[] = [];
  const expected = phase.expectedFilesOrAreas.filter(isPathLikeArea);
  if (expected.length > 0) {
    for (const file of phase.filesChanged) {
      if (!expected.some((area) => areaMatchesFile(area, file))) deviations.push(`changed file outside expected scope: ${file}`);
    }
  }
  const objective = phase.objective.toLowerCase();
  for (const file of phase.filesChanged) {
    const lower = file.toLowerCase();
    if ((lower === "package.json" || lower === "package-lock.json" || lower.endsWith("/package.json")) && !/\b(dependency|package|build|tooling)\b/.test(objective)) {
      deviations.push(`production dependency or package manifest changed outside approved phase scope: ${file}`);
    }
    if (lower.includes("migration") && !/\bmigration|database|schema\b/.test(objective)) {
      deviations.push(`migration introduced outside approved phase scope: ${file}`);
    }
    if (/\b(api|schema|openapi|graphql|proto)\b/.test(lower) && !/\b(test|spec)\b/.test(lower) && !/\b(api|contract|schema|public|coverage|validation)\b/.test(objective)) {
      deviations.push(`public contract changed outside approved phase scope: ${file}`);
    }
    if (matchesConfiguredPath(file, config?.risk.rigorousPaths ?? []) && phase.riskLevel !== "high") {
      deviations.push(`sensitive path touched by non-rigorous phase: ${file}`);
    }
    const expectedDocumentation = phase.expectedFilesOrAreas.some((area) => /\b(document|copy|readme|docs?)\b/i.test(area));
    if ((/\b(readme|docs?|documentation)\b/.test(objective) || expectedDocumentation) && !/\.(md|mdx|txt|rst)$/.test(lower) && !lower.startsWith("docs/")) {
      deviations.push(`documentation phase changed runtime behavior: ${file}`);
    }
  }
  return unique(deviations);
}

function gateRequiresEvidence(config?: LeanRigorConfig): boolean {
  return config?.completionGate.requireEvidence ?? true;
}

function gateRequiresValidation(config?: LeanRigorConfig): boolean {
  return config?.completionGate.requireValidation ?? true;
}

function allowSkippedValidation(mode: WorkflowMode, config?: LeanRigorConfig): boolean {
  return config?.completionGate.allowSkippedValidation[mode] ?? mode === "fast";
}

function sameCommand(recorded: string, expected: string): boolean {
  return recorded.trim() === expected.trim();
}

function isPathLikeArea(area: string): boolean {
  return area.includes("/") || area.includes("*") || /\.[a-z0-9]+$/i.test(area);
}

function areaMatchesFile(area: string, file: string): boolean {
  const normalArea = area.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalArea.endsWith("/**")) return normalFile.startsWith(normalArea.slice(0, -3));
  if (normalArea.endsWith("/*")) {
    const prefix = normalArea.slice(0, -1);
    return normalFile.startsWith(prefix) && !normalFile.slice(prefix.length).includes("/");
  }
  if (normalArea.includes("*")) {
    const pattern = `^${normalArea.split("*").map(escapeRegex).join(".*")}$`;
    return new RegExp(pattern).test(normalFile);
  }
  if (!path.posix.extname(normalArea)) return normalFile === normalArea || normalFile.startsWith(`${normalArea}/`);
  return normalFile === normalArea;
}

function matchesConfiguredPath(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => areaMatchesFile(pattern, file));
}

function isMaterialScopeDeviation(deviation: string): boolean {
  return /outside expected scope|production dependency|migration introduced|public contract changed|documentation phase changed runtime/.test(deviation);
}

function isReviewScopeDeviation(deviation: string): boolean {
  return /sensitive path touched/.test(deviation);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selectStartablePhase(state: SequentialWorkflowState, phaseId?: string): WorkflowPhase {
  if (!state.plan) throw new WorkflowStateError("Cannot start a phase without a plan.");
  const plan = state.plan;
  if (plan.phases.some((phase) => phase.status === "active")) {
    throw new InvalidTransitionError("A phase is already active; complete it before starting another.");
  }
  const phase = phaseId
    ? plan.phases.find((candidate) => candidate.id === phaseId)
    : plan.phases.find((candidate) => candidate.status === "pending" && candidate.dependencies.every((id) => phaseById(plan, id)?.status === "completed"));
  if (!phase) throw new WorkflowStateError("No startable phase found.");
  if (phase.status !== "pending") throw new InvalidTransitionError(`Phase ${phase.id} is ${phase.status}; only a pending phase can be started.`);
  const blockedDependency = phase.dependencies.find((id) => phaseById(plan, id)?.status !== "completed");
  if (blockedDependency) throw new InvalidTransitionError(`Phase ${phase.id} depends on incomplete phase ${blockedDependency}.`);
  return phase;
}

function phaseById(plan: ExecutionPlan, id: string): WorkflowPhase | undefined {
  return plan.phases.find((phase) => phase.id === id);
}

function validateWorkflowEvidence(evidence: ValidationEvidence): void {
  validationEvidenceSchema.parse(evidence);
}

function hasValidationEvidence(state: SequentialWorkflowState): boolean {
  return state.validation.some((evidence) => evidence.status === "passed" || evidence.status === "skipped");
}

function canSkipApproachGate(triage: TriageOutput): boolean {
  return triage.workflow.finalMode === "fast"
    && triage.assessment.ambiguity === "low"
    && triage.assessment.blastRadius === "low"
    && triage.assessment.architecturalImpact === "low"
    && triage.assessment.securityRisk === "none"
    && triage.assessment.dataIntegrityRisk === "none"
    && triage.assessment.operationalRisk === "none";
}

function preferredBecause(triage: TriageOutput): string {
  if (triage.workflow.finalMode === "fast") return "Triage found a narrow low-risk change with enough clarity for a compact workflow.";
  if (triage.workflow.finalMode === "standard") return "Triage found a behavioral or medium-risk change that needs explicit planning and targeted evidence.";
  return triage.workflow.overrideReason ?? triage.escalationReasons[0] ?? "Triage identified high-risk or broad-impact work requiring stronger gates.";
}

function primaryRisks(triage: TriageOutput): string[] {
  const risks = [
    triage.assessment.securityRisk === "high" ? "security-sensitive behavior" : undefined,
    triage.assessment.dataIntegrityRisk === "high" ? "data integrity or migration risk" : undefined,
    triage.assessment.operationalRisk === "high" ? "production or operational risk" : undefined,
    triage.assessment.blastRadius !== "low" ? `${triage.assessment.blastRadius} blast radius` : undefined,
    triage.assessment.ambiguity !== "low" ? `${triage.assessment.ambiguity} ambiguity` : undefined
  ].filter((value): value is string => value !== undefined);
  return risks.length > 0 ? risks : ["unintended scope expansion"];
}

function validationStrategy(mode: WorkflowMode, triage: TriageOutput): string[] {
  if (mode === "fast") return ["syntax/type sanity where relevant", "targeted command or skipped-validation reason", "diff sanity check"];
  if (mode === "standard") return ["targeted tests", "package/module checks where available", "integrated review"];
  return [
    "targeted and broader tests",
    "security, migration, API, data, or production checks where relevant",
    `${triage.workflow.reviewLevel} integrated review`
  ];
}

function transition(state: SequentialWorkflowState, nextState: WorkflowLifecycleState, message: string): SequentialWorkflowState {
  const next = structuredClone(state);
  next.state = nextState;
  next.updatedAt = timestamp();
  next.events.push({ state: nextState, message, timestamp: next.updatedAt });
  return next;
}

function assertState(state: SequentialWorkflowState, allowed: WorkflowLifecycleState[]): void {
  if (!allowed.includes(state.state)) {
    throw new InvalidTransitionError(`Invalid transition from ${state.state}. Allowed state(s): ${allowed.join(", ")}.`);
  }
}

function workflowPath(root: string, workflowId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(workflowId)) throw new WorkflowNotFoundError(`Invalid workflow ID: ${workflowId}`);
  return path.join(path.resolve(root), WORKFLOW_DIR, `${workflowId}.json`);
}

function workflowId(): string {
  return `lr-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function label(mode: WorkflowMode): string {
  return mode[0].toUpperCase() + mode.slice(1);
}

function timestamp(): string {
  return new Date().toISOString();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function assertModelTierAvailable(tier: ModelTier, config: LeanRigorConfig, adapter: "claude" = "claude"): void {
  const resolved = resolveModelTier(tier, adapter, config);
  if (config.models.failIfUnavailable && tier !== "inherit" && !resolved.model) {
    throw new WorkflowStateError(`Model tier '${tier}' is unavailable for ${adapter}. Configure it with 'leanrigor models'.`);
  }
}
