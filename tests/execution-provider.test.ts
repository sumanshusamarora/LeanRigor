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

  it("returns a failed result for process output without structured phase evidence", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "leanrigor-claude-provider-"));
    const command = await fakeClaude(workspace, "not-json");
    const provider = new ClaudeCliExecutionProvider({ command });
    const handle = await provider.dispatch(input(workspace));
    const restarted = new ClaudeCliExecutionProvider({ command });

    await waitForTerminalStatus(restarted, handle);
    const result = await restarted.collectResult(handle);

    expect(result.status).toBe("failed");
    expect(result.providerDiagnostics).toMatchObject({ providerErrorCode: "provider_protocol_error", partialProgressAccepted: false });
  });

  it("returns a failed result for non-zero Claude process exits", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "leanrigor-claude-provider-"));
    const command = await fakeClaude(workspace, phaseResultJson(), 1);
    const provider = new ClaudeCliExecutionProvider({ command });
    const handle = await provider.dispatch(input(workspace));
    const restarted = new ClaudeCliExecutionProvider({ command });

    await waitForTerminalStatus(restarted, handle);
    const result = await restarted.collectResult(handle);

    expect(result.status).toBe("failed");
    expect(result.providerDiagnostics).toMatchObject({ exitCode: 1, partialProgressAccepted: false });
  });

  it("includes execution artifact diagnostics on parse failure", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "leanrigor-claude-provider-"));
    const fixture = await readFile(path.join("tests", "fixtures", "claude-cli", "permission-denied-envelope.json"), "utf8");
    const command = await fakeClaude(workspace, fixture);
    const provider = new ClaudeCliExecutionProvider({ command });
    const handle = await provider.dispatch(input(workspace));
    const restarted = new ClaudeCliExecutionProvider({ command });

    await waitForTerminalStatus(restarted, handle);
    const result = await restarted.collectResult(handle);

    expect(result).toMatchObject({
      status: "failed",
      providerDiagnostics: {
        providerExecutionId: handle.providerExecutionId,
        providerErrorCode: "result_malformed",
        artifactDir: expect.stringContaining(path.join(".leanrigor", "executions")),
        stdoutExcerpt: expect.stringContaining("permission_denials"),
        stderrExcerpt: ""
      }
    });
  });

  it("persists a provider session separately from the LeanRigor workflow id and bounds the CLI environment", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "leanrigor-claude-provider-"));
    const command = await fakeClaude(workspace, phaseResultJson());
    const provider = new ClaudeCliExecutionProvider({ command, maxTurns: 6 });
    const handle = await provider.dispatch(input(workspace));
    const metadata = handle.providerMetadata as { safeArgs?: string[]; args?: string[] };

    expect(handle.workflowId).toBe("lr-test");
    expect(handle.providerSession?.sessionId).toEqual(expect.any(String));
    expect(handle.providerSession?.sessionId).not.toBe(handle.workflowId);
    expect(handle.providerSession).toMatchObject({
      providerId: "claude-cli",
      workflowId: "lr-test",
      phaseId: "phase-api",
      executionAttemptId: handle.providerExecutionId,
      workingDirectory: workspace,
      resumePermitted: true
    });
    expect(metadata.args).toBeUndefined();
    expect(metadata.safeArgs).toContain("--bare");
    expect(metadata.safeArgs).toContain("--strict-mcp-config");
    expect(metadata.safeArgs).toContain("--mcp-config");
    expect(metadata.safeArgs).not.toContain("--no-session-persistence");
    expect(metadata.safeArgs).toContain("[bounded-phase-prompt]");
    expect(metadata.safeArgs?.join(" ")).not.toContain("Implement API.");
  });

  it("resumes only a matching provider session in the same worktree", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "leanrigor-claude-provider-"));
    const command = await fakeClaude(workspace, phaseResultJson());
    const prior = {
      providerId: "claude-cli",
      sessionId: "11111111-1111-4111-8111-111111111111",
      workflowId: "lr-test",
      phaseId: "phase-api",
      executionAttemptId: "attempt-1",
      workingDirectory: workspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      status: "failed" as const,
      resumePermitted: true
    };
    const provider = new ClaudeCliExecutionProvider({ command });
    const handle = await provider.dispatch({
      ...input(workspace),
      resume: { providerSession: prior, failureReason: "error_max_turns", attempt: 2, mode: "same-session" }
    });
    const metadata = handle.providerMetadata as { safeArgs?: string[]; resumeMode?: string };

    expect(handle.providerSession?.sessionId).toBe(prior.sessionId);
    expect(handle.providerSession?.executionAttemptId).toBe(handle.providerExecutionId);
    expect(metadata.resumeMode).toBe("same-session");
    expect(metadata.safeArgs).toContain("--resume");
    expect(metadata.safeArgs).not.toContain("[bounded-phase-prompt]");
    expect(metadata.safeArgs).toContain("[compact-resume-prompt]");
  });

  it("uses a fresh compact retry when a prior session points at another worktree", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "leanrigor-claude-provider-"));
    const command = await fakeClaude(workspace, phaseResultJson());
    const provider = new ClaudeCliExecutionProvider({ command });
    const handle = await provider.dispatch({
      ...input(workspace),
      resume: {
        providerSession: {
          providerId: "claude-cli",
          sessionId: "11111111-1111-4111-8111-111111111111",
          workflowId: "lr-test",
          phaseId: "phase-api",
          executionAttemptId: "attempt-1",
          workingDirectory: path.join(workspace, "other"),
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          status: "failed",
          resumePermitted: true
        },
        failureReason: "cwd mismatch",
        attempt: 2,
        mode: "same-session"
      }
    });
    const metadata = handle.providerMetadata as { safeArgs?: string[]; resumeMode?: string };

    expect(handle.providerSession?.sessionId).not.toBe("11111111-1111-4111-8111-111111111111");
    expect(metadata.resumeMode).toBe("compact-retry");
    expect(metadata.safeArgs).toContain("--session-id");
    expect(metadata.safeArgs).not.toContain("--resume");
  });

  it("reports exact max-turn diagnostics from Claude error envelopes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "leanrigor-claude-provider-"));
    const envelope = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      num_turns: 13,
      total_cost_usd: 3.29,
      usage: { input_tokens: 651779, output_tokens: 547 },
      modelUsage: { opus: { inputTokens: 651779, outputTokens: 547 } },
      session_id: "22222222-2222-4222-8222-222222222222",
      result: "Max turns reached"
    });
    const command = await fakeClaude(workspace, envelope, 1);
    const provider = new ClaudeCliExecutionProvider({ command });
    const handle = await provider.dispatch(input(workspace));
    const restarted = new ClaudeCliExecutionProvider({ command });

    await waitForTerminalStatus(restarted, handle);
    const result = await restarted.collectResult(handle);

    expect(result.status).toBe("failed");
    expect(result.providerDiagnostics).toMatchObject({
      terminalReason: "error_max_turns",
      turnCount: 13,
      costUsd: 3.29,
      usage: { input_tokens: 651779, output_tokens: 547 }
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
