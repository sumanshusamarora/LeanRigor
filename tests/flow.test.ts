import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import {
  answerClarification,
  approveApproach,
  approvePlan,
  cancelFlow,
  completeFlow,
  completePhase,
  getCommitPlan,
  listFlows,
  loadFlowState,
  repairPhase,
  recordReview,
  recordValidation,
  rejectApproach,
  resumeFlow,
  revisePlan,
  saveFlowState,
  startFlow,
  validatePlanQuality
} from "../src/core/flow.js";
import type { CriterionCompletionEvidence, SequentialWorkflowState, ValidationEvidence, WorkflowPhase } from "../src/core/types.js";

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "leanrigor-flow-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: {
      test: "vitest run",
      typecheck: "tsc --noEmit",
      lint: "eslint .",
      build: "tsc -p tsconfig.build.json"
    }
  }));
  return root;
}

describe("sequential workflow orchestration", () => {
  it("creates a persisted workflow with triage and an ID", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });

    expect(state.id).toMatch(/^lr-/);
    expect(state.mode).toBe("fast");
    expect(state.triageRun?.source).toBe("deterministic-fallback");
    await expect(readFile(path.join(root, ".leanrigor", "workflows", `${state.id}.json`), "utf8")).resolves.toContain(state.request);
  });

  it("supports at most one blocking clarification and persists the answer", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "fix", root, config: defaultConfig() });

    expect(state.state).toBe("awaiting_clarification");
    expect(state.clarification?.question).toBe("What specific behaviour or outcome should change?");

    const answered = await answerClarification({
      root,
      workflowId: state.id,
      answer: "Fix the broken login redirect after successful authentication.",
      config: defaultConfig()
    });

    expect(answered.clarification?.answer).toMatch(/login redirect/);
    expect(answered.triage?.clarification.required).toBe(false);
    expect(answered.state).toBe("awaiting_approach_approval");
  });

  it("skips unnecessary approach approval for obvious Fast work", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });

    expect(state.mode).toBe("fast");
    expect(state.approach?.required).toBe(false);
    expect(state.state).toBe("awaiting_plan_approval");
    expect(state.plan?.phases).toHaveLength(1);
  });

  it("requires plan approval for Standard work after approach approval", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });

    expect(started.mode).toBe("standard");
    expect(started.state).toBe("awaiting_approach_approval");

    const planned = await approveApproach(root, started.id);
    expect(planned.state).toBe("awaiting_plan_approval");
    expect(planned.plan?.phases).toHaveLength(2);
  });

  it("requires stronger gates and phases for Rigorous work", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Change authentication migration handling for production credentials", root, config: defaultConfig() });
    const planned = await approveApproach(root, started.id);

    expect(started.mode).toBe("rigorous");
    expect(started.approach?.required).toBe(true);
    expect(planned.plan?.phases).toHaveLength(3);
    expect(planned.plan?.phases.every((phase) => phase.modelTier === "large")).toBe(true);
    expect(planned.plan?.phases[0]?.objective).toMatch(/migration|security/i);
  });

  it("validates one-objective phase sizing and rejects broad containers", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const planned = await approveApproach(root, state.id);
    const plan = structuredClone(planned.plan);
    if (!plan) throw new Error("expected plan");
    plan.phases[0] = {
      ...plan.phases[0],
      objective: "Update backend, frontend, tests and docs",
      acceptanceCriteria: ["Done"],
      validationCommands: []
    };

    const issues = validatePlanQuality(plan, "standard", defaultConfig());
    expect(issues.join("\n")).toMatch(/multiple primary objectives|broad|validation|acceptance/i);
  });

  it("splits Standard backend and frontend work into cohesive phases", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the backend and frontend assignment API regression", root, config: defaultConfig() });
    const planned = await approveApproach(root, started.id);

    expect(planned.mode).toBe("standard");
    expect(planned.plan?.phases.map((phase) => phase.objective)).toEqual([
      "Add the backend behavior or public contract for the requested outcome.",
      "Update the frontend consumer for the approved behavior.",
      "Add focused regression coverage for the changed behavior."
    ]);
  });

  it("rejects invalid transitions", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });

    await expect(completePhase({ root, workflowId: state.id, phaseId: "phase-1" })).rejects.toThrow(/Invalid transition/);
  });

  it("persists plan revisions before approval", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const revised = await revisePlan(root, state.id, "Keep the change limited to README.md.");

    expect(revised.state).toBe("awaiting_plan_approval");
    expect(revised.plan?.revisionRequests.at(-1)?.feedback).toMatch(/README/);
  });

  it("unlocks phases sequentially", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const planned = await approveApproach(root, started.id);
    const executing = await approvePlan(root, planned.id);

    expect(executing.plan?.phases.map((phase) => phase.status)).toEqual(["active", "pending"]);

    const afterPhase1 = await completePhaseWithEvidence(root, executing, "phase-1", ["src/api.ts"]);
    expect(afterPhase1.state).toBe("executing");
    expect(afterPhase1.plan?.phases.map((phase) => phase.status)).toEqual(["completed", "active"]);
    expect(afterPhase1.plan?.phases[0]?.completion?.dependentPhasesMayProceed).toBe(true);
  });

  it("prevents direct completion without validation and evidence", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);

    const gated = await completePhase({
      root,
      workflowId: executing.id,
      phaseId: "phase-1",
      config: defaultConfig(),
      filesChanged: ["README.md"]
    });

    expect(gated.plan?.phases[0]?.status).toBe("needs_review");
    expect(gated.plan?.phases[0]?.completion?.dependentPhasesMayProceed).toBe(false);
  });

  it("failed phase validation moves to needs_repair and keeps dependents locked", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const executing = await approvePlan(root, (await approveApproach(root, started.id)).id);

    const failed = await completePhaseWithEvidence(root, executing, "phase-1", ["src/api.ts"], { validationStatus: "failed" });

    expect(failed.plan?.phases.map((phase) => phase.status)).toEqual(["needs_repair", "pending"]);
    expect(failed.plan?.phases[0]?.completion?.validation.status).toBe("failed");
  });

  it("passing repair validation clears an earlier failed phase gate", async () => {
    const root = await tempRepo();
    const config = defaultConfig();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config });
    const executing = await approvePlan(root, (await approveApproach(root, started.id)).id);
    const failed = await completePhaseWithEvidence(root, executing, "phase-1", ["src/api.ts"], { validationStatus: "failed", config });
    const repairing = await repairPhase({ root, workflowId: failed.id, phaseId: "phase-1", reason: "Fix failed validation.", config });

    const repaired = await completePhaseWithEvidence(root, repairing, "phase-1", ["src/api.ts"], { validationStatus: "passed", config });

    expect(repaired.plan?.phases[0]?.status).toBe("completed");
    expect(repaired.plan?.phases[0]?.validationResults.some((evidence) => evidence.status === "failed")).toBe(true);
    expect(repaired.plan?.phases[1]?.status).toBe("active");
  });

  it("uncertain criteria require review", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);
    const phase = executing.plan?.phases[0];
    if (!phase) throw new Error("expected phase");

    const reviewed = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"], {
      criteria: phase.acceptanceCriteria.map((criterion) => ({ criterion, status: "uncertain", evidence: ["Looks plausible but not inspected."] }))
    });

    expect(reviewed.plan?.phases[0]?.status).toBe("needs_review");
  });

  it("scope expansion is recorded and escalated for replanning", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);

    const replanned = await completePhaseWithEvidence(root, executing, "phase-1", ["src/runtime.ts"]);

    expect(replanned.plan?.phases[0]?.status).toBe("needs_replan");
    expect(replanned.plan?.phases[0]?.scopeDeviations.join("\n")).toMatch(/documentation phase changed runtime behavior/);
  });

  it("external blockers stop the workflow", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);

    const blocked = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"], { blockedReason: "Required credentials are unavailable." });

    expect(blocked.state).toBe("blocked");
    expect(blocked.plan?.phases[0]?.status).toBe("blocked");
  });

  it("missing criterion evidence requires review", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);
    const phase = executing.plan?.phases[0];
    if (!phase) throw new Error("expected phase");

    const reviewed = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"], {
      criteria: phase.acceptanceCriteria.map((criterion) => ({ criterion, status: "met", evidence: [] }))
    });

    expect(reviewed.plan?.phases[0]?.status).toBe("needs_review");
    expect(reviewed.plan?.phases[0]?.completion?.reason).toMatch(/Evidence missing/);
  });

  it("allows skipped validation in Fast and rejects it in Standard", async () => {
    const fastRoot = await tempRepo();
    const fastStarted = await startFlow({ request: "Fix a typo in README documentation", root: fastRoot, config: defaultConfig() });
    const fastExecuting = await approvePlan(fastRoot, fastStarted.id);
    const fastComplete = await completePhaseWithEvidence(fastRoot, fastExecuting, "phase-1", ["README.md"], { validationStatus: "skipped" });
    expect(fastComplete.plan?.phases[0]?.status).toBe("completed");

    const standardRoot = await tempRepo();
    const standardStarted = await startFlow({ request: "Fix the broken assignment API regression", root: standardRoot, config: defaultConfig() });
    const standardExecuting = await approvePlan(standardRoot, (await approveApproach(standardRoot, standardStarted.id)).id);
    const standardRepair = await completePhaseWithEvidence(standardRoot, standardExecuting, "phase-1", ["src/api.ts"], { validationStatus: "skipped" });
    expect(standardRepair.plan?.phases[0]?.status).toBe("needs_repair");
  });

  it("detects changed files outside expected scope", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const executing = await approvePlan(root, (await approveApproach(root, started.id)).id);
    if (!executing.plan) throw new Error("expected plan");
    executing.plan.phases[0].expectedFilesOrAreas = ["src/api.ts"];
    await saveFlowState(root, executing, { expectedRevision: executing.revision });

    const replanned = await completePhaseWithEvidence(root, executing, "phase-1", ["src/other.ts"]);

    expect(replanned.plan?.phases[0]?.status).toBe("needs_replan");
    expect(replanned.plan?.phases[0]?.scopeDeviations.join("\n")).toMatch(/outside expected scope/);
  });

  it("bounds per-phase repair attempts", async () => {
    const root = await tempRepo();
    const config = defaultConfig();
    config.completionGate.maxRepairAttempts.fast = 1;
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config });
    const executing = await approvePlan(root, started.id);
    const failed = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"], { validationStatus: "failed", config });
    const repairing = await repairPhase({ root, workflowId: failed.id, phaseId: "phase-1", reason: "Fix failed validation.", config });
    const failedAgain = await completePhaseWithEvidence(root, repairing, "phase-1", ["README.md"], { validationStatus: "failed", config });
    const exhausted = await repairPhase({ root, workflowId: failedAgain.id, phaseId: "phase-1", reason: "Retry again.", config });

    expect(exhausted.plan?.phases[0]?.status).toBe("needs_review");
    expect(exhausted.plan?.phases[0]?.completion?.reason).toMatch(/Repair budget exhausted/);
  });

  it("persists completion records across resume", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);
    const completed = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"]);
    const resumed = await loadFlowState(root, completed.id);

    expect(resumed.plan?.phases[0]?.completion?.criteria[0]?.status).toBe("met");
    expect(resumed.plan?.phases[0]?.completion?.workflowRevision).toBeGreaterThanOrEqual(0);
  });

  it("requires final integrated review after all phase gates pass", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);
    const validating = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"]);

    expect(validating.state).toBe("validating");
    expect(validating.commitPlan).toBeUndefined();
  });

  it("deterministic policy overrides an optimistic model gate result", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);
    const failed = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"], { validationStatus: "failed", modelDecision: "completed" });

    expect(failed.plan?.phases[0]?.status).toBe("needs_repair");
    expect(failed.plan?.phases[0]?.completion?.decision).not.toBe("completed");
  });

  it("persists validation evidence and commit proposals without committing", async () => {
    const root = await tempRepo();
    const state = await runFastToReview(root);

    expect(state.state).toBe("awaiting_commit_approval");
    expect(state.validation).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "git diff --check", exitStatus: 0, status: "passed" })
    ]));
    expect(state.commitPlan?.note).toMatch(/never runs git commit/i);

    const proposal = await getCommitPlan(root, state.id);
    expect(proposal.groups[0].commands.join("\n")).toMatch(/git commit -m/);
  });

  it("limits integrated review repair loops", async () => {
    const root = await tempRepo();
    const config = defaultConfig();
    config.budgets.repairRounds = 1;
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config });
    const executing = await approvePlan(root, started.id);
    const validating = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"]);

    const repair = await recordReview({ root, workflowId: validating.id, status: "needs_repair", summary: "One missing detail.", repairScope: "Tighten README wording.", config });
    expect(repair.state).toBe("executing");
    expect(repair.plan?.phases.at(-1)?.id).toBe("repair-1");

    const validatingAgain = await completePhaseWithEvidence(root, repair, "repair-1", ["README.md"]);
    const blocked = await recordReview({ root, workflowId: validatingAgain.id, status: "needs_repair", summary: "Still incomplete.", repairScope: "Second repair.", config });
    expect(blocked.state).toBe("blocked");
    expect(blocked.blockers[0]).toMatch(/Repair budget exhausted/);
  });

  it("can reject approach and cancel workflows", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });

    const rejected = await rejectApproach(root, started.id, "Need a different implementation direction.");
    expect(rejected.state).toBe("blocked");

    const second = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const cancelled = await cancelFlow(root, second.id);
    expect(cancelled.state).toBe("cancelled");
  });

  it("survives process-style resume and lists repository-local workflows", async () => {
    const root = await tempRepo();
    const created = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const resumed = await resumeFlow(root, created.id);
    const listed = await listFlows(root);

    expect(resumed.id).toBe(created.id);
    expect(listed.map((entry) => entry.id)).toContain(created.id);
  });

  it("detects stale and corrupted workflow state", async () => {
    const root = await tempRepo();
    const created = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const stale = structuredClone(created) as SequentialWorkflowState;
    await revisePlan(root, created.id, "Add a diff sanity note.");

    await expect(saveFlowState(root, stale, { expectedRevision: stale.revision })).rejects.toThrow(/expected/);

    await writeFile(path.join(root, ".leanrigor", "workflows", "broken.json"), "{ nope");
    await expect(loadFlowState(root, "broken")).rejects.toThrow(/corrupted/i);
  });

  it("runs a complete Fast deterministic flow", async () => {
    const root = await tempRepo();
    const reviewed = await runFastToReview(root);
    const completed = await completeFlow(root, reviewed.id);

    expect(completed.state).toBe("completed");
  });

  it("runs a complete Standard deterministic flow", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const executing = await approvePlan(root, (await approveApproach(root, started.id)).id);
    const phase1 = await completePhaseWithEvidence(root, executing, "phase-1", ["src/api.ts"]);
    const validating = await completePhaseWithEvidence(root, phase1, "phase-2", ["src/api.test.ts"]);
    const reviewed = await recordReview({ root, workflowId: validating.id, status: "passed", summary: "Integrated review passed.", config: defaultConfig() });

    expect(reviewed.state).toBe("awaiting_commit_approval");
    expect(reviewed.commitPlan?.groups).toHaveLength(2);
  });

  it("runs a complete Rigorous deterministic flow", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Change authentication migration handling for production credentials", root, config: defaultConfig() });
    const executing = await approvePlan(root, (await approveApproach(root, started.id)).id);
    const phase1 = await completePhaseWithEvidence(root, executing, "phase-1", ["src/auth.ts"]);
    const phase2 = await completePhaseWithEvidence(root, phase1, "phase-2", ["src/auth.ts"]);
    const validating = await completePhaseWithEvidence(root, phase2, "phase-3", ["tests/auth.test.ts"]);
    const reviewed = await recordReview({ root, workflowId: validating.id, status: "passed", summary: "Deep integrated review passed.", config: defaultConfig() });

    expect(reviewed.mode).toBe("rigorous");
    expect(reviewed.state).toBe("awaiting_commit_approval");
  });
});

async function runFastToReview(root: string): Promise<SequentialWorkflowState> {
  const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
  const executing = await approvePlan(root, started.id);
  const validating = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"]);
  return recordReview({ root, workflowId: validating.id, status: "passed", summary: "Diff sanity review passed.", config: defaultConfig() });
}

async function completePhaseWithEvidence(root: string, state: SequentialWorkflowState, phaseId: string, filesChanged: string[], options: {
  criteria?: CriterionCompletionEvidence[];
  validationStatus?: "passed" | "failed" | "skipped";
  scopeDeviations?: string[];
  assumptions?: string[];
  remainingRisks?: string[];
  blockedReason?: string;
  config?: ReturnType<typeof defaultConfig>;
  modelDecision?: "completed" | "needs_repair" | "needs_review" | "needs_replan" | "blocked";
} = {}): Promise<SequentialWorkflowState> {
  const current = await resumeFlow(root, state.id);
  const phase = current.plan?.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) throw new Error(`Missing phase ${phaseId}`);
  for (const evidence of validationEvidenceFor(phase, options.validationStatus ?? "passed")) {
    await recordValidation({
      root,
      workflowId: state.id,
      phaseId,
      command: evidence.command,
      exitStatus: evidence.exitStatus,
      result: evidence.result,
      skipped: evidence.skipped,
      skippedReason: evidence.skippedReason
    });
  }
  return completePhase({
    root,
    workflowId: state.id,
    phaseId,
    config: options.config ?? defaultConfig(),
    criteria: options.criteria ?? metCriteria(phase),
    filesChanged,
    commandsRun: phase.validationCommands,
    scopeDeviations: options.scopeDeviations,
    assumptions: options.assumptions,
    remainingRisks: options.remainingRisks,
    blockedReason: options.blockedReason,
    modelDecision: options.modelDecision
  });
}

function metCriteria(phase: WorkflowPhase): CriterionCompletionEvidence[] {
  return phase.acceptanceCriteria.map((criterion) => ({
    criterion,
    status: "met",
    evidence: [`Evidence recorded for ${phase.id}: ${criterion}`]
  }));
}

function validationEvidenceFor(phase: WorkflowPhase, status: "passed" | "failed" | "skipped"): ValidationEvidence[] {
  return phase.validationCommands.map((command, index) => ({
    phaseId: phase.id,
    command,
    exitStatus: status === "skipped" ? null : status === "failed" && index === 0 ? 1 : 0,
    result: status === "failed" && index === 0 ? "validation failed" : status === "skipped" ? "validation skipped" : "validation passed",
    status: status === "failed" && index === 0 ? "failed" : status,
    skipped: status === "skipped",
    skippedReason: status === "skipped" ? "Not relevant for this deterministic test." : undefined,
    timestamp: new Date().toISOString()
  }));
}
