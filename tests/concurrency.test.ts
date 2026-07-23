import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import {
  approvePlan,
  completePhase,
  heartbeatPhase,
  leasePhase,
  loadFlowState,
  readyPhases,
  recoverLeases,
  recordValidation,
  releasePhase,
  saveFlowState,
  startFlow
} from "../src/core/flow.js";
import { detectOwnershipConflicts, normalizeOwnershipPattern } from "../src/core/ownership.js";
import { validatePhaseDag, topologicalPhaseOrder } from "../src/core/scheduler.js";
import type { CriterionCompletionEvidence, ExecutionPlan, SequentialWorkflowState, WorkflowPhase } from "../src/core/types.js";
import { acquireWorkflowLock, refreshWorkflowLock, releaseWorkflowLock, WorkflowLockBusyError } from "../src/core/workflow-lock.js";
import { RevisionConflictError } from "../src/core/workflow-store.js";

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "leanrigor-concurrency-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }));
  return root;
}

describe("parallel-ready workflow concurrency", () => {
  it("rejects stale expected revisions with structured conflict data", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });

    await expect(approvePlan(root, state.id, { expectedRevision: state.revision - 1 })).rejects.toMatchObject({
      code: "revision_conflict",
      expectedRevision: state.revision - 1
    } satisfies Partial<RevisionConflictError>);
  });

  it("protects workflow locks from second owners and stale release", async () => {
    const root = await tempRepo();
    const first = await acquireWorkflowLock({ root, workflowId: "lr-test", ownerId: "a", operation: "test", timeoutSeconds: 30 });

    await expect(acquireWorkflowLock({ root, workflowId: "lr-test", ownerId: "b", operation: "test", timeoutSeconds: 30 })).rejects.toBeInstanceOf(WorkflowLockBusyError);
    await expect(refreshWorkflowLock(root, "lr-test", "a", 30)).resolves.toMatchObject({ ownerId: "a" });
    await expect(releaseWorkflowLock(root, "lr-test", "b")).rejects.toThrow(/owned by a/);
    await releaseWorkflowLock(root, "lr-test", first.ownerId);
  });

  it("recovers an expired workflow lock deterministically", async () => {
    const root = await tempRepo();
    await acquireWorkflowLock({ root, workflowId: "lr-expired", ownerId: "a", operation: "test", timeoutSeconds: 1, now: new Date("2026-01-01T00:00:00.000Z") });

    const recovered = await acquireWorkflowLock({ root, workflowId: "lr-expired", ownerId: "b", operation: "test", timeoutSeconds: 30, now: new Date("2026-01-01T00:00:02.000Z") });

    expect(recovered.ownerId).toBe("b");
    await releaseWorkflowLock(root, "lr-expired", "b");
  });

  it("validates phase DAGs and stable topological order", () => {
    const plan = planWithPhases([
      testPhase("b", ["src/b.ts"], ["a"]),
      testPhase("a", ["src/a.ts"]),
      testPhase("c", ["src/c.ts"], ["a"])
    ]);

    expect(validatePhaseDag(plan)).toEqual([]);
    expect(topologicalPhaseOrder(plan)).toEqual(["a", "b", "c"]);
    expect(validatePhaseDag(planWithPhases([testPhase("a", ["src/a.ts"], ["missing"])]))).toContain("Phase a depends on missing phase missing.");
    expect(validatePhaseDag(planWithPhases([testPhase("a", ["src/a.ts"], ["a"])])).join("\n")).toMatch(/depends on itself|cycle/);
    expect(validatePhaseDag(planWithPhases([testPhase("a", ["src/a.ts"], ["b"]), testPhase("b", ["src/b.ts"], ["a"])])).join("\n")).toMatch(/cycle/);
  });

  it("detects ownership conflicts and normalizes unsafe paths", () => {
    const conflicts = detectOwnershipConflicts([
      testPhase("a", ["src/api/**"]),
      testPhase("b", ["src/api/routes.ts"]),
      testPhase("c", ["docs/**"])
    ], defaultConfig());

    expect(conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ phaseA: "a", phaseB: "b", kind: "write_write", severity: "blocking" })]));
    expect(detectOwnershipConflicts([testPhase("pkg-a", ["package.json"]), testPhase("pkg-b", ["package.json"])], defaultConfig())).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "sensitive_shared" })])
    );
    expect(() => normalizeOwnershipPattern("../escape.ts")).toThrow(/Invalid/);
  });

  it("leases, heartbeats, rejects duplicate owners, releases without completing, and requires lease ownership", async () => {
    const root = await tempRepo();
    const executing = await workflowWithPlan(root, planWithPhases([testPhase("phase-a", ["src/a.ts"])]));
    const leased = await leasePhase({ root, workflowId: executing.id, phaseId: "phase-a", ownerId: "owner-a", config: defaultConfig() });

    expect(leased.plan?.phases[0]?.status).toBe("leased");
    await expect(leasePhase({ root, workflowId: executing.id, phaseId: "phase-a", ownerId: "owner-b", config: defaultConfig() })).rejects.toThrow(/active lease/);
    const heartbeated = await heartbeatPhase({ root, workflowId: executing.id, phaseId: "phase-a", ownerId: "owner-a", config: defaultConfig() });
    expect(heartbeated.phaseLeases["phase-a"]?.ownerId).toBe("owner-a");
    await expect(completePhase({ root, workflowId: executing.id, phaseId: "phase-a", mutation: { ownerId: "owner-b" } })).rejects.toThrow(/active lease held by owner-b/);
    const released = await releasePhase({ root, workflowId: executing.id, phaseId: "phase-a", ownerId: "owner-a" });
    expect(released.plan?.phases[0]?.status).toBe("ready");
  });

  it("runs the concurrency smoke scenario without launching agents or committing", async () => {
    const root = await tempRepo();
    const config = defaultConfig();
    const plan = planWithPhases([
      testPhase("phase-backend", ["src/api/**"]),
      testPhase("phase-docs", ["docs/**", "README.md"])
    ]);
    plan.phases[0]!.objective = "Implement the backend API phase.";
    const executing = await workflowWithPlan(root, plan);

    let schedule = readyPhases(executing, config);
    expect(schedule.readyPhases.map((phase) => phase.phaseId)).toEqual(["phase-backend", "phase-docs"]);
    expect(schedule.dispatchableCount).toBe(1);

    config.execution.maxParallelPhases = 2;
    schedule = readyPhases(executing, config);
    expect(schedule.dispatchableCount).toBe(2);

    const backend = await leasePhase({ root, workflowId: executing.id, phaseId: "phase-backend", ownerId: "backend-owner", config });
    await leasePhase({ root, workflowId: executing.id, phaseId: "phase-docs", ownerId: "docs-owner", config });
    await expect(leasePhase({ root, workflowId: executing.id, phaseId: "phase-docs", ownerId: "other-owner", config })).rejects.toThrow(/active lease/);
    await expect(heartbeatPhase({ root, workflowId: executing.id, phaseId: "phase-backend", ownerId: "backend-owner", config, mutation: { expectedRevision: backend.revision } })).rejects.toMatchObject({ code: "revision_conflict" });

    await heartbeatPhase({ root, workflowId: executing.id, phaseId: "phase-backend", ownerId: "backend-owner", config });
    const stale = await loadFlowState(root, executing.id);
    stale.phaseLeases["phase-docs"]!.expiresAt = "2026-01-01T00:00:00.000Z";
    await saveFlowState(root, stale, { expectedRevision: stale.revision });
    const recovered = await recoverLeases({ root, workflowId: executing.id, now: new Date("2026-01-01T00:00:01.000Z") });
    expect(recovered.plan?.phases.find((phase) => phase.id === "phase-docs")?.status).toBe("ready");

    await recordValidation({
      root,
      workflowId: executing.id,
      phaseId: "phase-backend",
      command: "npm test",
      exitStatus: 0,
      result: "passed"
    });
    const current = await loadFlowState(root, executing.id);
    const phase = current.plan!.phases.find((candidate) => candidate.id === "phase-backend")!;
    const completed = await completePhase({
      root,
      workflowId: executing.id,
      phaseId: "phase-backend",
      config,
      criteria: metCriteria(phase),
      filesChanged: ["src/api/routes.ts"],
      commandsRun: phase.validationCommands,
      mutation: { ownerId: "backend-owner" }
    });

    expect(completed.plan?.phases.find((candidate) => candidate.id === "phase-backend")?.status).toBe("completed");
    expect(completed.state).toBe("executing");
    expect(completed.commitPlan).toBeUndefined();
  });

  it("dispatches only one overlapping write candidate at higher parallelism", async () => {
    const root = await tempRepo();
    const config = defaultConfig();
    config.execution.maxParallelPhases = 2;
    const executing = await workflowWithPlan(root, planWithPhases([
      testPhase("phase-api", ["src/api/**"]),
      testPhase("phase-route", ["src/api/routes.ts"])
    ]));

    const schedule = readyPhases(executing, config);

    expect(schedule.readyPhases).toHaveLength(2);
    expect(schedule.readyPhases.flatMap((phase) => phase.conflictsWith)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "write_write" })]));
    expect(schedule.dispatchableCount).toBe(1);
  });
});

async function workflowWithPlan(root: string, plan: ExecutionPlan): Promise<SequentialWorkflowState> {
  const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
  const state = await loadFlowState(root, started.id);
  state.state = "awaiting_plan_approval";
  state.plan = plan;
  state.approach = { required: false, approved: true, proposed: "test", preferredBecause: "test", alternatives: [], primaryRisks: [], validationStrategy: [] };
  await saveFlowState(root, state, { expectedRevision: state.revision });
  return approvePlan(root, state.id);
}

function planWithPhases(phases: WorkflowPhase[]): ExecutionPlan {
  return {
    version: 1,
    summary: "Test plan",
    principles: ["Test phases are explicit."],
    phases,
    revisionRequests: []
  };
}

function testPhase(id: string, writes: string[], dependencies: string[] = []): WorkflowPhase {
  return {
    id,
    objective: `Implement ${id}.`,
    rationale: "Test phase.",
    dependencies,
    dependsOn: dependencies,
    expectedReadAreas: writes,
    expectedWriteAreas: writes,
    expectedFilesOrAreas: writes,
    acceptanceCriteria: [`${id} is implemented with evidence.`],
    validationCommands: ["npm test"],
    riskLevel: "medium",
    modelTier: "medium",
    status: "planned",
    filesChanged: [],
    commandsRun: [],
    validationResults: [],
    scopeDeviations: [],
    repairAttempts: []
  };
}

function metCriteria(phase: WorkflowPhase): CriterionCompletionEvidence[] {
  return phase.acceptanceCriteria.map((criterion) => ({
    criterion,
    status: "met",
    evidence: [`Evidence recorded for ${phase.id}.`]
  }));
}
