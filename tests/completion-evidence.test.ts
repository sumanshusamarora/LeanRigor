import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { completionEvidenceArtifactPath, persistCompletionEvidenceArtifact, readCompletionEvidenceFile } from "../src/core/completion-evidence.js";
import { approvePlan, completePhase, startFlow, startPhase } from "../src/core/flow.js";
import type { WorkflowPhase } from "../src/core/types.js";

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "leanrigor-evidence-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
  return root;
}

describe("completion evidence files", () => {
  it("fails closed when the evidence file is missing", async () => {
    const { root, workflowId } = await runningFastPhase();

    await expect(readCompletionEvidenceFile(root, workflowId, "phase-1", path.join(root, "missing-evidence.json")))
      .rejects.toThrow(/Completion evidence file is unavailable/);
  });

  it("fails closed when the evidence file is malformed", async () => {
    const { root, workflowId } = await runningFastPhase();
    const file = path.join(root, "malformed.json");
    await writeFile(file, "{ nope", "utf8");

    await expect(readCompletionEvidenceFile(root, workflowId, "phase-1", file))
      .rejects.toThrow(/Completion evidence file is not valid JSON/);
  });

  it("fails closed when generated evidence is stale", async () => {
    const { root, workflowId } = await runningFastPhase();
    const file = path.join(root, "stale.json");
    await writeFile(file, JSON.stringify({
      workflowId,
      workflowRevision: 0,
      phaseId: "phase-1",
      criteria: [],
      validation: []
    }), "utf8");

    await expect(readCompletionEvidenceFile(root, workflowId, "phase-1", file))
      .rejects.toThrow(/evidence revision 0 is stale/);
  });

  it("stores accepted evidence in workflow-owned artifacts", async () => {
    const { root, workflowId, phase } = await runningFastPhase();
    const file = path.join(root, "phase-1-evidence.json");
    await writeFile(file, JSON.stringify({
      workflowId,
      phaseId: phase.id,
      criteria: phase.acceptanceCriteria.map((criterion) => ({
        criterion,
        status: "met",
        evidence: [`Evidence for ${criterion}`]
      })),
      filesChanged: ["README.md"],
      commandsRun: phase.validationCommands,
      validation: phase.validationCommands.map((command) => ({ command, exitStatus: 0, result: "Passed." }))
    }), "utf8");

    const evidence = await readCompletionEvidenceFile(root, workflowId, phase.id, file);
    const artifact = await persistCompletionEvidenceArtifact(root, workflowId, phase.id, file);
    if (!artifact) throw new Error("Expected evidence artifact");
    const completed = await completePhase({
      root,
      workflowId,
      phaseId: phase.id,
      config: defaultConfig(),
      criteria: evidence.criteria,
      filesChanged: evidence.filesChanged,
      commandsRun: evidence.commandsRun,
      validation: evidence.validation,
      evidenceArtifact: artifact
    });

    expect(artifact.path).toBe(completionEvidenceArtifactPath(root, workflowId, phase.id));
    expect(artifact.path).toContain(path.join(".leanrigor", "workflows", workflowId, "artifacts"));
    await expect(readFile(artifact.path, "utf8")).resolves.toContain(`"phaseId":"${phase.id}"`);
    expect(completed.plan?.phases[0]?.completion?.evidenceArtifact).toMatchObject({
      path: artifact.path,
      sourcePath: file
    });
  });
});

async function runningFastPhase(): Promise<{ root: string; workflowId: string; phase: WorkflowPhase }> {
  const root = await tempRepo();
  const started = await startFlow({ request: "Fix a typo in README documentation", root, config: defaultConfig() });
  const executing = await approvePlan(root, started.id);
  const running = await startPhase(root, executing.id, "phase-1");
  const phase = running.plan?.phases[0];
  if (!phase) throw new Error("Expected phase-1");
  return { root, workflowId: running.id, phase };
}
