import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceValidationRunner } from "../src/core/validation-runner.js";

const LAUNCHER_VARIABLES = [
  "CLAUDE_PLUGIN_ROOT",
  "LEANRIGOR_CLAUDE_PLUGIN_ROOT",
  "LEANRIGOR_RUNTIME_SOURCE"
] as const;
const originalEnvironment = Object.fromEntries(LAUNCHER_VARIABLES.map((variable) => [variable, process.env[variable]]));

afterEach(() => {
  for (const variable of LAUNCHER_VARIABLES) {
    const original = originalEnvironment[variable];
    if (original === undefined) delete process.env[variable];
    else process.env[variable] = original;
  }
});

describe("WorkspaceValidationRunner", () => {
  it("does not leak Claude marketplace launcher variables into approved validation", async () => {
    process.env.CLAUDE_PLUGIN_ROOT = "/tmp/marketplace-plugin";
    process.env.LEANRIGOR_CLAUDE_PLUGIN_ROOT = "/tmp/leanrigor-plugin";
    process.env.LEANRIGOR_RUNTIME_SOURCE = "claude-marketplace-plugin";

    const runner = new WorkspaceValidationRunner();
    const [result] = await runner.run({
      phaseId: "phase-a",
      workspacePath: process.cwd(),
      commands: ["node -e \"process.exit(process.env.CLAUDE_PLUGIN_ROOT || process.env.LEANRIGOR_CLAUDE_PLUGIN_ROOT || process.env.LEANRIGOR_RUNTIME_SOURCE ? 1 : 0)\""],
      timeoutSeconds: 10
    });

    expect(result).toMatchObject({ source: "runner", status: "passed", exitStatus: 0 });
  });
});
