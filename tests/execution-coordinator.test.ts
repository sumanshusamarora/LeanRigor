import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ExecutionCoordinator } from "../src/core/execution/coordinator.js";
import { integrationStatus } from "../src/core/flow.js";
import { createExecutionHarness, currentState, testPhase } from "./helpers/execution-harness.js";

describe("execution coordinator", () => {
  it("runs sequential phases through gates, integration, combined validation, and final-review eligibility", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"]), testPhase("phase-b", ["src/b.ts"], ["phase-a"])],
      scripts: {
        "phase-a": { edits: [{ path: "src/a.ts", content: "export const a = 1;\n" }], validation: [{ command: "npm test", exitCode: 0 }] },
        "phase-b": { edits: [{ path: "src/b.ts", content: "export const b = 2;\n" }], validation: [{ command: "npm test", exitCode: 0 }] }
      }
    });

    expect((await harness.coordinator.runNext()).running.map((phase) => phase.phaseId)).toEqual(["phase-a"]);
    expect((await harness.coordinator.poll()).nextAction).toBe("dispatch");
    expect((await harness.coordinator.runNext()).running.map((phase) => phase.phaseId)).toEqual(["phase-b"]);
    const result = await harness.coordinator.poll();

    const state = await currentState(harness);
    expect(result.nextAction).toBe("final_review");
    expect(state.state).toBe("reviewing");
    expect(integrationStatus(state).finalReviewEligible).toBe(true);
    await expect(readFile(path.join(state.git!.integration.path, "src", "a.ts"), "utf8")).resolves.toBe("export const a = 1;\n");
    await expect(readFile(path.join(harness.root, "src", "a.ts"), "utf8")).rejects.toThrow();
    expect(await harness.git(["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("dispatches independent phases in parallel with distinct leases and worktrees", async () => {
    const harness = await createExecutionHarness({
      maxParallelPhases: 2,
      phases: [testPhase("phase-a", ["src/a.ts"]), testPhase("phase-b", ["src/b.ts"])],
      scripts: {
        "phase-a": { edits: [{ path: "src/a.ts", content: "a\n" }], validation: [{ command: "npm test", exitCode: 0 }] },
        "phase-b": { edits: [{ path: "src/b.ts", content: "b\n" }], validation: [{ command: "npm test", exitCode: 0 }] }
      }
    });

    const dispatched = await harness.coordinator.dispatchReady();
    expect(dispatched.dispatched.map((phase) => phase.phaseId).sort()).toEqual(["phase-a", "phase-b"]);
    expect(new Set(dispatched.dispatched.map((phase) => phase.leaseOwnerId)).size).toBe(2);
    expect(new Set(dispatched.dispatched.map((phase) => phase.workspacePath)).size).toBe(2);

    await harness.coordinator.poll();
    const state = await currentState(harness);
    expect(state.state).toBe("reviewing");
    expect(state.git?.integration.integratedPhaseIds).toEqual(["phase-a", "phase-b"]);
  });

  it("does not dispatch a dependent phase before its dependency is accepted and integrated", async () => {
    const harness = await createExecutionHarness({
      maxParallelPhases: 2,
      phases: [testPhase("phase-a", ["src/a.ts"]), testPhase("phase-c", ["src/c.ts"], ["phase-a"])],
      scripts: {
        "phase-a": { edits: [{ path: "src/a.ts", content: "a\n" }], validation: [{ command: "npm test", exitCode: 0 }], sleepMs: 100_000 },
        "phase-c": { edits: [{ path: "src/c.ts", content: "c\n" }], validation: [{ command: "npm test", exitCode: 0 }] }
      }
    });

    const dispatched = await harness.coordinator.dispatchReady();
    expect(dispatched.dispatched.map((phase) => phase.phaseId)).toEqual(["phase-a"]);
    expect((await currentState(harness)).plan?.phases.find((phase) => phase.id === "phase-c")?.status).toBe("planned");
  });

  it("blocks overlapping declared writes from parallel dispatch", async () => {
    const harness = await createExecutionHarness({
      maxParallelPhases: 2,
      phases: [testPhase("phase-left", ["src/shared.txt"]), testPhase("phase-right", ["src/shared.txt"])],
      scripts: {
        "phase-left": { edits: [{ path: "src/shared.txt", content: "left\n" }], validation: [{ command: "npm test", exitCode: 0 }] },
        "phase-right": { edits: [{ path: "src/shared.txt", content: "right\n" }], validation: [{ command: "npm test", exitCode: 0 }] }
      }
    });

    const dispatched = await harness.coordinator.dispatchReady();
    expect(dispatched.dispatched).toHaveLength(1);
  });

  it("preserves parallel results when an unexpected overlap conflicts during deterministic integration", async () => {
    const harness = await createExecutionHarness({
      maxParallelPhases: 2,
      phases: [
        { ...testPhase("phase-left", ["src/left.txt"]), expectedFilesOrAreas: ["src/**"] },
        { ...testPhase("phase-right", ["src/right.txt"]), expectedFilesOrAreas: ["src/**"] }
      ],
      scripts: {
        "phase-left": { edits: [{ path: "src/shared.txt", delete: true }], validation: [{ command: "npm test", exitCode: 0 }] },
        "phase-right": { edits: [{ path: "src/shared.txt", content: "right\n" }], validation: [{ command: "npm test", exitCode: 0 }] }
      }
    });

    await harness.coordinator.dispatchReady();
    const result = await harness.coordinator.poll();
    const state = await currentState(harness);

    expect(result.nextAction).toBe("resolve_conflict");
    expect(state.git?.integration.integratedPhaseIds).toEqual(["phase-left"]);
    expect(state.git?.integration.conflictingPhaseIds).toEqual(["phase-right"]);
    expect(state.execution.records["phase-right"]?.status).toBe("result_recorded");
  });

  it("keeps failed validation out of integration", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": { edits: [{ path: "src/a.ts", content: "a\n" }], validation: [{ command: "npm test", exitCode: 1, status: "failed" }] }
      }
    });

    await harness.coordinator.runNext();
    const result = await harness.coordinator.poll();
    const state = await currentState(harness);

    expect(result.nextAction).toBe("repair");
    expect(state.plan?.phases[0]?.status).toBe("needs_repair");
    expect(state.git?.integration.integratedPhaseIds).toEqual([]);
  });

  it("times out a running phase, cancels the provider, and preserves the dirty workspace", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const harness = await createExecutionHarness({
      workerTimeoutSeconds: 5,
      clock: () => now,
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": { edits: [{ path: "src/a.ts", content: "partial\n" }], validation: [{ command: "npm test", exitCode: 0 }], sleepMs: 100_000 }
      }
    });

    await harness.coordinator.runNext();
    now = new Date("2026-01-01T00:00:10.000Z");
    const result = await harness.coordinator.poll();
    const state = await currentState(harness);
    const workspace = state.git!.phaseWorkspaces["phase-a"]!.path;

    expect(result.nextAction).toBe("review");
    expect(state.execution.records["phase-a"]?.status).toBe("timed_out");
    expect(state.plan?.phases[0]?.status).toBe("needs_review");
    await expect(readFile(path.join(workspace, "src", "a.ts"), "utf8")).resolves.toBe("partial\n");
  });

  it("recovers after restart by polling a persisted execution handle with the same provider", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: { "phase-a": { edits: [{ path: "src/a.ts", content: "a\n" }], validation: [{ command: "npm test", exitCode: 0 }] } }
    });
    await harness.coordinator.runNext();

    const restarted = new ExecutionCoordinator({ root: harness.root, workflowId: harness.workflow.id, config: harness.config, provider: harness.provider });
    const result = await restarted.poll();

    expect(result.nextAction).toBe("final_review");
    expect((await currentState(harness)).execution.records["phase-a"]?.status).toBe("result_recorded");
  });

  it("allows a successful parallel worker to complete when another worker fails", async () => {
    const harness = await createExecutionHarness({
      maxParallelPhases: 2,
      phases: [testPhase("phase-good", ["src/good.ts"]), testPhase("phase-bad", ["src/bad.ts"])],
      scripts: {
        "phase-good": { edits: [{ path: "src/good.ts", content: "good\n" }], validation: [{ command: "npm test", exitCode: 0 }] },
        "phase-bad": { edits: [{ path: "src/bad.ts", content: "bad\n" }], result: "failed", summary: "Scripted worker failed." }
      }
    });

    await harness.coordinator.dispatchReady();
    const result = await harness.coordinator.poll();
    const state = await currentState(harness);

    expect(state.plan?.phases.find((phase) => phase.id === "phase-good")?.status).toBe("completed");
    expect(state.git?.integration.integratedPhaseIds).toEqual(["phase-good"]);
    expect(state.execution.records["phase-bad"]?.status).toBe("failed");
    expect(result.nextAction).toBe("review");
  });
});
