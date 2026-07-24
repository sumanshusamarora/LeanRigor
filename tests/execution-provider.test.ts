import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeCliExecutionProvider } from "../src/core/execution/claude-provider.js";
import { ScriptedExecutionProvider } from "../src/core/execution/scripted-provider.js";
import type { PhaseExecutionInput } from "../src/core/execution/types.js";

describe("scripted execution provider", () => {
  it("dispatches, reports status, collects evidence, and cancels deterministically", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "leanrigor-scripted-"));
    const provider = new ScriptedExecutionProvider({
      "phase-api": {
        edits: [{ path: "src/api.ts", content: "export const value = 1;\n" }],
        validation: [{ command: "npm test", exitCode: 0 }],
        result: "completed"
      }
    });

    const handle = await provider.dispatch(input(workspace));
    const status = await provider.getStatus(handle);
    const result = await provider.collectResult(handle);

    expect((await provider.capabilities()).parallel).toBe(true);
    expect(status.status).toBe("completed");
    expect(result.status).toBe("completed");
    expect(result.criterionEvidence[0]?.status).toBe("met");
    await expect(readFile(path.join(workspace, "src", "api.ts"), "utf8")).resolves.toBe("export const value = 1;\n");

    await provider.cancel(handle, "idempotent cancel after completion");
    await expect(provider.cancel(handle, "second cancel")).resolves.toBeUndefined();
  });

  it("rejects workspace-escaping edits and malformed evidence", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "leanrigor-scripted-"));
    const provider = new ScriptedExecutionProvider({ "phase-api": { edits: [{ path: "../outside.txt", content: "bad\n" }] } });
    await expect(provider.dispatch(input(workspace))).rejects.toMatchObject({ code: "workspace_mismatch" });

    const malformed = new ScriptedExecutionProvider({ "phase-api": { malformedEvidence: true } });
    const handle = await malformed.dispatch(input(workspace));
    await expect(malformed.collectResult(handle)).rejects.toMatchObject({ code: "result_malformed" });
  });
});

describe("Claude CLI execution provider", () => {
  it("collects a structured result after provider restart", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "leanrigor-claude-provider-"));
    const command = await fakeClaude(workspace, phaseResultJson());
    const provider = new ClaudeCliExecutionProvider({ command });
    const handle = await provider.dispatch(input(workspace));
    const restarted = new ClaudeCliExecutionProvider({ command });

    await waitForTerminalStatus(restarted, handle);
    const result = await restarted.collectResult(handle);

    expect(result.status).toBe("completed");
    expect(result.changedFiles).toEqual(["src/math.js"]);
    expect(handle.providerMetadata).toMatchObject({ stdoutPath: expect.any(String), stderrPath: expect.any(String), statusPath: expect.any(String) });
  });

  it("does not treat process exit alone as a completed phase result", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "leanrigor-claude-provider-"));
    const command = await fakeClaude(workspace, "not-json");
    const provider = new ClaudeCliExecutionProvider({ command });
    const handle = await provider.dispatch(input(workspace));
    const restarted = new ClaudeCliExecutionProvider({ command });

    await waitForTerminalStatus(restarted, handle);

    await expect(restarted.collectResult(handle)).rejects.toMatchObject({ code: "provider_protocol_error" });
  });
});

function input(workspacePath: string): PhaseExecutionInput {
  return {
    workflowId: "lr-test",
    workflowRevision: 1,
    phaseId: "phase-api",
    objective: "Implement API.",
    acceptanceCriteria: ["API works."],
    dependencies: [],
    selectedMode: "standard",
    modelTier: "medium",
    workspacePath,
    repositoryRoot: workspacePath,
    allowedReadAreas: ["src/api.ts"],
    allowedWriteAreas: ["src/api.ts"],
    methodologyReferences: [],
    validationExpectations: ["npm test"],
    leaseOwnerId: "owner",
    timeoutSeconds: 30,
    userRequest: "test",
    planContext: "test",
    safetyInstructions: ["Do not commit."]
  };
}

async function fakeClaude(root: string, result: string): Promise<string> {
  const command = path.join(root, "fake-claude.sh");
  await writeFile(command, `#!/bin/sh\nprintf '%s\\n' '${result.replaceAll("'", "'\\''")}'\n`, "utf8");
  await chmod(command, 0o755);
  return command;
}

function phaseResultJson(): string {
  const result = {
    status: "completed",
    summary: "Verified: fake Claude completed.",
    changedFiles: ["src/math.js"],
    validation: [{ command: "npm test", exitCode: 0, status: "passed", result: "pass" }],
    criterionEvidence: [{ criterion: "API works.", status: "met", evidence: ["fake"] }],
    assumptions: [],
    scopeDeviations: [],
    remainingRisks: []
  };
  return JSON.stringify({ result: JSON.stringify(result) });
}

async function waitForTerminalStatus(provider: ClaudeCliExecutionProvider, handle: Awaited<ReturnType<ClaudeCliExecutionProvider["dispatch"]>>): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const status = await provider.getStatus(handle);
    if (status.status !== "running" && status.status !== "queued") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("fake Claude provider did not reach a terminal status");
}
