import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { ClaudeAdapter } from "../src/adapters/claude/adapter.js";
import { defaultConfig } from "../src/config/defaults.js";
import { resolveModelTier } from "../src/config/models.js";
import { runTriage, type TriageProvider } from "../src/core/triage-runner.js";

async function tempRepo(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "leanrigor-test-"));
}

describe("CLI packaging and init regressions", () => {
  it("declares the built CLI binary path used by the production build", () => {
    expect(packageJson.bin).toEqual({ leanrigor: "dist/cli/index.js" });
  });

  it("creates Claude adapter files without overwriting existing files", async () => {
    const root = await tempRepo();
    await mkdir(path.join(root, ".claude", "commands"), { recursive: true });
    const commandPath = path.join(root, ".claude", "commands", "leanrigor.md");
    await writeFile(commandPath, "custom user command\n");

    await new ClaudeAdapter().install(root, defaultConfig());
    await new ClaudeAdapter().install(root, defaultConfig());

    await expect(readFile(commandPath, "utf8")).resolves.toBe("custom user command\n");
    await expect(readFile(path.join(root, ".claude", "agents", "leanrigor-triage.md"), "utf8")).resolves.toContain("name: leanrigor-triage");
  });

  it("keeps inherit model tiers model-less", () => {
    expect(resolveModelTier("inherit", "claude", defaultConfig())).not.toHaveProperty("model");
  });

  it("falls back deterministically after malformed model triage", async () => {
    const provider: TriageProvider = {
      name: "broken-model",
      async classify() {
        return { provider: "broken-model", model: "haiku", raw: { workflow: { finalMode: "invalid" } } };
      }
    };

    const result = await runTriage({ request: "Fix the typo in the README documentation", root: await tempRepo(), config: defaultConfig(), provider });
    expect(result.source).toBe("deterministic-fallback");
    expect(result.output.workflow.finalMode).toBe("fast");
    expect(result.warnings.join("\n")).toMatch(/Model triage attempt 1 failed/);
  });
});
