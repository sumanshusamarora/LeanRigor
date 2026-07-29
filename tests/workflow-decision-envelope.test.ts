import { describe, expect, it } from "vitest";
import { approvePhase, loadFlowState } from "../src/core/flow.js";
import { coordinatorResultForState } from "../src/core/execution/coordinator.js";
import { phaseResultView, workflowDecisionEnvelope } from "../src/core/workflow-envelope.js";
import { createExecutionHarness, currentState, testPhase } from "./helpers/execution-harness.js";

describe("normalized workflow decision envelopes", () => {
  it("returns the same persisted phase decision from flow and coordinator views", async () => {
    const harness = await createExecutionHarness({
      approveFirstPhase: false,
      approvalPolicy: "phase-by-phase",
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": { edits: [{ path: "src/a.ts", content: "a\n" }], validation: [{ command: "npm test", exitCode: 0 }] }
      }
    });
    const state = await currentState(harness);
    const flowEnvelope = workflowDecisionEnvelope(state);
    const executionEnvelope = coordinatorResultForState(state, "scripted", [], "await_user", "refresh");

    expect(executionEnvelope.decision).toEqual(flowEnvelope.decision);
    expect(executionEnvelope.nextAction).toBe("await_user");
    expect(flowEnvelope.decision).toMatchObject({
      type: "phase-brief-approval",
      phaseId: "phase-a",
      question: expect.any(String),
      options: expect.arrayContaining([
        expect.objectContaining({ intent: "approve-phase", label: "Review and approve Phase A brief" })
      ])
    });
    expect(flowEnvelope.decision?.options.length).toBeGreaterThan(0);
  });

  it("distinguishes an automatically permitted operation from a user decision", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": { edits: [{ path: "src/a.ts", content: "a\n" }], validation: [{ command: "npm test", exitCode: 0 }] }
      }
    });

    const envelope = workflowDecisionEnvelope(await currentState(harness));
    expect(envelope.decision).toBeUndefined();
    expect(envelope.nextOperation).toEqual({ type: "execute-next", automaticallyPermitted: true });
    expect(coordinatorResultForState(await currentState(harness), "scripted", [], "await_user", "refresh").nextAction).toBe("dispatch");
  });

  it("limits AskUserQuestion decisions to four context-prioritized options", async () => {
    const harness = await createExecutionHarness({
      approveFirstPhase: false,
      approvalPolicy: "phase-by-phase",
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {}
    });
    const state = await currentState(harness);
    const decision = state.approval?.pendingDecision;
    if (!decision) throw new Error("expected pending decision");
    decision.type = "execution-recovery";
    decision.allowedActions = [
      "discard-out-of-scope-and-retry",
      "revise-phase-brief",
      "view-details",
      "revise-plan",
      "cancel-workflow"
    ];

    expect(workflowDecisionEnvelope(state).decision?.options.map((option) => option.intent)).toEqual([
      "discard-out-of-scope-and-retry",
      "revise-phase-brief",
      "revise-plan",
      "cancel-workflow"
    ]);

    decision.type = "material-drift-review";
    decision.allowedActions = [
      "review-material-drift",
      "revise-plan",
      "revise-phase-brief",
      "view-details",
      "cancel-workflow"
    ];
    expect(workflowDecisionEnvelope(state).decision?.options.map((option) => option.intent)).toEqual([
      "revise-plan",
      "revise-phase-brief",
      "view-details",
      "cancel-workflow"
    ]);
  });

  it("rejects duplicate and stale decision answers by stable identity", async () => {
    const harness = await createExecutionHarness({
      approveFirstPhase: false,
      approvalPolicy: "phase-by-phase",
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {}
    });
    const pending = (await currentState(harness)).approval?.pendingDecision;
    if (!pending || pending.type !== "phase-brief-approval") throw new Error("expected phase decision");

    const approved = await approvePhase({
      root: harness.root,
      workflowId: harness.workflow.id,
      phaseId: pending.phaseId,
      briefRevision: pending.briefRevision,
      workflowRevision: pending.workflowRevision,
      mutation: { decisionId: pending.id }
    });
    expect(approved.approval?.decisionHistory.at(-1)).toMatchObject({
      id: pending.id,
      status: "approved",
      selectedAction: "approve-phase",
      resolvedAt: expect.any(String)
    });
    await expect(approvePhase({
      root: harness.root,
      workflowId: harness.workflow.id,
      phaseId: pending.phaseId,
      briefRevision: pending.briefRevision,
      workflowRevision: pending.workflowRevision,
      mutation: { decisionId: pending.id }
    })).rejects.toThrow(/already resolved/);
  });

  it("presents accepted and integrated provider evidence without requiring worktree inspection", async () => {
    const harness = await createExecutionHarness({
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {
        "phase-a": { edits: [{ path: "src/a.ts", content: "export const a = 1;\n" }], validation: [{ command: "npm test", exitCode: 0 }] }
      }
    });

    await harness.coordinator.runNext();
    await harness.coordinator.poll();
    const state = await loadFlowState(harness.root, harness.workflow.id);
    const result = phaseResultView(state, "phase-a");

    expect(result.lifecycle).toMatchObject({
      providerDispatch: "dispatched",
      resultIdentity: "verified",
      scopeCheck: "passed",
      completionGate: "completed",
      phaseAcceptance: "accepted",
      integration: "integrated"
    });
    expect(result.evidence.changedFiles).toContain("src/a.ts");
    expect(result.evidence.validation).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "npm test", status: "passed" })
    ]));
    expect(result.manualInspection).toEqual({
      required: false,
      availableOnlyWhenExplicitlyRequested: true
    });
  });
});
