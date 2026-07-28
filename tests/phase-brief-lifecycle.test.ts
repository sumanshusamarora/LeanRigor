import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { approvalPermitsExecution } from "../src/core/approval.js";
import { ExecutionCoordinator } from "../src/core/execution/coordinator.js";
import type { ExecutionProvider } from "../src/core/execution/provider.js";
import {
  approvePhase,
  approvePlan,
  loadFlowState,
  preparePhaseExecutionBrief,
  saveFlowState,
  startFlow
} from "../src/core/flow.js";
import type { ExecutionPlan, WorkflowPhase } from "../src/core/types.js";
import { workflowNextSummary } from "../src/core/ux.js";

describe("detailed phase brief approval lifecycle", () => {
  it("persists a detailed pending brief and blocks coordinator dispatch before exact approval", async () => {
    const fixture = await lifecycleFixture();
    const approvedPlan = await approvePlan(
      fixture.root,
      fixture.workflowId,
      undefined,
      "phase-by-phase",
      fixture.config
    );
    const brief = approvedPlan.phaseBriefs?.["phase-1"];
    if (!brief) throw new Error(JSON.stringify(approvedPlan.phaseBriefFailures, null, 2));

    expect(brief).toMatchObject({
      phaseId: "phase-1",
      approvalStatus: "pending",
      validation: { status: "valid" },
      repository: { repositoryRevision: expect.any(String) }
    });
    expect(brief.implementationApproach).not.toBe(fixture.phase.rationale);
    expect(brief.relevantFiles).toContain("src/feature.ts");
    expect(approvedPlan.approval?.currentAuthorizedPhase).toBeUndefined();
    expect(approvedPlan.approval?.pendingDecision).toMatchObject({
      workflowRevision: brief.workflowRevision,
      phaseId: brief.phaseId,
      briefRevision: brief.briefRevision,
      status: "pending"
    });
    expect(approvalPermitsExecution(approvedPlan, "phase-1")).toBe(false);

    let providerStarts = 0;
    const provider: ExecutionProvider = {
      id: "must-not-start",
      async capabilities() {
        return {
          parallel: false,
          cancellation: false,
          heartbeats: false,
          structuredResults: true,
          diagnostics: []
        };
      },
      async dispatch() {
        providerStarts += 1;
        throw new Error("implementation provider must not start during phase preflight");
      },
      async getStatus() {
        throw new Error("not started");
      },
      async collectResult() {
        throw new Error("not started");
      },
      async cancel() {
        throw new Error("not started");
      }
    };
    const coordinator = new ExecutionCoordinator({
      root: fixture.root,
      workflowId: fixture.workflowId,
      config: fixture.config,
      provider
    });
    expect(await coordinator.runNext()).toMatchObject({ nextAction: "await_user", dispatched: [] });
    expect(providerStarts).toBe(0);
  });

  it("revises the brief, supersedes the old decision, and never carries approval forward", async () => {
    const fixture = await lifecycleFixture();
    const approvedPlan = await approvePlan(fixture.root, fixture.workflowId, undefined, "phase-by-phase", fixture.config);
    const original = approvedPlan.phaseBriefs?.["phase-1"];
    if (!original) throw new Error("expected original detailed brief");

    const revisedState = await preparePhaseExecutionBrief({
      root: fixture.root,
      workflowId: fixture.workflowId,
      phaseId: "phase-1",
      config: fixture.config,
      feedback: "Name the FeatureInput compatibility constraint explicitly.",
      refresh: true
    });
    const revised = revisedState.phaseBriefs?.["phase-1"];
    if (!revised) throw new Error(JSON.stringify(revisedState.phaseBriefFailures, null, 2));

    expect(revised.briefRevision).toBeGreaterThan(original.briefRevision);
    expect(revised.approvalStatus).toBe("pending");
    expect(revised.revisionRequests.at(-1)?.feedback).toContain("FeatureInput");
    expect(revisedState.approval?.decisionHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        briefRevision: original.briefRevision,
        status: "superseded"
      })
    ]));
    expect(revisedState.approval?.pendingDecision).toMatchObject({
      briefRevision: revised.briefRevision,
      workflowRevision: revised.workflowRevision,
      status: "pending"
    });
    expect(revisedState.approval?.currentAuthorizedPhase).toBeUndefined();

    await expect(approvePhase({
      root: fixture.root,
      workflowId: fixture.workflowId,
      phaseId: "phase-1",
      briefRevision: original.briefRevision,
      workflowRevision: original.workflowRevision
    })).rejects.toThrow(/no pending approval decision/i);

    const authorized = await approvePhase({
      root: fixture.root,
      workflowId: fixture.workflowId,
      phaseId: "phase-1",
      briefRevision: revised.briefRevision,
      workflowRevision: revised.workflowRevision
    });
    expect(authorized.approval?.currentAuthorizedPhase).toBe("phase-1");
    expect(authorized.phaseBriefs?.["phase-1"]?.approvalStatus).toBe("approved");
    expect(approvalPermitsExecution(authorized, "phase-1")).toBe(true);
  });

  it("renders required detailed sections, provenance, material changes, and exact actions", async () => {
    const fixture = await lifecycleFixture();
    const approvedPlan = await approvePlan(fixture.root, fixture.workflowId, undefined, "phase-by-phase", fixture.config);
    const next = workflowNextSummary(approvedPlan);
    const rendered = JSON.stringify(next);

    expect(next).toMatchObject({ label: "Phase execution brief", userDecisionRequired: true });
    for (const section of [
      "objective",
      "concreteDeliverable",
      "currentBehaviour",
      "implementationApproach",
      "affectedFilesAndSymbols",
      "acceptanceCriteria",
      "testObligations",
      "validationCommands",
      "dependencies",
      "assumptions",
      "exclusions",
      "risks",
      "changesFromApprovedWorkflowPlan",
      "inspectionProvenance"
    ]) {
      expect(rendered).toContain(section);
    }
    expect(rendered).toContain("repositoryRevision");
    expect(rendered).toContain("inspectedPaths");
    expect(next.approvalActions?.map((action) => action.label)).toEqual([
      "Approve Phase 1",
      "Revise Phase 1 brief",
      "View full details",
      "Cancel workflow"
    ]);
    expect(rendered).not.toContain("Approve this phase only");
  });

  it("persists an actionable recovery decision when brief scope is vague", async () => {
    const fixture = await lifecycleFixture();
    const state = await loadFlowState(fixture.root, fixture.workflowId);
    state.plan!.phases[0]!.expectedReadAreas = ["relevant implementation boundary"];
    state.plan!.phases[0]!.expectedWriteAreas = ["relevant implementation boundary"];
    state.plan!.phases[0]!.expectedFilesOrAreas = ["relevant implementation boundary"];
    await saveFlowState(fixture.root, state, { expectedRevision: state.revision });

    const approvedPlan = await approvePlan(fixture.root, fixture.workflowId, undefined, "phase-by-phase", fixture.config);

    expect(approvedPlan.phaseBriefs?.["phase-1"]).toBeUndefined();
    expect(approvedPlan.phaseBriefFailures?.["phase-1"]).toMatchObject({ status: "quality-blocked" });
    expect(approvedPlan.approval?.pendingDecision).toMatchObject({
      type: "execution-recovery",
      phaseId: "phase-1",
      status: "pending",
      allowedActions: ["retry-brief", "revise-plan", "view-details", "cancel-workflow"]
    });
    expect(approvedPlan.approval?.currentAuthorizedPhase).toBeUndefined();
    expect(workflowNextSummary(approvedPlan)).toMatchObject({
      label: "Phase Execution Brief unavailable",
      userDecisionRequired: true
    });
  });
});

async function lifecycleFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "leanrigor-brief-lifecycle-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(path.join(root, "src", "feature.ts"), "export interface FeatureInput { enabled: boolean }\nexport function applyFeature(input: FeatureInput) { return input.enabled; }\n");
  await writeFile(path.join(root, "tests", "feature.test.ts"), "export const featureRegression = true;\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }));
  const config = defaultConfig();
  const started = await startFlow({
    request: "Fix the typed regression in src/feature.ts and tests/feature.test.ts.",
    root,
    config
  });
  const state = await loadFlowState(root, started.id);
  const phase = concretePhase();
  const plan: ExecutionPlan = {
    version: 1,
    summary: "Fix the bounded typed feature regression.",
    principles: ["Preserve the existing FeatureInput contract."],
    phases: [phase],
    revisionRequests: []
  };
  state.state = "awaiting_plan_approval";
  state.mode = "rigorous";
  state.plan = plan;
  state.approval = undefined;
  state.blockers = [];
  await saveFlowState(root, state, { expectedRevision: state.revision });
  return { root, config, workflowId: state.id, phase };
}

function concretePhase(): WorkflowPhase {
  return {
    id: "phase-1",
    objective: "Preserve typed feature evaluation for enabled and disabled inputs.",
    rationale: "A bounded regression affects the existing FeatureInput contract.",
    dependencies: [],
    dependsOn: [],
    expectedReadAreas: ["src/feature.ts", "tests/feature.test.ts"],
    expectedWriteAreas: ["src/feature.ts", "tests/feature.test.ts"],
    expectedFilesOrAreas: ["src/feature.ts", "tests/feature.test.ts"],
    acceptanceCriteria: [
      "Feature evaluation returns true for enabled input and false for disabled input.",
      "The existing FeatureInput contract remains loadable by TypeScript."
    ],
    validationCommands: ["npm test", "npm run typecheck"],
    riskLevel: "medium",
    modelTier: "medium",
    status: "planned",
    ownershipUncertain: false,
    filesChanged: [],
    commandsRun: [],
    validationResults: [],
    scopeDeviations: [],
    repairAttempts: []
  };
}
