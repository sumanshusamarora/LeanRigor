import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

