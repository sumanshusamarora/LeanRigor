import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeCliExecutionProvider, parseClaudeResult } from "../src/core/execution/claude-provider.js";
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
  it("parses the current Claude CLI JSON envelope fixture", async () => {
    const fixture = await readFile(path.join("tests", "fixtures", "claude-cli", "success-envelope.json"), "utf8");
    const result = parseClaudeResult(fixture, "");

    expect(result.status).toBe("completed");
    expect(result.changedFiles).toEqual(["src/math.js"]);
  });

  it("parses valid structured results nested in documented result fields", () => {
    const result = parseClaudeResult(JSON.stringify({ type: "result", result: JSON.stringify(phaseResult()) }), "");

    expect(result.validation[0]?.status).toBe("passed");
  });

  it("parses stream-json result events", () => {
    const output = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [] } }),
      JSON.stringify({ type: "result", subtype: "success", result: JSON.stringify(phaseResult()) })
    ].join("\n");

    expect(parseClaudeResult(output, "").status).toBe("completed");
  });

  it("parses Markdown-wrapped JSON in the result field", () => {
    const output = JSON.stringify({ type: "result", result: `\`\`\`json\n${JSON.stringify(phaseResult())}\n\`\`\`` });

    expect(parseClaudeResult(output, "").changedFiles).toEqual(["src/math.js"]);
  });

  it("tolerates harmless metadata lines around a valid result envelope", async () => {
    const fixture = await readFile(path.join("tests", "fixtures", "claude-cli", "success-envelope.json"), "utf8");

    expect(parseClaudeResult(`DeepSeek provider\n${fixture}\n`, "").status).toBe("completed");
  });

  it("rejects prose-only Claude output and denied-permission envelopes", async () => {
    const fixture = await readFile(path.join("tests", "fixtures", "claude-cli", "permission-denied-envelope.json"), "utf8");

    expect(() => parseClaudeResult(fixture, "")).toThrow(/No structured phase result/);
    expect(() => parseClaudeResult(JSON.stringify({ type: "result", result: "all done" }), "")).toThrow(/No structured phase result/);
  });

  it("rejects malformed nested JSON and schema-invalid results", () => {
    expect(() => parseClaudeResult(JSON.stringify({ type: "result", result: "```json\n{\"status\":\n```" }), "")).toThrow(/malformed fenced JSON/);
    expect(() => parseClaudeResult(JSON.stringify({ type: "result", structured_output: { status: "completed", summary: "missing arrays" } }), "")).toThrow(/contract/);
  });

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

  it("rejects non-zero Claude process exits", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "leanrigor-claude-provider-"));
    const command = await fakeClaude(workspace, phaseResultJson(), 1);
    const provider = new ClaudeCliExecutionProvider({ command });
    const handle = await provider.dispatch(input(workspace));
    const restarted = new ClaudeCliExecutionProvider({ command });

    await waitForTerminalStatus(restarted, handle);

    await expect(restarted.collectResult(handle)).rejects.toMatchObject({ code: "provider_process_exited" });
  });

  it("includes execution artifact diagnostics on parse failure", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "leanrigor-claude-provider-"));
    const fixture = await readFile(path.join("tests", "fixtures", "claude-cli", "permission-denied-envelope.json"), "utf8");
    const command = await fakeClaude(workspace, fixture);
    const provider = new ClaudeCliExecutionProvider({ command });
    const handle = await provider.dispatch(input(workspace));
    const restarted = new ClaudeCliExecutionProvider({ command });

    await waitForTerminalStatus(restarted, handle);

    await expect(restarted.collectResult(handle)).rejects.toMatchObject({
      code: "result_malformed",
      details: {
        providerExecutionId: handle.providerExecutionId,
        artifactDir: expect.stringContaining(path.join(".leanrigor", "executions")),
        stdoutExcerpt: expect.stringContaining("permission_denials"),
        stderrExcerpt: "",
        nextStep: expect.stringContaining("execution-poll")
      }
    });
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

async function fakeClaude(root: string, result: string, exitCode = 0): Promise<string> {
  const command = path.join(root, "fake-claude.sh");
  await writeFile(command, `#!/bin/sh\nprintf '%s\\n' '${result.replaceAll("'", "'\\''")}'\nsleep 0.05\nexit ${exitCode}\n`, "utf8");
  await chmod(command, 0o755);
  return command;
}

function phaseResultJson(): string {
  return JSON.stringify({ type: "result", result: JSON.stringify(phaseResult()), structured_output: phaseResult(), permission_denials: [] });
}

function phaseResult() {
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
  return result;
}

async function waitForTerminalStatus(provider: ClaudeCliExecutionProvider, handle: Awaited<ReturnType<ClaudeCliExecutionProvider["dispatch"]>>): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const status = await provider.getStatus(handle);
    if (status.status !== "running" && status.status !== "queued") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("fake Claude provider did not reach a terminal status");
}
