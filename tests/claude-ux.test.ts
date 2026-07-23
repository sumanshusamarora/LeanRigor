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

describe("Claude conversational workflow UX support", () => {
  it("/leanrigor:start can start a new workflow and produce the first conversational gate", async () => {
    const root = await tempRepo();
    expect(await activeWorkflowSelection(root)).toMatchObject({ status: "none" });

    const state = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
    const next = workflowNextSummary(state);

    expect(next.label).toBe("Plan approval");
    expect(next.pendingAction).toBe("Approve this plan, request changes, or cancel?");
    expect(JSON.stringify(next)).not.toContain("leanrigor flow approve-plan");
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
