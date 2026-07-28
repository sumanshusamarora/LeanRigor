import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExecutionCoordinator, detectCodeIntelligence } from "../src/core/execution/coordinator.js";
import { completePhase, integrationStatus } from "../src/core/flow.js";
import type { ExecutionProvider } from "../src/core/execution/provider.js";
import type { PhaseExecutionInput, PhaseExecutionResult } from "../src/core/execution/types.js";
import { phaseWorkerPrompt } from "../src/core/execution/prompt.js";
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
    await expect(readFile(path.join(state.git!.integration.path, "src", "a.ts"), "utf8")).resolves.toSatisfy((content) => content.replaceAll("\r\n", "\n") === "export const a = 1;\n");
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

  it("blocks provider dispatch when dependency preparation requires approval", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": { edits: [{ path: "src/a.ts", content: "provider should not run\n" }], validation: [{ command: "npm test", exitCode: 0 }] }
      }
    });
    await writeFile(path.join(harness.root, "package.json"), JSON.stringify({
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "^3.2.0" }
    }));
    await writeFile(path.join(harness.root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { devDependencies: { vitest: "^3.2.0" } } } }));
    await harness.git(["add", "package.json", "package-lock.json"]);
    await harness.git(["commit", "-m", "add locked dependencies"]);

    const result = await harness.coordinator.dispatchReady();
    const state = await currentState(harness);
    const workspace = state.git?.phaseWorkspaces["phase-a"];

    expect(result.executionMode).toBe("coordinator");
    expect(result.dispatched).toEqual([]);
    expect(workspace?.preparation).toMatchObject({
      status: "blocked",
      packageManager: "npm",
      dependencies: "missing",
      bootstrapRequired: true,
      bootstrapCommand: "npm ci",
      approvalRequired: true
    });
    expect(state.execution.records["phase-a"]).toBeUndefined();
    await expect(readFile(path.join(workspace!.path, "src", "a.ts"), "utf8")).rejects.toThrow();
  });

  it("hands the persisted execution owner to the provider and rejects direct spoofed provider completion", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": { edits: [{ path: "src/a.ts", content: "unused\n" }], validation: [{ command: "npm test", exitCode: 0 }] }
      }
    });
    let capturedInput: PhaseExecutionInput | undefined;
    const provider: ExecutionProvider = {
      id: "capturing-provider",
      async capabilities() {
        return { parallel: false, cancellation: true, heartbeats: true, structuredResults: true, diagnostics: [] };
      },
      async dispatch(input) {
        capturedInput = input;
        return {
          providerId: "capturing-provider",
          providerExecutionId: "provider-run-1",
          workflowId: input.workflowId,
          phaseId: input.phaseId,
          leaseOwnerId: input.leaseOwnerId,
          workspacePath: input.workspacePath,
          startedAt: new Date().toISOString(),
          lastKnownStatus: "running"
        };
      },
      async getStatus() {
        return { status: "running" };
      },
      async collectResult(): Promise<PhaseExecutionResult> {
        throw new Error("not used");
      },
      async cancel() {}
    };
    const coordinator = new ExecutionCoordinator({ root: harness.root, workflowId: harness.workflow.id, config: harness.config, provider });

    const dispatched = await coordinator.dispatchReady();
    const state = await currentState(harness);
    const lease = state.phaseLeases["phase-a"]!;

    expect(dispatched.dispatched).toHaveLength(1);
    expect(capturedInput).toMatchObject({
      phaseId: "phase-a",
      leaseOwnerId: lease.ownerId,
      selectedMode: "standard",
      workspacePreparation: {
        status: "available",
        packageManager: "npm",
        dependencies: "not_applicable",
        worktreePath: expect.stringContaining("phase-a"),
        repositoryIdentity: expect.stringMatching(/^root-sha256:/),
        validationCommandsAvailable: true
      }
    });
    const prompt = phaseWorkerPrompt(capturedInput!);
    expect(prompt).toContain("Workspace status: prepared");
    expect(prompt).toContain("Do not install dependencies unless LeanRigor explicitly marks preparation incomplete");
    expect(lease.ownerType).toBe("agent");
    await expect(completePhase({
      root: harness.root,
      workflowId: harness.workflow.id,
      phaseId: "phase-a",
      mutation: { ownerId: lease.ownerId }
    })).rejects.toThrow(/owned by an execution provider/);
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
    expect(state.execution.records["phase-a"]?.checkpoint).toMatchObject({
      dirty: true,
      changedFiles: ["src/a.ts"],
      note: expect.stringContaining("not accepted")
    });
    expect(state.plan?.phases[0]?.status).toBe("needs_review");
    await expect(readFile(path.join(workspace, "src", "a.ts"), "utf8")).resolves.toBe("partial\n");
  });

  it("captures tracked, untracked, and deleted partial changes on provider failure without accepting them", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/**"])],
      scripts: {
        "phase-a": {
          edits: [
            { path: "src/shared.txt", delete: true },
            { path: "src/new.ts", content: "export const value = 1;\n" },
            { path: "notes.txt", content: "partial note\n" }
          ],
          result: "failed",
          summary: "error_max_turns"
        }
      }
    });

    await harness.coordinator.runNext();
    const result = await harness.coordinator.poll();
    const state = await currentState(harness);
    const record = state.execution.records["phase-a"];

    expect(result.nextAction).toBe("review");
    expect(record?.status).toBe("failed");
    expect(record?.checkpoint).toMatchObject({
      dirty: true,
      trackedModified: [],
      deletedFiles: ["src/shared.txt"],
      untrackedFiles: ["notes.txt", "src/new.ts"]
    });
    expect(record?.checkpoint?.diffSummary.text).toContain("src/shared.txt");
    expect(record?.diagnostics).toMatchObject({ partialProgressPreserved: true, partialProgressAccepted: false });
    expect(state.plan?.phases[0]?.status).toBe("needs_review");
    expect(state.git?.integration.integratedPhaseIds).toEqual([]);
    await expect(readFile(path.join(state.git!.phaseWorkspaces["phase-a"]!.path, "notes.txt"), "utf8")).resolves.toBe("partial note\n");
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

  it("distinguishes CodeGraph support for exact worktrees, root-advisory indexes, and unavailable indexes", async () => {
    const bin = await mkdtemp(path.join(tmpdir(), "leanrigor-codegraph-bin-"));
    const originalPath = process.env.PATH;
    const command = process.platform === "win32" ? "codegraph.cmd" : "codegraph";
    await writeFile(path.join(bin, command), process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n", "utf8");
    if (process.platform !== "win32") await chmod(path.join(bin, command), 0o755);
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    try {
      const root = await mkdtemp(path.join(tmpdir(), "leanrigor-codegraph-root-"));
      const phase = await mkdtemp(path.join(tmpdir(), "leanrigor-codegraph-phase-"));
      await mkdir(path.join(root, ".codegraph"));

      expect(await detectCodeIntelligence(root, root)).toMatchObject({ codegraph: "exact-worktree" });
      expect(await detectCodeIntelligence(phase, root)).toMatchObject({ codegraph: "root-advisory" });
      expect(await detectCodeIntelligence(phase, phase)).toMatchObject({ codegraph: "unavailable" });
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
