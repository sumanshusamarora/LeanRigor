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
  recordReview,
  recordValidation,
  rejectApproach,
  resumeFlow,
  revisePlan,
  saveFlowState,
  startFlow
} from "../src/core/flow.js";
import type { SequentialWorkflowState } from "../src/core/types.js";

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

    const afterPhase1 = await completePhase({ root, workflowId: executing.id, phaseId: "phase-1", filesChanged: ["src/api.ts"] });
    expect(afterPhase1.state).toBe("executing");
    expect(afterPhase1.plan?.phases.map((phase) => phase.status)).toEqual(["completed", "active"]);
  });

  it("persists validation evidence and commit proposals without committing", async () => {
    const root = await tempRepo();
    const state = await runFastToReview(root);

    expect(state.state).toBe("awaiting_commit_approval");
    expect(state.validation[0]).toMatchObject({ command: "git diff --check", exitStatus: 0, status: "passed" });
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
    const validating = await completePhase({ root, workflowId: executing.id, phaseId: "phase-1", filesChanged: ["README.md"] });
    await recordValidation({ root, workflowId: validating.id, command: "git diff --check", exitStatus: 0, result: "ok" });

    const repair = await recordReview({ root, workflowId: validating.id, status: "needs_repair", summary: "One missing detail.", repairScope: "Tighten README wording.", config });
    expect(repair.state).toBe("executing");
    expect(repair.plan?.phases.at(-1)?.id).toBe("repair-1");

    const validatingAgain = await completePhase({ root, workflowId: repair.id, phaseId: "repair-1", filesChanged: ["README.md"] });
    await recordValidation({ root, workflowId: validatingAgain.id, command: "git diff --check", exitStatus: 0, result: "ok after repair" });
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
    const phase1 = await completePhase({ root, workflowId: executing.id, phaseId: "phase-1", filesChanged: ["src/api.ts"] });
    const validating = await completePhase({ root, workflowId: phase1.id, phaseId: "phase-2", filesChanged: ["src/api.test.ts"] });
    await recordValidation({ root, workflowId: validating.id, command: "npm test", exitStatus: 0, result: "targeted tests passed" });
    const reviewed = await recordReview({ root, workflowId: validating.id, status: "passed", summary: "Integrated review passed.", config: defaultConfig() });

    expect(reviewed.state).toBe("awaiting_commit_approval");
    expect(reviewed.commitPlan?.groups).toHaveLength(2);
  });

  it("runs a complete Rigorous deterministic flow", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Change authentication migration handling for production credentials", root, config: defaultConfig() });
    const executing = await approvePlan(root, (await approveApproach(root, started.id)).id);
    const phase1 = await completePhase({ root, workflowId: executing.id, phaseId: "phase-1", filesChanged: ["src/auth.ts"] });
    const phase2 = await completePhase({ root, workflowId: phase1.id, phaseId: "phase-2", filesChanged: ["src/auth.ts"] });
    const validating = await completePhase({ root, workflowId: phase2.id, phaseId: "phase-3", filesChanged: ["tests/auth.test.ts"] });
    await recordValidation({ root, workflowId: validating.id, command: "npm test", exitStatus: 0, result: "targeted and broader tests passed" });
    await recordValidation({ root, workflowId: validating.id, command: "npm run build", exitStatus: 0, result: "build passed" });
    const reviewed = await recordReview({ root, workflowId: validating.id, status: "passed", summary: "Deep integrated review passed.", config: defaultConfig() });

    expect(reviewed.mode).toBe("rigorous");
    expect(reviewed.state).toBe("awaiting_commit_approval");
  });
});

async function runFastToReview(root: string): Promise<SequentialWorkflowState> {
  const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
  const executing = await approvePlan(root, started.id);
  const validating = await completePhase({
    root,
    workflowId: executing.id,
    phaseId: "phase-1",
    filesChanged: ["README.md"],
    commandsRun: ["git diff --check"]
  });
  await recordValidation({ root, workflowId: validating.id, command: "git diff --check", exitStatus: 0, result: "diff sanity passed" });
  return recordReview({ root, workflowId: validating.id, status: "passed", summary: "Diff sanity review passed.", config: defaultConfig() });
}
