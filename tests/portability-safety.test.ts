import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { availableAdapterIds, getAdapterRuntime } from "../src/adapters/registry.js";
import { defaultConfig } from "../src/config/defaults.js";
import { resolveModelTier } from "../src/config/models.js";
import { DEFAULT_CLAUDE_PERMISSION_MODE } from "../src/core/execution/claude-provider.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("portability and safety contracts", () => {
  it("uses permission-gated Claude edits by default", () => {
    expect(DEFAULT_CLAUDE_PERMISSION_MODE).toBe("acceptEdits");
  });

  it("preserves model mappings for adapters registered in future", () => {
    const config = defaultConfig();
    config.models.tiers.medium.codex = "gpt-5.4";

    expect(resolveModelTier("medium", "codex", config)).toMatchObject({
      model: "gpt-5.4",
      source: "config"
    });
  });

  it("routes the current adapter through the registry", () => {
    expect(availableAdapterIds()).toContain("claude");
    expect(getAdapterRuntime("claude").createTriageProvider().name).toBe("claude-cli");
  });

  it("keeps marketplace and fallback instructions on file-based text transport", async () => {
    const assets = [
      path.join(root, "plugin-skills", "sequential-workflow", "SKILL.md"),
      path.join(root, "commands", "start.md"),
      path.join(root, "commands", "plan.md"),
      path.join(root, "src", "adapters", "claude", "plugin", "commands", "leanrigor.md"),
      path.join(root, "src", "adapters", "claude", "plugin", "commands", "leanrigor-plan.md"),
      path.join(root, "src", "adapters", "claude", "plugin", "leanrigor", "sequential-workflow.md")
    ];

    for (const asset of assets) {
      const content = await readFile(asset, "utf8");
      expect(content, asset).toContain("--request-file");
      expect(content, asset).toMatch(/Never interpolate user\s+text/);
    }
  });
});
