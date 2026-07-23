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
  ExecutionGraph,
  ExecutionPlan,
  IntegratedReviewResult,
  ModelProfile,
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
  status: z.enum(["pending", "active", "completed", "blocked"]),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  filesChanged: z.array(z.string()),
  commandsRun: z.array(z.string()),
  validationResults: z.array(validationEvidenceSchema),
  scopeDeviations: z.array(z.string())
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

export async function approveApproach(root: string, workflowId: string): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, (state) => {
    assertState(state, ["awaiting_approach_approval"]);
    if (!state.approach) throw new WorkflowStateError("No approach recommendation is available.");
    const next = structuredClone(state);
    next.approach = { ...state.approach, approved: true };
    next.events.push({ state: "awaiting_approach_approval", message: "Approach approved.", timestamp: timestamp() });
    return withPlan(next);
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

export async function revisePlan(root: string, workflowId: string, feedback: string): Promise<SequentialWorkflowState> {
  return updateFlowState(root, workflowId, (state) => {
    assertState(state, ["awaiting_plan_approval", "executing", "validating", "reviewing"]);
    if (!state.triage) throw new WorkflowStateError("Cannot revise a plan before triage completes.");
    const next = structuredClone(state);
    const triage = state.triage;
    const previousRequests = next.plan?.revisionRequests ?? [];
    next.plan = buildPlan(next.request, triage, next.root, {
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
  filesChanged?: string[];
  commandsRun?: string[];
  scopeDeviations?: string[];
}): Promise<SequentialWorkflowState> {
  return updateFlowState(args.root, args.workflowId, (state) => {
    assertState(state, ["executing"]);
    if (!state.plan) throw new WorkflowStateError("Cannot complete a phase without a plan.");
    const next = structuredClone(state);
    const plan = next.plan;
    if (!plan) throw new WorkflowStateError("Cannot complete a phase without a plan.");
    const phase = plan.phases.find((candidate) => candidate.id === args.phaseId);
    if (!phase) throw new WorkflowStateError(`Unknown phase: ${args.phaseId}`);
    if (phase.status !== "active") throw new InvalidTransitionError(`Phase ${phase.id} is ${phase.status}; only an active phase can be completed.`);
    phase.status = "completed";
    phase.completedAt = timestamp();
    phase.filesChanged = unique([...phase.filesChanged, ...(args.filesChanged ?? [])]);
    phase.commandsRun = [...phase.commandsRun, ...(args.commandsRun ?? [])];
    phase.scopeDeviations = [...phase.scopeDeviations, ...(args.scopeDeviations ?? [])];
    next.events.push({ state: "executing", message: `Phase ${phase.id} completed.`, timestamp: timestamp() });

    const nextPhase = plan.phases.find((candidate) => candidate.status === "pending" && candidate.dependencies.every((id) => phaseById(plan, id)?.status === "completed"));
    if (nextPhase) {
      nextPhase.status = "active";
      nextPhase.startedAt = timestamp();
      next.events.push({ state: "executing", message: `Phase ${nextPhase.id} started.`, timestamp: timestamp() });
      return next;
    }

    const unfinished = plan.phases.find((candidate) => candidate.status !== "completed");
    if (unfinished) return next;
    return transition(next, "validating", "All phases completed; targeted validation is required.");
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
      return active
        ? [`leanrigor flow phase-complete ${id} ${active.id} --files "<comma-separated>" --command "<command>" --root "${state.root}"`]
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
  return withPlan(next);
}

function enforceOneClarification(triage: TriageOutput, clarificationAlreadyAnswered: boolean): TriageOutput {
  if (!clarificationAlreadyAnswered || !triage.clarification.required) return triage;
  const next = structuredClone(triage);
  next.clarification = { required: false, question: null, reason: null };
  next.assumptions = unique([...next.assumptions, "A blocking clarification was already answered; no further clarification question is permitted."]).slice(0, 3);
  return next;
}

function withPlan(state: SequentialWorkflowState): SequentialWorkflowState {
  if (!state.triage) throw new WorkflowStateError("Cannot plan before triage completes.");
  const planning = transition(state, "planning", "Sequential plan generation started.");
  planning.plan = buildPlan(planning.request, state.triage, planning.root, {
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

function buildPlan(request: string, triage: TriageOutput, root: string, options?: { revisionRequests?: ExecutionPlan["revisionRequests"] }): ExecutionPlan {
  const mode = triage.workflow.finalMode;
  const validationCommands = defaultValidationCommands(root, mode, triage);
  const targets = triage.inspection.targets.length > 0 ? triage.inspection.targets : ["relevant implementation boundary", "nearby tests"];
  const revisionNote = options?.revisionRequests?.at(-1)?.feedback;
  const phases = mode === "fast"
    ? fastPhases(targets, validationCommands)
    : mode === "standard"
      ? standardPhases(targets, validationCommands)
      : rigorousPhases(targets, validationCommands, triage);

  return {
    version: 1,
    summary: revisionNote
      ? `Sequential plan for: ${request.trim()} (revised for: ${revisionNote})`
      : `Sequential plan for: ${request.trim()}`,
    principles: [
      "Execute one phase at a time; do not unlock a later phase until dependencies complete.",
      "Record changed files, commands, validation evidence, and scope deviations before moving on.",
      "Claude Code performs edits in the active coding session; LeanRigor persists state and gates."
    ],
    phases,
    revisionRequests: options?.revisionRequests ?? []
  };
}

function fastPhases(targets: string[], validationCommands: string[]): WorkflowPhase[] {
  return [phase({
    id: "phase-1",
    objective: "Apply the small low-risk change and verify the immediate diff.",
    rationale: "Fast mode keeps ceremony compact when triage found low ambiguity, low blast radius, and no material safety risk.",
    dependencies: [],
    areas: targets,
    acceptance: ["The requested change is implemented without unrelated edits.", "A targeted sanity check or explicit skipped-validation reason is recorded."],
    validationCommands,
    riskLevel: "low",
    modelTier: "inherit"
  })];
}

function standardPhases(targets: string[], validationCommands: string[]): WorkflowPhase[] {
  return [
    phase({
      id: "phase-1",
      objective: "Inspect the relevant boundary and implement the requested behavior.",
      rationale: "Standard mode first resolves the concrete implementation boundary before editing.",
      dependencies: [],
      areas: targets,
      acceptance: ["The implementation follows nearby patterns.", "Scope remains limited to the approved request."],
      validationCommands: validationCommands.slice(0, 1),
      riskLevel: "medium",
      modelTier: "medium"
    }),
    phase({
      id: "phase-2",
      objective: "Add focused coverage or checks for the changed behavior.",
      rationale: "The validation phase should prove the behavioral change rather than only inspecting the diff.",
      dependencies: ["phase-1"],
      areas: unique([...targets, "nearby tests or package checks"]),
      acceptance: ["Targeted evidence exists for the changed behavior.", "Any skipped check has a concise reason."],
      validationCommands,
      riskLevel: "medium",
      modelTier: "medium"
    })
  ];
}

function rigorousPhases(targets: string[], validationCommands: string[], triage: TriageOutput): WorkflowPhase[] {
  const highRiskAreas = unique([
    ...targets,
    ...triage.escalationReasons.map((reason) => `risk: ${reason}`)
  ]);
  return [
    phase({
      id: "phase-1",
      objective: "Confirm the high-risk boundary, contracts, and rollback-sensitive assumptions.",
      rationale: "Rigorous work needs explicit risk containment before implementation starts.",
      dependencies: [],
      areas: highRiskAreas,
      acceptance: ["Security, migration, API, data, or production concerns are identified where relevant.", "The approved scope still matches the original request."],
      validationCommands: validationCommands.slice(0, 1),
      riskLevel: "high",
      modelTier: "large"
    }),
    phase({
      id: "phase-2",
      objective: "Implement the approved change with compatibility and safety checks preserved.",
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
      objective: "Harden validation evidence across the affected integration boundary.",
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
    scopeDeviations: []
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
