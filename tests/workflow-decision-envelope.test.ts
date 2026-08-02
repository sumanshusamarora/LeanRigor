import { describe, expect, it } from "vitest";
import { approvePhase, loadFlowState } from "../src/core/flow.js";
import { coordinatorResultForState } from "../src/core/execution/coordinator.js";
import { phaseResultView, workflowDecisionEnvelope } from "../src/core/workflow-envelope.js";
import { selectorQuestionForDecision, setPendingDecision } from "../src/core/workflow-decision.js";
import type { WorkflowDecisionType } from "../src/core/types.js";
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

  it("limits AskUserQuestion decisions to five context-prioritized options", async () => {
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
      "view-details",
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
      "review-material-drift",
      "revise-plan",
      "revise-phase-brief",
      "view-details",
      "cancel-workflow"
    ]);
  });

  it("uses compact action prompts and bounded selector previews", () => {
    const question = (type: Parameters<typeof selectorQuestionForDecision>[0]["type"], phaseId?: string) =>
      selectorQuestionForDecision({ type, phaseId, briefRevision: 2, question: "Detailed persisted diagnostics that belong in Markdown." });

    expect(question("approach-approval")).toBe("Approve the workflow strategy before Workflow Plan generation?");
    expect(question("workflow-plan-approval")).toBe("Approve the Workflow Plan and its execution policy?");
    expect(question("planning-fallback-review")).toBe("Choose how to proceed with workflow planning?");
    expect(question("phase-brief-approval", "phase-a")).toBe("Review and approve phase-a Execution Brief revision 2?");
    expect(question("workspace-bootstrap-approval", "phase-a")).toBe("Approve workspace preparation for phase-a?");
    expect(question("material-drift-review", "phase-a")).toBe("Review material drift for phase-a?");
    expect(question("execution-recovery", "phase-a")).toBe("Choose a recovery action for phase-a?");
    expect(question("integration-conflict", "phase-a")).toBe("Resolve the integration conflict for phase-a?");
    expect(question("final-review")).toBe("Record the final integrated review?");
    expect(question("final-completion")).toBe("Complete the workflow?");
    expect(question("clarification")).toBe("Detailed persisted diagnostics that belong in Markdown.");

    expect(selectorQuestionForDecision({
      type: "approach-approval",
      question: "Approve the workflow strategy before Workflow Plan generation?",
      selectorPreview: "Workflow strategy\nMode: Rigorous\nApproach: Persist execution provenance.\nTriage: claude-cli / model-id; model output; 1 attempt"
    })).toBe([
      "Workflow strategy",
      "Mode: Rigorous",
      "Approach: Persist execution provenance.",
      "Triage: claude-cli / model-id; model output; 1 attempt",
      "",
      "Approve the workflow strategy before Workflow Plan generation?"
    ].join("\n"));
  });

  it("persists stage-specific native context for every selector gate", async () => {
    const harness = await createExecutionHarness({
      approveFirstPhase: false,
      approvalPolicy: "phase-by-phase",
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {}
    });
    const base = await currentState(harness);
    base.validation.push({ command: "npm test", exitStatus: 0, status: "passed", result: "passed", skipped: false, timestamp: new Date().toISOString() });
    base.review = { status: "passed", summary: "Integrated review found no blocking issues.", findings: [], reviewedAt: new Date().toISOString() };
    base.commitPlan = { generatedAt: new Date().toISOString(), note: "No commit has been executed.", groups: [{ message: "fix: preserve workflow context", files: ["src/a.ts"], rationale: "One scoped change.", commands: [] }] };

    const cases: Array<{ type: WorkflowDecisionType; expected: string }> = [
      { type: "clarification", expected: "Clarification" },
      { type: "approach-approval", expected: "Workflow strategy" },
      { type: "workflow-plan-approval", expected: "Workflow Plan" },
      { type: "planning-fallback-review", expected: "Planning recovery" },
      { type: "phase-brief-approval", expected: "Phase Execution Brief" },
      { type: "workspace-bootstrap-approval", expected: "Workspace preparation" },
      { type: "material-drift-review", expected: "Material drift review" },
      { type: "execution-recovery", expected: "Execution recovery" },
      { type: "integration-conflict", expected: "Integration conflict" },
      { type: "final-review", expected: "Final integrated review" },
      { type: "final-completion", expected: "Workflow completion" }
    ];

    for (const entry of cases) {
      const state = structuredClone(base);
      const decision = setPendingDecision(state, {
        type: entry.type,
        phaseId: "phase-a",
        briefRevision: 1,
        command: "git status --short",
        riskSummary: ["Review workspace side effects."],
        question: "Persisted recovery context that must remain visible in the selector.",
        allowedActions: ["view-details", "cancel-workflow"]
      });
      expect(decision.selectorPreview).toContain(entry.expected);
      expect(decision.question).toContain(entry.expected);
      expect(decision.question).not.toMatch(/^Approve|^Choose|^Review|^Record|^Complete|^Resolve$/);
      expect(decision.question.length).toBeLessThanOrEqual(800);
    }
  });

  it("normalizes a verbose persisted decision when it is read into the envelope", async () => {
    const harness = await createExecutionHarness({
      approveFirstPhase: false,
      approvalPolicy: "phase-by-phase",
      phases: [testPhase("phase-a", ["src/a.ts"])],
      scripts: {}
    });
    const state = await currentState(harness);
    const decision = state.approval?.pendingDecision;
    if (!decision) throw new Error("expected pending decision");
    decision.type = "approach-approval";
    delete decision.selectorPreview;
    decision.question = "A long legacy strategy, with risks, constraints, and whitespace that must never be shown in the selector.\n\nApprove?";

    const envelope = workflowDecisionEnvelope(state);
    expect(envelope.decision?.question).toBe("Approve the workflow strategy before Workflow Plan generation?");
    expect(envelope.status.summary).toBe("Approve the workflow strategy before Workflow Plan generation?");
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
