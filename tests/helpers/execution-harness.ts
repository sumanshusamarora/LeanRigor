import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defaultConfig } from "../../src/config/defaults.js";
import type { LeanRigorConfig } from "../../src/config/schema.js";
import { approvePlan, loadFlowState, saveFlowState, startFlow } from "../../src/core/flow.js";
import { ExecutionCoordinator } from "../../src/core/execution/coordinator.js";
import { ScriptedExecutionProvider, type ScriptedPhase } from "../../src/core/execution/scripted-provider.js";
import type { ExecutionPlan, SequentialWorkflowState, WorkflowPhase } from "../../src/core/types.js";

const execFileAsync = promisify(execFile);

export interface DisposableExecutionHarness {
  root: string;
  config: LeanRigorConfig;
  workflow: SequentialWorkflowState;
  provider: ScriptedExecutionProvider;
  coordinator: ExecutionCoordinator;
  git(args: string[], cwd?: string): Promise<string>;
  read(file: string, cwd?: string): Promise<string>;
}

export async function createExecutionHarness(options: {
  phases: WorkflowPhase[];
  scripts: Record<string, ScriptedPhase>;
  maxParallelPhases?: number;
  workerTimeoutSeconds?: number;
  clock?: () => Date;
}): Promise<DisposableExecutionHarness> {
  const root = await gitRepo();
  const config = defaultConfig();
  config.execution.maxParallelPhases = options.maxParallelPhases ?? 1;
  config.execution.workerTimeoutSeconds = options.workerTimeoutSeconds ?? 1800;
  config.execution.heartbeatGraceSeconds = 5;
  const workflow = await workflowWithPlan(root, { version: 1, summary: "Test execution plan", principles: ["Use coordinator."], phases: options.phases, revisionRequests: [] });
  const provider = new ScriptedExecutionProvider(options.scripts, options.clock ? () => options.clock!().getTime() : undefined);
  const coordinator = new ExecutionCoordinator({ root, workflowId: workflow.id, config, provider, clock: options.clock });
  return {
    root,
    config,
    workflow,
    provider,
    coordinator,
    git: (args, cwd = root) => git(cwd, args),
    read: (file, cwd = root) => readFile(path.join(cwd, file), "utf8")
  };
}

export function testPhase(id: string, writes: string[], dependencies: string[] = []): WorkflowPhase {
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

export async function currentState(harness: DisposableExecutionHarness): Promise<SequentialWorkflowState> {
  return loadFlowState(harness.root, harness.workflow.id);
}

export async function gitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "leanrigor-execution-"));
  await git(root, ["init"]);
  await git(root, ["checkout", "-b", "main"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
  await writeFile(path.join(root, "README.md"), "base\n");
  await mkdir(path.join(root, "src"), { recursive: true });
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

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}
