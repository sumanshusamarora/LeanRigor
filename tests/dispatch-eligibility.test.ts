import { describe, expect, it } from "vitest";
import { briefStalenessReasons } from "../src/core/approval.js";
import { evaluatePhaseDispatchEligibility } from "../src/core/dispatch-eligibility.js";
import { leasePhase, startPhase } from "../src/core/flow.js";
import { createExecutionHarness, currentState, testPhase } from "./helpers/execution-harness.js";

describe("central phase dispatch eligibility", () => {
  it("distinguishes dependency-ready from dispatch-ready before workspace preparation", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {}
    });
    const state = await currentState(harness);

    const eligibility = evaluatePhaseDispatchEligibility(state, "phase-a", harness.config, { explicitlySelected: true });

    expect(eligibility).toMatchObject({
      eligible: false,
      dependencyReady: true,
      dispatchReady: false,
      phaseId: "phase-a"
    });
    expect(eligibility.blockers.map((blocker) => blocker.code)).toContain("workspace_missing");
  });

  it("blocks pending and stale exact briefs", async () => {
    const pendingHarness = await createExecutionHarness({
      approveFirstPhase: false,
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {}
    });
    const pending = await currentState(pendingHarness);
    expect(evaluatePhaseDispatchEligibility(pending, "phase-a", pendingHarness.config, { stage: "preparation", explicitlySelected: true }).blockers.map((blocker) => blocker.code))
      .toContain("brief_not_approved");

    const staleHarness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {}
    });
    const stale = await currentState(staleHarness);
    stale.constraints!.effective.push({
      id: "constraint-new",
      text: "Do not change public contracts.",
      source: "user",
      createdAt: new Date().toISOString(),
      workflowRevision: stale.revision,
      transition: "test"
    });
    expect(evaluatePhaseDispatchEligibility(stale, "phase-a", staleHarness.config, { stage: "preparation", explicitlySelected: true }).blockers.map((blocker) => blocker.code))
      .toContain("brief_constraints_stale");
  });

  it("invalidates a brief when the approved plan revision or content changes", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {}
    });
    const state = await currentState(harness);
    state.approval!.workflowPlanRevision = state.phaseBriefs!["phase-a"]!.workflowRevision + 1;
    state.plan!.phases[0]!.objective = "Implement a materially revised phase objective.";

    expect(briefStalenessReasons(state, "phase-a").map((reason) => reason.code))
      .toEqual(expect.arrayContaining(["brief_plan_revision_stale", "brief_plan_stale"]));
  });

  it("invalidates a brief when the repository base changes", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: { "phase-a": { edits: [{ path: "src/a.ts", content: "ok\n" }] } }
    });
    await harness.coordinator.runNext();
    const state = await currentState(harness);
    state.git!.context.baseCommit = "updated-base-commit";

    expect(briefStalenessReasons(state, "phase-a").map((reason) => reason.code))
      .toContain("brief_repository_stale");
  });

  it("invalidates a later brief when a dependency outcome changes", async () => {
    const harness = await createExecutionHarness({
      phases: [
        testPhase("phase-a", ["src/a.ts"]),
        testPhase("phase-b", ["src/b.ts"], ["phase-a"])
      ],
      scripts: {}
    });
    const state = await currentState(harness);
    state.plan!.phases[0]!.status = "completed";

    expect(briefStalenessReasons(state, "phase-b").map((reason) => reason.code))
      .toContain("brief_prior_outcome_stale");
  });

  it("does not invalidate a brief for unrelated workflow metadata", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {}
    });
    const state = await currentState(harness);
    state.updatedAt = new Date(Date.parse(state.updatedAt) + 1_000).toISOString();
    state.revision += 1;

    expect(briefStalenessReasons(state, "phase-a")).toEqual([]);
  });

  it("prevents public lease and start paths from bypassing workspace preparation", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {}
    });

    await expect(leasePhase({
      root: harness.root,
      workflowId: harness.workflow.id,
      phaseId: "phase-a",
      ownerId: "manual",
      config: harness.config
    })).rejects.toThrow(/workspace_missing/);
    await expect(startPhase(harness.root, harness.workflow.id, "phase-a", { ownerId: "manual", config: harness.config }))
      .rejects.toThrow(/workspace_missing/);
  });

  it("requires explicit selection for an out-of-order dependency-ready phase", async () => {
    const harness = await createExecutionHarness({
      maxParallelPhases: 2,
      phases: [testPhase("phase-a", ["src/a.ts"]), testPhase("phase-b", ["src/b.ts"])],
      scripts: {}
    });
    const state = await currentState(harness);

    expect(evaluatePhaseDispatchEligibility(state, "phase-b", harness.config, { stage: "preparation" }).blockers.map((blocker) => blocker.code))
      .toContain("phase_not_selected");
    expect(evaluatePhaseDispatchEligibility(state, "phase-b", harness.config, { stage: "preparation", explicitlySelected: true }).blockers.map((blocker) => blocker.code))
      .not.toContain("phase_not_selected");
  });

  it("persists exact brief and workspace identity on a valid dispatch", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: { "phase-a": { edits: [{ path: "src/a.ts", content: "ok\n" }] } }
    });

    const result = await harness.coordinator.runNext();
    const state = await currentState(harness);
    const brief = state.phaseBriefs?.["phase-a"];
    const record = state.execution.records["phase-a"];

    expect(result.dispatched).toHaveLength(1);
    expect(record?.executionIdentity).toMatchObject({
      workflowId: state.id,
      phaseId: "phase-a",
      briefRevision: brief?.briefRevision,
      workspaceIdentity: state.git?.phaseWorkspaces["phase-a"]?.preparation?.workspaceIdentity,
      providerId: "scripted"
    });
  });

  it("quarantines a provider result for the wrong brief revision", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": {
          edits: [{ path: "src/a.ts", content: "wrong identity\n" }],
          resultIdentity: { briefRevision: 999 }
        }
      }
    });

    await harness.coordinator.runNext();
    const result = await harness.coordinator.poll();
    const state = await currentState(harness);

    expect(result.nextAction).toBe("await_user");
    expect(result.decision).toMatchObject({
      type: "material-drift-review",
      phaseId: "phase-a",
      question: expect.any(String),
      options: expect.arrayContaining([expect.objectContaining({ intent: "review-material-drift" })])
    });
    expect(state.execution.records["phase-a"]).toMatchObject({
      status: "blocked",
      diagnostics: { resultAccepted: false, disposition: "needs_replan" }
    });
    expect(state.plan?.phases[0]?.status).toBe("needs_replan");
  });

  it("persists provider material discovery and refuses completion authority", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": {
          edits: [{ path: "src/a.ts", content: "partial\n" }],
          discoveredMaterialChanges: [{
            category: "architecture",
            affectedPhase: "phase-a",
            severity: "high",
            material: true,
            reason: "The approved boundary cannot own the required contract change.",
            requiredTransition: "revise-plan"
          }]
        }
      }
    });

    await harness.coordinator.runNext();
    await harness.coordinator.poll();
    const state = await currentState(harness);

    expect(state.plan?.phases[0]?.status).toBe("needs_replan");
    expect(state.execution.records["phase-a"]?.diagnostics).toMatchObject({
      resultAccepted: false,
      discoveredMaterialChanges: [expect.objectContaining({ category: "architecture", material: true })]
    });
  });
});
