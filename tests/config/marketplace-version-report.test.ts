import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePluginVersion, type InitReport } from "../../src/config/init-report.js";
import { renderInitReport } from "../../src/config/report-renderer.js";

const originalPluginRoot = process.env.LEANRIGOR_CLAUDE_PLUGIN_ROOT;
const originalClaudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
const tempRoots: string[] = [];

afterEach(async () => {
  if (originalPluginRoot === undefined) delete process.env.LEANRIGOR_CLAUDE_PLUGIN_ROOT;
  else process.env.LEANRIGOR_CLAUDE_PLUGIN_ROOT = originalPluginRoot;

  if (originalClaudePluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = originalClaudePluginRoot;

  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("marketplace version reporting", () => {
  it("reads the installed plugin manifest before package fallback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "leanrigor-plugin-"));
    tempRoots.push(root);
    await mkdir(path.join(root, ".claude-plugin"), { recursive: true });
    await writeFile(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "leanrigor", version: "9.8.7-test" }),
      "utf8",
    );

    process.env.LEANRIGOR_CLAUDE_PLUGIN_ROOT = root;
    delete process.env.CLAUDE_PLUGIN_ROOT;

    await expect(resolvePluginVersion("marketplace")).resolves.toBe("9.8.7-test");
  });

  it("renders the complete gitignore status message only once", () => {
    const report = {
      installationMode: "marketplace",
      runtimeSource: "/tmp/plugin/bin/leanrigor",
      pluginVersion: "9.8.7-test",
      assetVersion: 5,
      isMarketplace: true,
      shadowing: null,
      bootstrap: null,
      configurationFiles: {
        user: { path: "/tmp/user.json", status: "missing" },
        repositoryPolicy: { path: "/tmp/repo.json", status: "missing" },
        local: { path: "/tmp/local.json", status: "found" },
      },
      gitignore: { status: "current", message: ".leanrigor/.gitignore: current" },
      models: [],
      execution: {},
      assets: {
        current: [], modified: [], missing: [], conflicts: [], adoptable: [], totalAvailable: 0, installedCount: 0,
      },
      settings: { path: ".claude/settings.json", status: "shared_current", detail: "not managed" },
      constraints: [],
      warnings: [],
      validExamples: [],
    } as InitReport;

    const output = renderInitReport(report);
    expect(output).toContain("Plugin version: 9.8.7-test");
    expect(output).toContain(".leanrigor/.gitignore: current");
    expect(output).not.toContain(".leanrigor/.gitignore: .leanrigor/.gitignore");
  });
});
