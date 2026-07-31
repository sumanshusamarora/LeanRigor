import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExecutionCoordinator, detectCodeIntelligence } from "../src/core/execution/coordinator.js";
import { approvePhase, approveWorkspaceBootstrap, completePhase, integrationStatus, preparePhaseExecutionBrief, saveFlowState } from "../src/core/flow.js";
import type { ExecutionProvider } from "../src/core/execution/provider.js";
import type { PhaseExecutionInput, PhaseExecutionResult } from "../src/core/execution/types.js";
import type { ScriptedPhase } from "../src/core/execution/scripted-provider.js";
import { phaseWorkerPrompt } from "../src/core/execution/prompt.js";
import { workflowNextSummary } from "../src/core/ux.js";
import type { StructuredDecisionProvider, StructuredDecisionRequest } from "../src/core/structured-decision.js";
import { createExecutionHarness, currentState, testPhase } from "./helpers/execution-harness.js";

describe("execution coordinator", () => {
  it("does not start coordinator execution while the Phase 1 brief decision is pending", async () => {
    const harness = await createExecutionHarness({
      approveFirstPhase: false,
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": { edits: [{ path: "src/a.ts", content: "should not run\n" }], validation: [{ command: "npm test", exitCode: 0 }] }
      }
    });

    const result = await harness.coordinator.runNext();
    const state = await currentState(harness);

    expect(result).toMatchObject({ nextAction: "await_user", dispatched: [] });
    expect(state.approval?.pendingDecision).toMatchObject({ phaseId: "phase-a", status: "pending" });
    expect(state.execution.records).toEqual({});
    expect(state.git).toBeUndefined();
  });

  it("runs sequential phases through gates, integration, combined validation, and final-review eligibility", async () => {
    const harness = await createExecutionHarness({
      approvalPolicy: "phase-by-phase",
      phases: [testPhase("phase-a", ["src/a.ts"]), testPhase("phase-b", ["src/b.ts"], ["phase-a"])],
      scripts: {
        "phase-a": { edits: [{ path: "src/a.ts", content: "export const a = 1;\n" }], validation: [{ command: "npm test", exitCode: 0 }] },
        "phase-b": { edits: [{ path: "src/b.ts", content: "export const b = 2;\n" }], validation: [{ command: "npm test", exitCode: 0 }] }
      }
    });

    expect((await harness.coordinator.runNext()).running.map((phase) => phase.phaseId)).toEqual(["phase-a"]);
    expect((await harness.coordinator.poll()).nextAction).toBe("await_user");
    const phaseBState = await currentState(harness);
    const phaseBDecision = phaseBState.approval?.pendingDecision;
    expect(phaseBDecision).toMatchObject({ type: "phase-brief-approval", phaseId: "phase-b", status: "pending" });
    expect(phaseBState.phaseBriefs?.["phase-b"]?.repository).toMatchObject({
      baseCommit: phaseBState.git?.context.baseCommit,
      repositoryRevision: phaseBState.git?.integration.headCommit
    });
    expect(phaseBState.git?.integration.headCommit).not.toBe(phaseBState.git?.context.baseCommit);
    if (!phaseBDecision || phaseBDecision.type !== "phase-brief-approval") throw new Error("expected Phase B brief approval");
    await approvePhase({
      root: harness.root,
      workflowId: harness.workflow.id,
      phaseId: "phase-b",
      briefRevision: phaseBDecision.briefRevision,
      workflowRevision: phaseBDecision.workflowRevision
    });
    expect((await harness.coordinator.runNext()).running.map((phase) => phase.phaseId)).toEqual(["phase-b"]);
    const result = await harness.coordinator.poll();

    const state = await currentState(harness);
    expect(result.nextAction).toBe("await_user");
    expect(result.decision).toMatchObject({ type: "final-review" });
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

    expect(result.nextAction).toBe("await_user");
    expect(result.decision).toMatchObject({ type: "execution-recovery" });
    expect(state.git?.integration.integratedPhaseIds).toEqual([]);
    expect(state.plan?.phases.every((phase) => phase.status === "needs_review")).toBe(true);
    expect(state.execution.records["phase-right"]?.status).toBe("blocked");
  });

  it("uses runner-owned validation and can recheck it without redispatching the provider", async () => {
    let runnerExit = 1;
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": { edits: [{ path: "src/a.ts", content: "a\n" }], validation: [{ command: "npm test", exitCode: 1, status: "failed" }] }
      },
      validationRunner: {
        async run(request) {
          return request.commands.map((command) => ({
            phaseId: request.phaseId,
            command,
            exitStatus: runnerExit,
            result: runnerExit === 0 ? "runner validation passed" : "runner validation failed",
            status: runnerExit === 0 ? "passed" as const : "failed" as const,
            skipped: false,
            source: "runner" as const,
            timestamp: new Date().toISOString()
          }));
        }
      }
    });

    await harness.coordinator.runNext();
    const result = await harness.coordinator.poll();
    const state = await currentState(harness);

    expect(result.nextAction).toBe("await_user");
    expect(result.decision).toMatchObject({ type: "execution-recovery", options: expect.arrayContaining([expect.objectContaining({ intent: "rerun-validation" })]) });
    expect(state.plan?.phases[0]?.status).toBe("needs_repair");
    expect(state.git?.integration.integratedPhaseIds).toEqual([]);
    expect(state.plan?.phases[0]?.completion?.validation.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "npm test", source: "runner", status: "failed" })
    ]));

    runnerExit = 0;
    const decision = state.approval?.pendingDecision;
    if (!decision) throw new Error("expected validation recovery decision");
    await harness.coordinator.rerunValidation(decision.id, state.revision);
    const rechecked = await currentState(harness);

    expect(rechecked.plan?.phases[0]?.status).toBe("completed");
    expect(rechecked.plan?.phases[0]?.completion?.validation).toMatchObject({ status: "passed" });
    expect(rechecked.plan?.phases[0]?.completion?.validation.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "npm test", source: "runner", status: "passed", result: "runner validation passed" })
    ]));
    expect(rechecked.execution.records["phase-a"]?.executionBudget?.attempts).toHaveLength(1);
  });

  it("does not let a provider-reported validation failure override a passing runner recheck", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": { edits: [{ path: "src/a.ts", content: "a\n" }], validation: [{ command: "npm test", exitCode: 1, status: "failed", result: "provider claimed failure" }] }
      }
    });

    await harness.coordinator.runNext();
    await harness.coordinator.poll();
    const state = await currentState(harness);

    expect(state.plan?.phases[0]?.status).toBe("completed");
    expect(state.plan?.phases[0]?.completion?.validation).toMatchObject({ status: "passed" });
    // Preserve the provider claim for diagnosis, but use the runner's result
    // as the authoritative completion evidence for the same command.
    expect(state.plan?.phases[0]?.validationResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "npm test", source: "provider", status: "failed" })
    ]));
    expect(state.plan?.phases[0]?.completion?.validation.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "npm test", source: "runner", status: "passed" })
    ]));
  });

  it("accepts supplemental validation without weakening the required check", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": {
          edits: [{ path: "src/a.ts", content: "a\n" }],
          validation: [
            { command: "npm test", exitCode: 0 },
            { command: "npx vitest run tests/flow.test.ts", exitCode: 0 },
            { command: "npx tsc --noEmit", exitCode: 0 }
          ]
        }
      }
    });

    await harness.coordinator.runNext();
    const result = await harness.coordinator.poll();
    const state = await currentState(harness);

    expect(result.decision?.type).toBe("final-review");
    expect(state.plan?.phases[0]?.validationResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "npm test", source: "provider" }),
      expect.objectContaining({ command: "npx vitest run tests/flow.test.ts", source: "provider" }),
      expect.objectContaining({ command: "npx tsc --noEmit", source: "provider" }),
      expect.objectContaining({ command: "npm test", source: "runner", status: "passed" }),
      expect.objectContaining({ command: "npm run test", source: "runner", status: "passed" })
    ]));
  });

  it("records language-agnostic supplemental validation without a review gate", async () => {
    let prompt = "";
    let schema: Record<string, unknown> | undefined;
    const validationAdvisor: StructuredDecisionProvider = {
      name: "advisory-test",
      capabilities: () => ({ structuredOutput: true, schemaEnforcement: true, minimalContext: true, toolIsolation: true }),
      async decide<T = unknown>(request: StructuredDecisionRequest) {
        prompt = request.prompt;
        schema = request.schema;
        expect(request).toMatchObject({ tier: "small", stage: "execution-validation-advisory", maxTurns: 1, tools: "none" });
        return {
          value: { advice: [{ command: "go test ./...", recommendation: "supplemental", rationale: "Runs Go package tests in addition to the required check." }] } as T,
          provider: "advisory-test",
          model: "small-test-model",
          tier: "small",
          launchMode: "test",
          warnings: []
        };
      }
    };
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      validationAdvisor,
      scripts: {
        "phase-a": {
          edits: [{ path: "src/a.ts", content: "a\n" }],
          validation: [{ command: "npm test", exitCode: 0 }, { command: "go test ./...", exitCode: 0 }]
        }
      }
    });

    await harness.coordinator.runNext();
    const result = await harness.coordinator.poll();

    expect(result.decision?.type).toBe("final-review");
    expect((await currentState(harness)).execution.records["phase-a"]?.diagnostics).toMatchObject({
      supplementalValidation: {
        commands: [expect.objectContaining({ command: "go test ./...", classification: "supplemental" })],
        advisory: {
          status: "available",
          provider: "advisory-test",
          model: "small-test-model",
          advice: [expect.objectContaining({ command: "go test ./...", recommendation: "supplemental" })]
        }
      }
    });
    expect(prompt).toContain("Commands may belong to any programming language");
    expect(prompt).toContain("MUST NOT authorize command execution");
    expect(schema).toMatchObject({ properties: { advice: { items: { properties: { recommendation: { enum: ["likely-equivalent", "supplemental", "review-recommended"] } } } } } });
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
    const refreshed = await preparePhaseExecutionBrief({
      root: harness.root,
      workflowId: harness.workflow.id,
      phaseId: "phase-a",
      config: harness.config,
      refresh: true,
      requireApproval: true
    });
    const decision = refreshed.approval?.pendingDecision;
    if (!decision || decision.type !== "phase-brief-approval") throw new Error("expected refreshed phase approval");
    await approvePhase({
      root: harness.root,
      workflowId: harness.workflow.id,
      phaseId: "phase-a",
      briefRevision: decision.briefRevision,
      workflowRevision: decision.workflowRevision
    });

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
      bootstrapCommand: "npm ci --ignore-scripts",
      approvalRequired: true
    });
    expect(state.execution.records["phase-a"]).toBeUndefined();
    expect(state.approval?.pendingDecision).toMatchObject({
      type: "workspace-bootstrap-approval",
      phaseId: "phase-a",
      briefRevision: state.phaseBriefs?.["phase-a"]?.briefRevision,
      preparationRevision: workspace?.preparation?.preparationRevision,
      workspaceIdentity: workspace?.preparation?.workspaceIdentity,
      command: "npm ci --ignore-scripts",
      status: "pending"
    });
    expect(workflowNextSummary(state)).toMatchObject({
      label: "Workspace preparation approval",
      userDecisionRequired: true,
      summary: {
        dependencyReady: true,
        dispatchReady: false,
        blocker: "workspace_bootstrap_pending",
        providerDispatched: false
      }
    });
    const bootstrapDecision = state.approval?.pendingDecision;
    if (!bootstrapDecision || bootstrapDecision.type !== "workspace-bootstrap-approval") throw new Error("expected bootstrap approval");
    await expect(approveWorkspaceBootstrap({
      root: harness.root,
      workflowId: harness.workflow.id,
      phaseId: "phase-a",
      briefRevision: bootstrapDecision.briefRevision,
      preparationRevision: bootstrapDecision.preparationRevision,
      workspaceIdentity: bootstrapDecision.workspaceIdentity,
      command: "npm install"
    })).rejects.toThrow(/no exact pending bootstrap approval/);
    const approvedBootstrap = await approveWorkspaceBootstrap({
      root: harness.root,
      workflowId: harness.workflow.id,
      phaseId: "phase-a",
      briefRevision: bootstrapDecision.briefRevision,
      preparationRevision: bootstrapDecision.preparationRevision,
      workspaceIdentity: bootstrapDecision.workspaceIdentity,
      command: bootstrapDecision.command
    });
    expect(approvedBootstrap.approval?.pendingDecision).toBeUndefined();
    expect(approvedBootstrap.approval?.decisionHistory.at(-1)).toMatchObject({
      type: "workspace-bootstrap-approval",
      status: "approved",
      command: "npm ci --ignore-scripts"
    });
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
          lastKnownStatus: "running",
          executionIdentity: input.executionIdentity
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
      briefRevision: state.phaseBriefs?.["phase-a"]?.briefRevision,
      approvedBrief: {
        phaseId: "phase-a",
        approvalStatus: "approved",
        validation: { status: "valid" }
      },
      leaseOwnerId: lease.ownerId,
      selectedMode: "standard",
      acceptanceCriterionIds: expect.arrayContaining(["phase-a:criterion-1"]),
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
    expect(prompt).toContain("This is the approved Phase Execution Brief.");
    expect(prompt).toContain(`Approved brief revision: ${capturedInput!.briefRevision}`);
    expect(prompt).toContain("If implementation reveals material scope, risk, dependency, or architecture changes, stop and return needs_replan.");
    expect(prompt).toContain("Workspace status: prepared");
    expect(prompt).toContain("criterionId");
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

    expect(result.nextAction).toBe("await_user");
    expect(result.decision).toMatchObject({ type: "execution-recovery" });
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

    expect(result.nextAction).toBe("await_user");
    expect(result.decision).toMatchObject({
      type: "execution-recovery",
      options: expect.arrayContaining([
        expect.objectContaining({ intent: "discard-out-of-scope-and-retry" })
      ])
    });
    expect(record?.status).toBe("blocked");
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

  it("rejects a wrong result identity, discards only out-of-scope writes, and retries with approved-scope work preserved", async () => {
    const scripts: Record<string, ScriptedPhase> = {
      "phase-a": {
        edits: [
          { path: "src/a.ts", content: "preserved in-scope work\n" },
          { path: "package.json", content: "{\"version\":\"unapproved\"}\n" }
        ],
        resultIdentity: { workflowRevision: 0 },
        validation: [{ command: "npm test", exitCode: 0 }]
      }
    };
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts
    });

    await harness.coordinator.runNext();
    const failed = await harness.coordinator.poll();
    const rejected = await currentState(harness);
    const workspace = rejected.git!.phaseWorkspaces["phase-a"]!.path;

    expect(failed.decision).toMatchObject({
      type: "execution-recovery",
      options: expect.arrayContaining([
        expect.objectContaining({
          intent: "discard-out-of-scope-and-retry",
          command: expect.stringContaining("flow discard-out-of-scope-and-retry")
        })
      ])
    });
    expect(rejected.execution.records["phase-a"]?.diagnostics).toMatchObject({
      terminalReason: "provider_protocol_error",
      resultAccepted: false,
      unexpectedWrites: ["package.json"]
    });
    expect(rejected.plan?.phases[0]?.status).toBe("needs_review");

    const legacy = structuredClone(rejected);
    legacy.approval!.pendingDecision!.type = "material-drift-review";
    legacy.approval!.pendingDecision!.allowedActions = ["review-material-drift", "revise-plan", "view-details", "cancel-workflow"];
    legacy.plan!.phases[0]!.status = "needs_replan";
    delete legacy.execution.records["phase-a"]!.diagnostics!.terminalReason;
    delete legacy.execution.records["phase-a"]!.diagnostics!.unexpectedWrites;
    await writeFile(
      path.join(harness.root, ".leanrigor", "workflows", `${legacy.id}.json`),
      `${JSON.stringify(legacy, null, 2)}\n`
    );
    const normalized = await currentState(harness);
    expect(normalized.approval?.pendingDecision).toMatchObject({
      type: "execution-recovery",
      allowedActions: expect.arrayContaining(["discard-out-of-scope-and-retry"])
    });
    expect(normalized.plan?.phases[0]?.status).toBe("needs_review");

    scripts["phase-a"] = {
      validation: [{ command: "npm test", exitCode: 0 }]
    };
    const retried = await harness.coordinator.discardOutOfScopeAndRetry(
      normalized.approval!.pendingDecision!.id,
      normalized.revision
    );

    expect(retried.nextAction).toBe("poll");
    await expect(readFile(path.join(workspace, "src", "a.ts"), "utf8")).resolves.toBe("preserved in-scope work\n");
    await expect(readFile(path.join(workspace, "package.json"), "utf8")).resolves.not.toContain("unapproved");
    await harness.coordinator.poll();
    const completed = await currentState(harness);
    expect(completed.execution.records["phase-a"]?.status).toBe("result_recorded");
    expect(completed.execution.records["phase-a"]?.diagnostics).toMatchObject({
      discardedOutOfScopeWrites: ["package.json"]
    });
  });

  it.each(["fast", "standard", "rigorous"] as const)(
    "automatically accepts a bounded additive test artifact in %s mode when the approved brief requires test writes",
    async (mode) => {
      const harness = await createExecutionHarness({
        mode,
        phases: [testPhase("phase-a", ["src/a.ts"])],
        scripts: {
          "phase-a": {
            edits: [
              { path: "src/a.ts", content: "export const a = 1;\n" },
              { path: "tests/a.test.ts", content: "export const regressionCovered = true;\n" }
            ],
            validation: [{ command: "npm test", exitCode: 0 }]
          }
        }
      });
      const prepared = await currentState(harness);
      prepared.phaseBriefs!["phase-a"]!.testObligations = ["Add a targeted regression test for phase-a."];
      prepared.phaseBriefs!["phase-a"]!.writeAreas = ["src/a.ts"];
      await saveFlowState(harness.root, prepared, { expectedRevision: prepared.revision });

      const dispatched = await harness.coordinator.runNext();
      expect(dispatched.nextAction).toBe("poll");
      const result = await harness.coordinator.poll();
      const state = await currentState(harness);

      expect(result.decision?.type).not.toBe("execution-recovery");
      expect(state.plan?.phases[0]).toMatchObject({
        status: "completed",
        acceptedDrifts: [expect.objectContaining({
          acceptedBy: "system-policy",
          reason: expect.stringContaining(`${mode} mode`),
          materialChanges: [expect.objectContaining({
            category: "file-refinement",
            proposedValue: ["tests/a.test.ts"],
            material: false
          })]
        })]
      });
      expect(state.execution.records["phase-a"]?.diagnostics).toMatchObject({
        automaticScopeRefinement: {
          policy: "bounded-test-artifact",
          mode,
          paths: ["tests/a.test.ts"]
        }
      });
      expect(state.git?.integration.integratedPhaseIds).toEqual(["phase-a"]);
    }
  );

  it("still blocks an additive test file when the approved brief does not require test writes", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": {
          edits: [
            { path: "src/a.ts", content: "export const a = 1;\n" },
            { path: "tests/a.test.ts", content: "export const unapproved = true;\n" }
          ],
          validation: [{ command: "npm test", exitCode: 0 }]
        }
      }
    });

    await harness.coordinator.runNext();
    const result = await harness.coordinator.poll();
    const state = await currentState(harness);

    expect(result.decision).toMatchObject({ type: "execution-recovery" });
    expect(state.execution.records["phase-a"]?.diagnostics).toMatchObject({
      terminalReason: "provider_scope_violation",
      unexpectedWrites: ["tests/a.test.ts"]
    });
    expect(state.plan?.phases[0]?.acceptedDrifts).toEqual([]);
  });

  it("automatically recovers a previously persisted bounded-test scope violation on the next coordinator run", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": {
          edits: [
            { path: "src/a.ts", content: "export const a = 1;\n" },
            { path: "tests/a.test.ts", content: "export const regressionCovered = true;\n" }
          ],
          validation: [{ command: "npm test", exitCode: 0 }]
        }
      }
    });

    await harness.coordinator.runNext();
    await harness.coordinator.poll();
    const blocked = await currentState(harness);
    expect(blocked.execution.records["phase-a"]?.diagnostics?.terminalReason).toBe("provider_scope_violation");
    blocked.phaseBriefs!["phase-a"]!.testObligations = ["Add a targeted regression test for phase-a."];
    await saveFlowState(harness.root, blocked, { expectedRevision: blocked.revision });

    const recovered = await harness.coordinator.runNext();
    expect(recovered.nextAction).toBe("poll");
    await harness.coordinator.poll();
    const completed = await currentState(harness);

    expect(completed.plan?.phases[0]).toMatchObject({
      status: "completed",
      acceptedDrifts: [expect.objectContaining({ acceptedBy: "system-policy" })]
    });
    expect(completed.execution.records["phase-a"]?.diagnostics).toMatchObject({
      automaticScopeRecovery: true,
      automaticScopeRecoveryPolicy: "bounded-test-artifact",
      automaticScopeRecoveryPaths: ["tests/a.test.ts"]
    });
    expect(completed.git?.integration.integratedPhaseIds).toEqual(["phase-a"]);
  });

  it("keeps genuine provider-reported material discovery on the plan-revision path", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": {
          result: "needs_replan",
          summary: "Inspection found a required public contract change.",
          discoveredMaterialChanges: [{
            category: "public-contract",
            affectedPhase: "phase-a",
            previousValue: ["internal behavior"],
            proposedValue: ["public contract"],
            severity: "high",
            material: true,
            reason: "A public API must change.",
            requiredTransition: "revise-plan"
          }]
        }
      }
    });

    await harness.coordinator.runNext();
    const result = await harness.coordinator.poll();

    expect(result.decision).toMatchObject({
      type: "material-drift-review",
      options: expect.arrayContaining([
        expect.objectContaining({ intent: "revise-plan" }),
        expect.objectContaining({ intent: "revise-phase-brief" })
      ])
    });
    expect(result.decision?.options.map((option) => option.intent)).not.toContain("retry-execution");
    expect(result.decision?.options.map((option) => option.intent)).not.toContain("discard-out-of-scope-and-retry");
    expect((await currentState(harness)).plan?.phases[0]?.status).toBe("needs_replan");
  });

  it("accepts a trusted material-drift result with a reason and replays normal completion gates", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": {
          edits: [{ path: "src/a.ts", content: "export const a = 1;\n" }],
          result: "needs_replan",
          summary: "A documented public-contract decision changed implementation detail.",
          validation: [{ command: "npm test", exitCode: 0 }],
          discoveredMaterialChanges: [{
            category: "public-contract",
            affectedPhase: "phase-a",
            severity: "medium",
            material: true,
            reason: "The provider found a documented public-contract implication.",
            requiredTransition: "revise-plan"
          }]
        }
      }
    });

    await harness.coordinator.runNext();
    const quarantined = await harness.coordinator.poll();
    const before = await currentState(harness);
    const decision = before.approval?.pendingDecision;
    expect(quarantined.decision?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ intent: "accept-drift", command: expect.stringContaining("--reason <reason>") }),
      expect.objectContaining({ intent: "rerun-drift" })
    ]));
    expect(before.execution.records["phase-a"]?.quarantinedResult).toMatchObject({ status: "needs_replan" });
    if (!decision) throw new Error("expected material-drift decision");

    const accepted = await harness.coordinator.acceptDrift(decision.id, before.revision, "The implementation remains within the approved source write boundary; preserve the discovery for downstream review.");
    const after = await currentState(harness);

    expect(accepted.nextAction).toBe("await_user");
    expect(after.plan?.phases[0]).toMatchObject({
      status: "completed",
      acceptedDrifts: [expect.objectContaining({ decisionId: decision.id, acceptedBy: "user", reason: expect.stringContaining("approved source") })]
    });
    expect(after.execution.records["phase-a"]).toMatchObject({ status: "result_recorded" });
    expect(after.execution.records["phase-a"]).not.toHaveProperty("quarantinedResult");
    expect(after.execution.records["phase-a"]?.diagnostics).toMatchObject({ materialDriftAccepted: true, resultAccepted: true });
    expect(after.git?.integration.integratedPhaseIds).toEqual(["phase-a"]);
  });

  it("refuses material-drift acceptance after the quarantined worktree changed, but permits a preserved-worktree rerun", async () => {
    const scripts: Record<string, ScriptedPhase> = {
      "phase-a": {
        edits: [{ path: "src/a.ts", content: "first attempt\n" }],
        result: "needs_replan",
        discoveredMaterialChanges: [{
          category: "validation",
          affectedPhase: "phase-a",
          severity: "medium",
          material: true,
          reason: "Additional validation was discovered.",
          requiredTransition: "revise-phase-brief"
        }]
      }
    };
    const harness = await createExecutionHarness({ phases: [testPhase("phase-a", ["src/a.ts"])], scripts });
    await harness.coordinator.runNext();
    await harness.coordinator.poll();
    const blocked = await currentState(harness);
    const decision = blocked.approval?.pendingDecision;
    if (!decision) throw new Error("expected material-drift decision");
    const workspace = blocked.git!.phaseWorkspaces["phase-a"]!.path;
    await writeFile(path.join(workspace, "src", "a.ts"), "changed after quarantine\n");

    await expect(harness.coordinator.acceptDrift(decision.id, blocked.revision, "This should be rejected because the checkpoint changed.")).rejects.toThrow("worktree changed");

    scripts["phase-a"] = { validation: [{ command: "npm test", exitCode: 0 }] };
    const rerun = await harness.coordinator.rerunDrift(decision.id, blocked.revision);
    expect(rerun.nextAction).toBe("poll");
    await harness.coordinator.poll();
    const completed = await currentState(harness);
    expect(completed.execution.records["phase-a"]?.diagnostics).toMatchObject({ materialDriftRerun: true, partialProgressPreserved: true });
  });

  it("offers one explicit additional-turn decision and continues from the preserved worktree", async () => {
    const scripts: Record<string, ScriptedPhase> = {
      "phase-a": {
        edits: [{ path: "src/a.ts", content: "partial\n" }],
        result: "failed" as const,
        summary: "provider turn limit reached",
        diagnostics: { terminalReason: "error_max_turns", maxTurns: 24, turnCount: 25, costUsd: 1.25 }
      }
    };
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts
    });

    await harness.coordinator.runNext();
    const recovery = await harness.coordinator.poll();
    const failed = await currentState(harness);
    const decision = failed.approval?.pendingDecision;

    expect(decision).toMatchObject({
      type: "execution-recovery",
      additionalTurns: 12,
      allowedActions: ["continue-execution", "view-details", "revise-plan", "cancel-workflow"]
    });
    expect(decision?.question).toContain("24-turn execution limit");
    expect(recovery.decision?.options[0]).toMatchObject({
      intent: "continue-execution",
      label: "Continue with 12 additional turns"
    });
    expect(recovery.decision?.options[0]?.command).toContain("flow continue-execution");
    expect(recovery.decision?.options[0]?.command).toContain(decision?.id);
    expect(failed.execution.records["phase-a"]?.executionBudget).toMatchObject({
      initialTurnLimit: 24,
      extensionTurnLimit: 12,
      extensionApprovals: 0,
      cumulativeAuthorizedTurns: 24
    });
    expect(failed.git?.integration.integratedPhaseIds).toEqual([]);

    scripts["phase-a"] = {
      edits: [{ path: "src/a.ts", content: "completed\n" }],
      result: "completed",
      summary: "continued successfully",
      validation: [{ command: "npm test", exitCode: 0 }],
      diagnostics: {}
    };
    const continued = await harness.coordinator.continueExecution(decision!.id, failed.revision);
    expect(continued.nextAction).toBe("poll");
    const running = await currentState(harness);
    expect(running.execution.records["phase-a"]?.executionBudget).toMatchObject({
      effectiveTurnLimit: 12,
      extensionApprovals: 1,
      cumulativeAuthorizedTurns: 36
    });
    expect(running.execution.records["phase-a"]?.executionBudget?.attempts[0]).toMatchObject({
      maxTurns: 24,
      reportedTurnsUsed: 25,
      terminalReason: "error_max_turns"
    });

    await harness.coordinator.poll();
    const completed = await currentState(harness);
    expect(completed.execution.records["phase-a"]?.status).toBe("result_recorded");
    expect(completed.execution.records["phase-a"]?.executionBudget?.attempts).toHaveLength(2);
    expect(completed.git?.integration.integratedPhaseIds).toContain("phase-a");
  });

  it("uses a fresh compact context for an approved max-turn continuation", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": {
          result: "failed",
          summary: "provider turn limit reached",
          diagnostics: { terminalReason: "error_max_turns", maxTurns: 24, turnCount: 25 }
        }
      }
    });
    await harness.coordinator.runNext();
    await harness.coordinator.poll();
    const failed = await currentState(harness);
    const record = failed.execution.records["phase-a"]!;
    record.providerSession = {
      providerId: "scripted",
      sessionId: "prior-session",
      workflowId: failed.id,
      phaseId: "phase-a",
      executionAttemptId: record.providerExecutionId,
      workingDirectory: record.workspacePath,
      createdAt: record.startedAt,
      updatedAt: record.completedAt ?? record.startedAt,
      status: "failed",
      resumePermitted: true
    };
    await saveFlowState(harness.root, failed, { expectedRevision: failed.revision });

    let captured: PhaseExecutionInput | undefined;
    const provider: ExecutionProvider = {
      id: "scripted",
      async capabilities() {
        return { parallel: false, cancellation: true, heartbeats: true, structuredResults: true, diagnostics: [] };
      },
      async dispatch(input) {
        captured = input;
        return {
          providerId: "scripted",
          providerExecutionId: "fresh-compact-retry",
          workflowId: input.workflowId,
          phaseId: input.phaseId,
          leaseOwnerId: input.leaseOwnerId,
          workspacePath: input.workspacePath,
          startedAt: new Date().toISOString(),
          lastKnownStatus: "running",
          executionIdentity: input.executionIdentity
        };
      },
      async getStatus() { return { status: "running" as const }; },
      async collectResult() { throw new Error("not reached"); },
      async cancel() {}
    };
    const coordinator = new ExecutionCoordinator({ root: harness.root, workflowId: failed.id, config: harness.config, provider });
    const decision = failed.approval!.pendingDecision!;

    await coordinator.continueExecution(decision.id, failed.revision);

    expect(captured?.resume).toMatchObject({ mode: "compact-retry" });
    expect(captured?.resume?.providerSession).toBeUndefined();
  });

  it("automatically falls back to one fresh compact retry when a resumed provider session is unavailable", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {}
    });
    const inputs: PhaseExecutionInput[] = [];
    const provider: ExecutionProvider = {
      id: "session-recovery-provider",
      async capabilities() {
        return { parallel: false, cancellation: true, heartbeats: true, structuredResults: true, diagnostics: [] };
      },
      async dispatch(input) {
        inputs.push(input);
        const resumed = inputs.length === 1;
        return {
          providerId: "session-recovery-provider",
          providerExecutionId: `session-recovery-${inputs.length}`,
          workflowId: input.workflowId,
          phaseId: input.phaseId,
          leaseOwnerId: input.leaseOwnerId,
          workspacePath: input.workspacePath,
          startedAt: new Date().toISOString(),
          lastKnownStatus: "running",
          turnBudget: input.turnBudget,
          executionIdentity: input.executionIdentity,
          providerSession: {
            providerId: "session-recovery-provider",
            sessionId: resumed ? "missing-session" : "fresh-session",
            workflowId: input.workflowId,
            phaseId: input.phaseId,
            executionAttemptId: `session-recovery-${inputs.length}`,
            workingDirectory: input.workspacePath,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: "running",
            resumePermitted: true,
            resumedFromSessionId: resumed ? "older-session" : undefined
          }
        };
      },
      async getStatus() { return { status: "completed" as const }; },
      async collectResult(handle) {
        if (handle.providerExecutionId !== "session-recovery-1") throw new Error("fresh retry is intentionally left running for this assertion");
        return {
          status: "failed",
          executionIdentity: handle.executionIdentity,
          summary: "The provider session is unavailable.",
          changedFiles: [],
          validation: [],
          criterionEvidence: [],
          assumptions: [],
          scopeDeviations: [],
          discoveredMaterialChanges: [],
          remainingRisks: [],
          providerDiagnostics: { terminalReason: "provider_session_unavailable" }
        };
      },
      async cancel() {}
    };
    const coordinator = new ExecutionCoordinator({ root: harness.root, workflowId: harness.workflow.id, config: harness.config, provider });

    await coordinator.runNext();
    await coordinator.poll();

    const state = await currentState(harness);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.resume).toMatchObject({ mode: "compact-retry" });
    expect(state.approval?.pendingDecision).toBeUndefined();
    expect(state.execution.records["phase-a"]?.status).toBe("running");
    expect(state.execution.records["phase-a"]?.providerSession).toMatchObject({ sessionId: "fresh-session" });
    expect(state.execution.records["phase-a"]?.executionBudget?.attempts).toEqual([
      expect.objectContaining({ terminalReason: "provider_session_unavailable" })
    ]);
    expect(state.approval?.decisionHistory.at(-1)).toMatchObject({
      selectedAction: "retry-execution",
      source: "system"
    });
  });

  it("rejects stale additional-turn approval without changing workflow state", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": {
          result: "failed",
          summary: "provider turn limit reached",
          diagnostics: { terminalReason: "error_max_turns", maxTurns: 24, turnCount: 25 }
        }
      }
    });
    await harness.coordinator.runNext();
    await harness.coordinator.poll();
    const failed = await currentState(harness);
    const decision = failed.approval!.pendingDecision!;

    await expect(harness.coordinator.continueExecution(decision.id, failed.revision - 1)).rejects.toThrow();
    const unchanged = await currentState(harness);
    expect(unchanged.revision).toBe(failed.revision);
    expect(unchanged.approval?.pendingDecision?.id).toBe(decision.id);
    expect(unchanged.execution.records["phase-a"]?.status).toBe("failed");
  });

  it("does not offer an unbounded second extension under phase-by-phase approval", async () => {
    const scripts: Record<string, ScriptedPhase> = {
      "phase-a": {
        result: "failed",
        summary: "initial turn limit reached",
        diagnostics: { terminalReason: "error_max_turns", maxTurns: 24, turnCount: 25 }
      }
    };
    const harness = await createExecutionHarness({
      approvalPolicy: "phase-by-phase",
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts
    });
    await harness.coordinator.runNext();
    await harness.coordinator.poll();
    const firstFailure = await currentState(harness);
    const firstDecision = firstFailure.approval!.pendingDecision!;

    scripts["phase-a"] = {
      result: "failed",
      summary: "extension exhausted",
      diagnostics: { terminalReason: "error_max_turns", maxTurns: 12, turnCount: 13 }
    };
    await harness.coordinator.continueExecution(firstDecision.id, firstFailure.revision);
    await harness.coordinator.poll();
    const exhausted = await currentState(harness);

    expect(exhausted.approval?.pendingDecision).toMatchObject({
      type: "execution-recovery",
      allowedActions: ["view-details", "revise-plan", "cancel-workflow"]
    });
    expect(exhausted.approval?.pendingDecision?.additionalTurns).toBeUndefined();
    expect(exhausted.execution.records["phase-a"]?.executionBudget).toMatchObject({
      extensionApprovals: 1,
      cumulativeAuthorizedTurns: 36
    });
    expect(exhausted.execution.records["phase-a"]?.executionBudget?.attempts).toHaveLength(2);
    expect(exhausted.git?.integration.integratedPhaseIds).toEqual([]);
  });

  it("makes the existing non-max-turn retry action redispatch the failed phase", async () => {
    const scripts: Record<string, ScriptedPhase> = {
      "phase-a": { result: "failed", summary: "transient provider failure", diagnostics: { terminalReason: "provider_process_exited" } }
    };
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts
    });
    await harness.coordinator.runNext();
    await harness.coordinator.poll();
    const failed = await currentState(harness);
    const decision = failed.approval!.pendingDecision!;
    expect(decision.allowedActions).toContain("retry-execution");

    scripts["phase-a"] = {
      edits: [{ path: "src/a.ts", content: "retried\n" }],
      result: "completed",
      validation: [{ command: "npm test", exitCode: 0 }]
    };
    const retried = await harness.coordinator.retryExecution(decision.id, failed.revision);
    expect(retried.nextAction).toBe("poll");
    await harness.coordinator.poll();
    const completed = await currentState(harness);
    expect(completed.execution.records["phase-a"]?.status).toBe("result_recorded");
    expect(completed.git?.integration.integratedPhaseIds).toContain("phase-a");
  });

  it("normalizes a missing legacy provider session and retries with the preserved turn allowance", async () => {
    const scripts: Record<string, ScriptedPhase> = {
      "phase-a": {
        result: "failed",
        summary: "generic process exit",
        diagnostics: {
          terminalReason: "provider_process_exited",
          stderrExcerpt: "No conversation found with session ID: old-session"
        }
      }
    };
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts
    });
    await harness.coordinator.runNext();
    await harness.coordinator.poll();
    const failed = await currentState(harness);
    const record = failed.execution.records["phase-a"]!;
    record.diagnostics = {
      ...record.diagnostics,
      terminalReason: "provider_process_exited",
      stderrExcerpt: "No conversation found with session ID: old-session"
    };
    record.providerSession = {
      providerId: "claude-cli",
      sessionId: "old-session",
      workflowId: failed.id,
      phaseId: "phase-a",
      executionAttemptId: record.providerExecutionId,
      workingDirectory: record.workspacePath,
      createdAt: record.startedAt,
      updatedAt: record.completedAt ?? record.startedAt,
      status: "failed",
      resumePermitted: true
    };
    await saveFlowState(harness.root, failed, { expectedRevision: failed.revision });

    const normalized = await currentState(harness);
    const normalizedRecord = normalized.execution.records["phase-a"]!;
    expect(normalizedRecord.diagnostics?.terminalReason).toBe("provider_session_unavailable");
    expect(normalizedRecord.providerSession).toMatchObject({
      status: "unavailable",
      resumePermitted: false
    });
    expect(normalized.approval?.pendingDecision?.question).toContain("fresh compact provider session");

    scripts["phase-a"] = {
      edits: [{ path: "src/a.ts", content: "fresh-session\n" }],
      result: "completed",
      validation: [{ command: "npm test", exitCode: 0 }]
    };
    const retried = await harness.coordinator.retryExecution(normalized.approval!.pendingDecision!.id, normalized.revision);
    expect(retried.nextAction).toBe("poll");
    await harness.coordinator.poll();
    expect((await currentState(harness)).execution.records["phase-a"]?.status).toBe("result_recorded");
  });

  it("recovers after restart by polling a persisted execution handle with the same provider", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: { "phase-a": { edits: [{ path: "src/a.ts", content: "a\n" }], validation: [{ command: "npm test", exitCode: 0 }] } }
    });
    await harness.coordinator.runNext();

    const restarted = new ExecutionCoordinator({ root: harness.root, workflowId: harness.workflow.id, config: harness.config, provider: harness.provider });
    const result = await restarted.poll();

    expect(result.nextAction).toBe("await_user");
    expect(result.decision).toMatchObject({ type: "final-review" });
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
    expect(result.nextAction).toBe("await_user");
    expect(result.decision).toMatchObject({ type: "execution-recovery" });
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
