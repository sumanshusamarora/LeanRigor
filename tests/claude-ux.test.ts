import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import {
  approveApproach,
  approvePlan,
  cancelFlow,
  completePhase,
  recordReview,
  recordValidation,
  resumeFlow,
  reviseApproach,
  saveFlowState,
  startFlow,
  startPhase
} from "../src/core/flow.js";
import { activeWorkflowSelection, workflowNextSummary } from "../src/core/ux.js";
import type { CriterionCompletionEvidence, SequentialWorkflowState, ValidationEvidence, WorkflowPhase } from "../src/core/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "leanrigor-ux-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  return root;
}

function phase(id: string, objective: string, dependencies: string[], status: WorkflowPhase["status"]): WorkflowPhase {
  return {
    id,
    objective,
    rationale: "Test phase.",
    dependencies,
    dependsOn: dependencies,
    expectedReadAreas: ["src/example.ts"],
    expectedWriteAreas: ["src/example.ts"],
    expectedFilesOrAreas: ["src/example.ts"],
    acceptanceCriteria: [`${objective} is complete.`],
    validationCommands: ["npm test"],
    riskLevel: "medium",
    modelTier: "medium",
    status,
    filesChanged: [],
    commandsRun: [],
    validationResults: [],
    scopeDeviations: [],
    repairAttempts: []
  };
}

describe("Claude conversational workflow UX support", () => {
  it("/leanrigor:start can start a new workflow and produce the first conversational gate", async () => {
    const root = await tempRepo();
    expect(await activeWorkflowSelection(root)).toMatchObject({ status: "none" });

    const state = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const next = workflowNextSummary(state);

    expect(next.label).toBe("Plan approval");
    expect(next.pendingAction).toBe("Select an approval action or type a response.");
    expect(next.approvalActions).toBeDefined();
    expect(next.approvalActions?.find((a) => a.intent === "approve")?.label).toBe("Approve plan and start coordinator execution");
    expect(next.approvalActions?.find((a) => a.intent === "revise")?.label).toBe("Revise plan");
    expect(next.approvalActions?.find((a) => a.intent === "show plan")?.label).toBe("View full details");
    expect(next.approvalActions?.find((a) => a.intent === "cancel")?.label).toBe("Cancel workflow");
  });

  it("/leanrigor:start resumes one active workflow", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });

    const selection = await activeWorkflowSelection(root);

    expect(selection.status).toBe("one");
    expect(selection.workflow?.id).toBe(state.id);
  });

  it("multiple active workflows require selection", async () => {
    const root = await tempRepo();
    await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    await startFlow({ request: "Fix another README typo", root, config: defaultConfig() });

    const selection = await activeWorkflowSelection(root);

    expect(selection.status).toBe("multiple");
    expect(selection.workflows).toHaveLength(2);
    expect(selection.message).toMatch(/Multiple active/);
  });

  it("completed and cancelled workflows are not selected by default", async () => {
    const root = await tempRepo();
    const first = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    await cancelFlow(root, first.id);
    const second = await startFlow({ request: "Fix another README typo", root, config: defaultConfig() });

    const selection = await activeWorkflowSelection(root);

    expect(selection.status).toBe("one");
    expect(selection.workflow?.id).toBe(second.id);
  });

  it("approach approval transitions internally to plan approval", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });

    expect(workflowNextSummary(started)).toMatchObject({ label: "Approach approval" });

    const planned = await approveApproach(root, started.id, defaultConfig());
    const next = workflowNextSummary(planned);

    expect(next.label).toBe("Plan approval");
    expect(next.summary.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "phase-1" })
    ]));
  });

  it("approach revision records feedback without starting planning", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });

    const revised = await reviseApproach(root, started.id, "Keep the change API-only and avoid test fixture churn.");
    const next = workflowNextSummary(revised);

    expect(revised.state).toBe("awaiting_approach_approval");
    expect(revised.plan).toBeUndefined();
    expect(revised.approach?.approved).toBe(false);
    expect(revised.approach?.revisionRequests?.[0]?.feedback).toContain("API-only");
    expect((next.summary.revisionRequests as Array<{ feedback: string }>)[0]?.feedback).toContain("API-only");
    expect(next.pendingDecision).toContain("No implementation has started");
  });

  it("plan approval transitions internally to phase execution", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const planned = await approveApproach(root, started.id, defaultConfig());

    const executing = await approvePlan(root, planned.id);

    expect(workflowNextSummary(executing)).toMatchObject({
      label: "Phase execution",
      userDecisionRequired: false
    });
  });

  it("recommends the next plan-order phase while showing other dependency-ready phases separately", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const planned = await approveApproach(root, started.id, defaultConfig());
    const executing = await approvePlan(root, planned.id);
    const state = await resumeFlow(root, executing.id);
    state.plan!.phases = [
      phase("phase-1", "Phase 1", [], "completed"),
      phase("phase-2", "Phase 2", ["phase-1"], "ready"),
      phase("phase-3", "Phase 3", ["phase-2"], "planned"),
      phase("phase-4", "Phase 4", ["phase-1"], "ready")
    ];
    await saveFlowState(root, state, { expectedRevision: state.revision });

    const next = workflowNextSummary(await resumeFlow(root, state.id));

    expect(next.summary).toMatchObject({
      phase: "phase-2",
      recommendedNextPhase: { id: "phase-2", objective: "Phase 2" },
      otherDependencyReadyPhases: [{ id: "phase-4", objective: "Phase 4" }],
      planOrderPrimary: true
    });
    expect(next.pendingAction).toContain("Execute recommended next phase phase-2");
    expect(next.pendingAction).toContain("Other dependency-ready phases require explicit selection");
    expect(next.troubleshooting.internalOperations).toContain("execute-next");
    expect(next.troubleshooting.internalOperations).not.toContain("phase-start");
  });

  it("/leanrigor:plan can show an existing plan without creating duplicates", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const planned = await approveApproach(root, started.id, defaultConfig());

    const selection = await activeWorkflowSelection(root);
    const next = workflowNextSummary(await resumeFlow(root, planned.id));

    expect(selection.status).toBe("one");
    expect(next.label).toBe("Plan approval");
    expect((next.summary.phases as unknown[])).toHaveLength(2);
  });

  it("continue cannot bypass needs_repair", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const executing = await approvePlan(root, (await approveApproach(root, started.id, defaultConfig())).id);
    const failed = await completePhaseWithEvidence(root, executing, "phase-1", ["src/api.ts"], "failed");

    const next = workflowNextSummary(failed);

    expect(next.label).toBe("Phase completion review");
    expect(next.allowedIntents).not.toContain("continue");
    expect(next.pendingAction).toMatch(/cannot bypass repair/);
  });

  it("status data is human-oriented and command-free", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });

    const next = workflowNextSummary(state);

    expect(next.workflow).toMatchObject({ id: state.id, request: state.request, mode: "fast" });
    expect(next.label).toBe("Plan approval");
    expect(next.troubleshooting.showCommandsOnlyOnFailure).toBe(true);
    expect(JSON.stringify(next.summary)).not.toMatch(/leanrigor flow/);
  });

  it("labels clarification-gated mode as provisional", async () => {
    const root = await tempRepo();
    const state = await startFlow({ request: "Fix it", root, config: defaultConfig() });
    const next = workflowNextSummary(state);

    expect(next.label).toBe("Clarification");
    expect(next.summary).toMatchObject({
      modeStatus: "provisional",
      provisionalRecommendation: state.mode,
      finalMode: null
    });
  });

  it("review command can distinguish phase review from final integrated review", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const executing = await approvePlan(root, (await approveApproach(root, started.id, defaultConfig())).id);
    const failed = await completePhaseWithEvidence(root, executing, "phase-1", ["src/api.ts"], "failed");
    expect(workflowNextSummary(failed).label).toBe("Phase completion review");

    const fastRoot = await tempRepo();
    const validating = await completeFastPhase(fastRoot);
    expect(workflowNextSummary(validating).label).toBe("Final integrated review");
  });

  it("commit command data states no commit or push has occurred", async () => {
    const root = await tempRepo();
    const validating = await completeFastPhase(root);
    const reviewed = await recordReview({ root, workflowId: validating.id, status: "passed", summary: "Integrated review passed.", config: defaultConfig() });

    const next = workflowNextSummary(reviewed);

    expect(next.label).toBe("Commit proposal");
    expect(next.pendingDecision).toMatch(/No commit or push has occurred/);
  });

  it("marketplace commands use shared conversational UX guidance", async () => {
    for (const file of ["start.md", "plan.md", "status.md", "review.md", "commit.md"]) {
      const content = await readFile(path.join(repoRoot, "commands", file), "utf8");
      expect(content).toContain("plugin-skills/sequential-workflow");
      expect(content).toContain("${CLAUDE_PLUGIN_ROOT}/bin/leanrigor");
      expect(content).toMatch(/internally|Do not print raw|Normal output/);
    }
  });

  it("project-local commands use shared conversational UX guidance", async () => {
    for (const file of ["leanrigor.md", "leanrigor-plan.md", "leanrigor-status.md", "leanrigor-review.md", "leanrigor-commit.md"]) {
      const content = await readFile(path.join(repoRoot, "src", "adapters", "claude", "plugin", "commands", file), "utf8");
      expect(content).toContain(".claude/leanrigor/sequential-workflow.md");
      expect(content).toMatch(/internally|Do not print raw|Normal output/);
    }
  });

  it("shared guidance covers ambiguous approval and troubleshooting fallback", async () => {
    const marketplace = await readFile(path.join(repoRoot, "plugin-skills", "sequential-workflow", "SKILL.md"), "utf8");
    const local = await readFile(path.join(repoRoot, "src", "adapters", "claude", "plugin", "leanrigor", "sequential-workflow.md"), "utf8");

    for (const content of [marketplace, local]) {
      expect(content).toContain("Ask one concise clarification for ambiguous responses");
      expect(content).toContain("I could not run the LeanRigor transition automatically");
      expect(content).toMatch(/Raw commands belong only|Do not print raw JSON or CLI commands/);
    }
  });

  it("shared guidance requires AskUserQuestion over plain text for approval gates", async () => {
    const marketplace = await readFile(path.join(repoRoot, "plugin-skills", "sequential-workflow", "SKILL.md"), "utf8");
    const local = await readFile(path.join(repoRoot, "src", "adapters", "claude", "plugin", "leanrigor", "sequential-workflow.md"), "utf8");

    for (const content of [marketplace, local]) {
      expect(content).toContain("AskUserQuestion");
      expect(content).toContain("mandatory");
      expect(content).toContain("Approve approach and create plan");
      expect(content).toContain("No implementation has started");
      expect(content).toContain("Do not render an ordinary text question");
      expect(content).toMatch(/Fall back to a numbered list|numbered list.*when.*AskUserQuestion.*genuinely unavailable/);
      expect(content).toMatch(/same\s+assistant\s+turn/);
      expect(content).toMatch(/A prose summary is\s+not a decision gate by itself/);
      expect(content).toContain("multiSelect");
      expect(content).toContain("deterministic");
      expect(content).toMatch(/remains the[\s]*authority/);
      expect(content).toContain("Do not infer approval from conversational tone");
      expect(content).toContain("Do not use `ExitPlanMode` as a substitute");
    }
  });

  it("start and plan commands prohibit summary-only staged gate output", async () => {
    const files = [
      path.join(repoRoot, "commands", "start.md"),
      path.join(repoRoot, "commands", "plan.md"),
      path.join(repoRoot, "src", "adapters", "claude", "plugin", "commands", "leanrigor.md"),
      path.join(repoRoot, "src", "adapters", "claude", "plugin", "commands", "leanrigor-plan.md")
    ];

    for (const file of files) {
      const content = await readFile(file, "utf8");
      expect(content).toContain("next.approvalActions");
      expect(content).toMatch(/same\s+assistant\s+turn/);
      expect(content).toMatch(/summary-only triage\s+report|multiSelect = false/);
    }
  });

  it("shared guidance requires clarification questions to be displayed verbatim", async () => {
    const marketplace = await readFile(path.join(repoRoot, "plugin-skills", "sequential-workflow", "SKILL.md"), "utf8");
    const local = await readFile(path.join(repoRoot, "src", "adapters", "claude", "plugin", "leanrigor", "sequential-workflow.md"), "utf8");
    const command = await readFile(path.join(repoRoot, "src", "adapters", "claude", "plugin", "commands", "leanrigor.md"), "utf8");
    const startCommand = await readFile(path.join(repoRoot, "commands", "start.md"), "utf8");

    for (const content of [marketplace, local, command, startCommand]) {
      expect(content).toContain("awaiting_clarification");
      expect(content).toContain("Question:");
      expect(content).toContain("Why this matters:");
      expect(content).toMatch(/Do not\s+replace the question with the reason/);
    }
  });
});

describe("approval actions", () => {
  it("presents approval actions for approach approval", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const next = workflowNextSummary(started);

    expect(next.label).toBe("Approach approval");
    expect(next.approvalActions).toBeDefined();
    expect(next.approvalActions).toHaveLength(4);

    const approve = next.approvalActions?.find((a) => a.intent === "approve");
    expect(approve).toBeDefined();
    expect(approve?.label).toBe("Approve approach and create plan");
    expect(approve?.command).toContain("leanrigor flow approve-approach");
    expect(approve?.command).toContain("--provider auto");

    const revise = next.approvalActions?.find((a) => a.intent === "revise");
    expect(revise).toBeDefined();
    expect(revise?.label).toBe("Revise approach");
    expect(revise?.command).toContain("leanrigor flow revise-approach");

    const details = next.approvalActions?.find((a) => a.intent === "view details");
    expect(details).toBeDefined();
    expect(details?.label).toBe("View workflow details");
    expect(details?.command).toContain("leanrigor flow status");

    const cancel = next.approvalActions?.find((a) => a.intent === "cancel");
    expect(cancel).toBeDefined();
    expect(cancel?.label).toBe("Cancel workflow");
    expect(cancel?.command).toContain("leanrigor flow cancel");

    expect(next.summary).toMatchObject({
      noImplementationStarted: true,
      assessment: expect.objectContaining({ complexity: expect.any(String) }),
      constraints: expect.objectContaining({ effective: expect.any(Array), original: expect.any(Array), audit: expect.any(Array) })
    });
  });

  it("presents approval actions for plan approval", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const planned = await approveApproach(root, started.id, defaultConfig());
    const next = workflowNextSummary(planned);

    expect(next.label).toBe("Plan approval");
    expect(next.approvalActions).toBeDefined();
    expect(next.approvalActions).toHaveLength(4);

    const approve = next.approvalActions?.find((a) => a.intent === "approve");
    expect(approve?.command).toContain("leanrigor flow approve-plan");

    const revise = next.approvalActions?.find((a) => a.intent === "revise");
    expect(revise?.command).toContain("leanrigor flow revise-plan");

    const details = next.approvalActions?.find((a) => a.intent === "show plan");
    expect(details?.command).toContain("leanrigor flow status");

    const cancel = next.approvalActions?.find((a) => a.intent === "cancel");
    expect(cancel?.command).toContain("leanrigor flow cancel");
  });

  it("presents approval actions for commit proposal", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const executing = await approvePlan(root, started.id);
    const state = await completePhaseWithEvidence(root, executing, "phase-1", ["README.md"]);
    const reviewed = await recordReview({ root, workflowId: state.id, status: "passed", summary: "Review passed.", config: defaultConfig() });
    const next = workflowNextSummary(reviewed);

    expect(next.label).toBe("Commit proposal");
    expect(next.approvalActions).toBeDefined();

    const complete = next.approvalActions?.find((a) => a.intent === "complete");
    expect(complete).toBeDefined();
    expect(complete?.command).toContain("leanrigor flow complete");

    const showProposal = next.approvalActions?.find((a) => a.intent === "show proposal");
    expect(showProposal).toBeDefined();

    const cancel = next.approvalActions?.find((a) => a.intent === "cancel");
    expect(cancel).toBeDefined();
  });

  it("presents selector actions for phase repair gates", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const executing = await approvePlan(root, (await approveApproach(root, started.id, defaultConfig())).id);
    const failed = await completePhaseWithEvidence(root, executing, "phase-1", ["src/api.ts"], "failed");
    const next = workflowNextSummary(failed);

    expect(next.label).toBe("Phase completion review");
    expect(next.approvalActions).toBeDefined();
    expect(next.approvalActions?.find((a) => a.intent === "repair it")?.command).toContain("leanrigor flow repair");
    expect(next.approvalActions?.find((a) => a.intent === "revise")?.command).toContain("leanrigor flow revise-plan");
    expect(next.approvalActions?.find((a) => a.intent === "cancel")?.command).toContain("leanrigor flow cancel");
  });

  it("free-form allowedIntents remain for backward compatibility", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const next = workflowNextSummary(started);

    expect(next.allowedIntents).toContain("approve");
    expect(next.allowedIntents).toContain("revise");
    expect(next.allowedIntents).toContain("view details");
    expect(next.allowedIntents).toContain("cancel");
  });

  it("no approval occurs without explicit user action", async () => {
    const root = await tempRepo();
    const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
    const next = workflowNextSummary(started);

    // The gate must require a user decision
    expect(next.userDecisionRequired).toBe(true);
    expect(started.plan).toBeUndefined();
    expect(next.summary.noImplementationStarted).toBe(true);
  });
});

async function completeFastPhase(root: string): Promise<SequentialWorkflowState> {
  const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
  const executing = await approvePlan(root, started.id);
  return completePhaseWithEvidence(root, executing, "phase-1", ["README.md"]);
}

async function completePhaseWithEvidence(
  root: string,
  state: SequentialWorkflowState,
  phaseId: string,
  filesChanged: string[],
  validationStatus: "passed" | "failed" = "passed"
): Promise<SequentialWorkflowState> {
  const current = await resumeFlow(root, state.id);
  const phase = current.plan?.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) throw new Error(`Missing phase ${phaseId}`);
  const executable = phase.status === "ready" ? await startPhase(root, state.id, phaseId) : current;
  const runningPhase = executable.plan?.phases.find((candidate) => candidate.id === phaseId);
  if (!runningPhase) throw new Error(`Missing phase ${phaseId}`);
  for (const evidence of validationEvidenceFor(runningPhase, validationStatus)) {
    await recordValidation({
      root,
      workflowId: executable.id,
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
    workflowId: executable.id,
    phaseId,
    config: defaultConfig(),
    criteria: metCriteria(runningPhase),
    filesChanged,
    commandsRun: runningPhase.validationCommands
  });
}

function metCriteria(phase: WorkflowPhase): CriterionCompletionEvidence[] {
  return phase.acceptanceCriteria.map((criterion) => ({
    criterion,
    status: "met",
    evidence: [`Evidence recorded for ${phase.id}: ${criterion}`]
  }));
}

function validationEvidenceFor(phase: WorkflowPhase, status: "passed" | "failed"): ValidationEvidence[] {
  return phase.validationCommands.map((command, index) => ({
    phaseId: phase.id,
    command,
    exitStatus: status === "failed" && index === 0 ? 1 : 0,
    result: status === "failed" && index === 0 ? "validation failed" : "validation passed",
    status: status === "failed" && index === 0 ? "failed" : "passed",
    skipped: false,
    timestamp: new Date().toISOString()
  }));
}
