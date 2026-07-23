import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import {
  approvePlan,
  completePhase,
  gitPreflight,
  integratePhase,
  integrationStatus,
  leasePhase,
  loadFlowState,
  saveFlowState,
  startFlow,
  validateIntegration,
  workspaceCreatePhase,
  workspaceInit,
  workspaceRecover
} from "../src/core/flow.js";
import type { CriterionCompletionEvidence, ExecutionPlan, SequentialWorkflowState, ValidationEvidence, WorkflowPhase } from "../src/core/types.js";

const execFileAsync = promisify(execFile);

describe("Git worktree isolation and integration", () => {
  it("preflights Git repositories and rejects non-Git directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "leanrigor-non-git-"));
    expect(await gitPreflight(root, defaultConfig())).toMatchObject({ ok: false, code: "not_git_worktree" });

    const repo = await gitRepo();
    const preflight = await gitPreflight(repo, defaultConfig());
    expect(preflight).toMatchObject({ ok: true, originalBranch: "main" });
    expect(preflight.baseCommit).toMatch(/[a-f0-9]{40}/);
  });

  it("isolates a phase workspace, integrates approved changes, and preserves the original dirty worktree", async () => {
    const root = await gitRepo();
    await writeFile(path.join(root, "README.md"), "user dirty change\n");
    const beforeBranch = await git(root, ["branch", "--show-current"]);
    const beforeHead = await git(root, ["rev-parse", "HEAD"]);

    const workflow = await workflowWithPlan(root, planWithPhases([testPhase("phase-docs", ["README.md"])]));
    const initialized = await workspaceInit({ root, workflowId: workflow.id, config: defaultConfig() });
    await leasePhase({ root, workflowId: workflow.id, phaseId: "phase-docs", ownerId: "owner-docs", config: defaultConfig() });
    const withWorkspace = await workspaceCreatePhase({ root, workflowId: workflow.id, phaseId: "phase-docs", ownerId: "owner-docs", config: defaultConfig() });
    const phasePath = withWorkspace.git!.phaseWorkspaces["phase-docs"]!.path;
    await writeFile(path.join(phasePath, "README.md"), "integrated phase change\n");

    await completePhaseWithEvidence(root, workflow.id, "phase-docs", "owner-docs");
    const result = await integratePhase({ root, workflowId: workflow.id, phaseId: "phase-docs", ownerId: "integrator" });

    expect(initialized.git?.integration.path).toContain(".leanrigor-worktrees");
    expect(result.ok).toBe(true);
    await expect(readFile(path.join(result.state.git!.integration.path, "README.md"), "utf8")).resolves.toBe("integrated phase change\n");
    await expect(readFile(path.join(root, "README.md"), "utf8")).resolves.toBe("user dirty change\n");
    expect(await git(root, ["branch", "--show-current"])).toBe(beforeBranch);
    expect(await git(root, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(await git(root, ["status", "--porcelain=v1", "--", "README.md"])).toBe("M README.md");
  });

  it("integrates two independent phase worktrees and validates the combined integration workspace", async () => {
    const root = await gitRepo();
    const config = defaultConfig();
    const workflow = await workflowWithPlan(root, planWithPhases([
      testPhase("phase-a", ["src/a.txt"]),
      testPhase("phase-b", ["src/b.txt"])
    ]));
    await workspaceInit({ root, workflowId: workflow.id, config });

    for (const [phaseId, file, contents] of [["phase-a", "src/a.txt", "a\n"], ["phase-b", "src/b.txt", "b\n"]] as const) {
      await leasePhase({ root, workflowId: workflow.id, phaseId, ownerId: phaseId, config });
      const state = await workspaceCreatePhase({ root, workflowId: workflow.id, phaseId, ownerId: phaseId, config });
      await writeFile(path.join(state.git!.phaseWorkspaces[phaseId]!.path, file), contents);
      await completePhaseWithEvidence(root, workflow.id, phaseId, phaseId);
    }

    const first = await integratePhase({ root, workflowId: workflow.id, phaseId: "phase-a", ownerId: "integrator" });
    const second = await integratePhase({ root, workflowId: workflow.id, phaseId: "phase-b", ownerId: "integrator" });
    const validated = await validateIntegration({ root, workflowId: workflow.id });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(integrationStatus(validated).finalReviewEligible).toBe(true);
    expect(await git(root, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("detects textual conflicts without touching the original worktree", async () => {
    const root = await gitRepo();
    const workflow = await workflowWithPlan(root, planWithPhases([
      testPhase("phase-left", ["src/shared.txt"]),
      testPhase("phase-right", ["src/shared.txt"])
    ]));
    await workspaceInit({ root, workflowId: workflow.id, config: defaultConfig() });

    for (const [phaseId, contents] of [["phase-left", "left\n"], ["phase-right", "right\n"]] as const) {
      await leasePhase({ root, workflowId: workflow.id, phaseId, ownerId: phaseId, config: defaultConfig() });
      const state = await workspaceCreatePhase({ root, workflowId: workflow.id, phaseId, ownerId: phaseId, config: defaultConfig() });
      await writeFile(path.join(state.git!.phaseWorkspaces[phaseId]!.path, "src/shared.txt"), contents);
      await completePhaseWithEvidence(root, workflow.id, phaseId, phaseId);
    }

    await integratePhase({ root, workflowId: workflow.id, phaseId: "phase-left", ownerId: "integrator" });
    const conflict = await integratePhase({ root, workflowId: workflow.id, phaseId: "phase-right", ownerId: "integrator" });

    expect(conflict).toMatchObject({ ok: false, code: "integration_conflict", conflictingFiles: ["src/shared.txt"] });
    await expect(readFile(path.join(root, "src/shared.txt"), "utf8")).resolves.toBe("base\n");
    expect(integrationStatus(conflict.state).finalReviewEligible).toBe(false);
  });

  it("recovers an expired leased workspace with changes by preserving it for review", async () => {
    const root = await gitRepo();
    const workflow = await workflowWithPlan(root, planWithPhases([testPhase("phase-a", ["src/a.txt"])]));
    await workspaceInit({ root, workflowId: workflow.id, config: defaultConfig() });
    await leasePhase({ root, workflowId: workflow.id, phaseId: "phase-a", ownerId: "owner-a", config: defaultConfig() });
    const state = await workspaceCreatePhase({ root, workflowId: workflow.id, phaseId: "phase-a", ownerId: "owner-a", config: defaultConfig() });
    await writeFile(path.join(state.git!.phaseWorkspaces["phase-a"]!.path, "src/a.txt"), "stale change\n");

    const stale = await loadFlowState(root, workflow.id);
    stale.phaseLeases["phase-a"]!.expiresAt = "2026-01-01T00:00:00.000Z";
    await saveFlowState(root, stale, { expectedRevision: stale.revision });
    const recovered = await workspaceRecover({ root, workflowId: workflow.id });

    expect(recovered.needsReview).toContain("phase-a");
    expect(recovered.state.plan?.phases[0]?.status).toBe("needs_review");
    await expect(readFile(path.join(state.git!.phaseWorkspaces["phase-a"]!.path, "src/a.txt"), "utf8")).resolves.toBe("stale change\n");
  });
});

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "leanrigor-git-"));
  await git(root, ["init"]);
  await git(root, ["checkout", "-b", "main"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
  await writeFile(path.join(root, "README.md"), "base\n");
  await mkdirp(path.join(root, "src"));
  await writeFile(path.join(root, "src", "shared.txt"), "base\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

async function workflowWithPlan(root: string, plan: ExecutionPlan): Promise<SequentialWorkflowState> {
  const started = await startFlow({ request: "Fix the broken assignment API regression", root, config: defaultConfig() });
  const state = await loadFlowState(root, started.id);
  state.state = "awaiting_plan_approval";
  state.plan = plan;
  state.approach = { required: false, approved: true, proposed: "test", preferredBecause: "test", alternatives: [], primaryRisks: [], validationStrategy: [] };
  await saveFlowState(root, state, { expectedRevision: state.revision });
  return approvePlan(root, state.id);
}

async function completePhaseWithEvidence(root: string, workflowId: string, phaseId: string, ownerId: string): Promise<SequentialWorkflowState> {
  const current = await loadFlowState(root, workflowId);
  const phase = current.plan!.phases.find((candidate) => candidate.id === phaseId)!;
  return completePhase({
    root,
    workflowId,
    phaseId,
    config: defaultConfig(),
    criteria: metCriteria(phase),
    validation: [validation(phaseId)],
    mutation: { ownerId }
  });
}

function planWithPhases(phases: WorkflowPhase[]): ExecutionPlan {
  return { version: 1, summary: "Test plan", principles: ["Use isolated Git worktrees."], phases, revisionRequests: [] };
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
  return phase.acceptanceCriteria.map((criterion) => ({ criterion, status: "met", evidence: [`Evidence recorded for ${phase.id}.`] }));
}

function validation(phaseId: string): ValidationEvidence {
  return { phaseId, command: "npm test", exitStatus: 0, result: "passed", status: "passed", skipped: false, timestamp: new Date().toISOString() };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function mkdirp(dir: string): Promise<void> {
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
}
