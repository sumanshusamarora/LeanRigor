import { access, cp, mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import marketplace from "../.claude-plugin/marketplace.json" with { type: "json" };
import plugin from "../.claude-plugin/plugin.json" with { type: "json" };
import { ClaudeAdapter } from "../src/adapters/claude/adapter.js";
import { defaultConfig } from "../src/config/defaults.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("Claude marketplace plugin manifests", () => {
  it("declares the leanrigor marketplace and plugin install target", () => {
    expect(marketplace.name).toBe("leanrigor");
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0]).toMatchObject({
      name: "leanrigor",
      source: "./",
      version: packageJson.version
    });
  });

  it("declares only plugin-root-relative component paths", () => {
    expect(plugin.name).toBe("leanrigor");
    expect(plugin.version).toBe(packageJson.version);
    for (const key of ["commands", "agents", "skills"] as const) {
      const entries = Array.isArray(plugin[key]) ? plugin[key] : [plugin[key]];
      for (const entry of entries) {
        expect(entry).toMatch(/^\.\//);
        expect(path.posix.normalize(entry).startsWith("../")).toBe(false);
      }
    }
    expect(plugin).not.toHaveProperty("hooks");
  });

  it("resolves marketplace references and every referenced asset", async () => {
    for (const entry of [...plugin.commands, ...plugin.agents, "./hooks/hooks.json", "./bin/leanrigor", "./runtime/leanrigor-cli.js"]) {
      await expect(access(path.join(repoRoot, entry))).resolves.toBeUndefined();
    }
    for (const skill of plugin.skills) {
      await expect(access(path.join(repoRoot, skill, "SKILL.md"))).resolves.toBeUndefined();
    }
  });

  it("command files invoke the plugin-owned runtime", async () => {
    for (const command of plugin.commands) {
      const content = await readFile(path.join(repoRoot, command), "utf8");
      expect(content).toContain("${CLAUDE_PLUGIN_ROOT}/bin/leanrigor");
      expect(content).not.toContain("leanrigor init --adapter claude");
    }
  });

  it("hook paths resolve through CLAUDE_PLUGIN_ROOT", async () => {
    const hooks = await readFile(path.join(repoRoot, "hooks", "hooks.json"), "utf8");
    expect(hooks).toContain("${CLAUDE_PLUGIN_ROOT}/hooks/protect-git.sh");
    const hookStat = await stat(path.join(repoRoot, "hooks", "protect-git.sh"));
    expect((hookStat.mode & 0o111) !== 0).toBe(true);
  });
});

describe("Claude marketplace plugin runtime", () => {
  it("invokes the bundled runtime through simulated CLAUDE_PLUGIN_ROOT", async () => {
    const result = await run(path.join(repoRoot, "bin", "leanrigor"), ["--version"], {
      env: { CLAUDE_PLUGIN_ROOT: repoRoot }
    });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  it("works when the plugin root and repository path contain spaces", async () => {
    const pluginRoot = path.join(await tempDir("leanrigor plugin root "), "plugin copy");
    const repo = path.join(await tempDir("leanrigor repo root "), "repo with spaces");
    await mkdir(repo, { recursive: true });
    await mkdir(pluginRoot, { recursive: true });
    await cp(path.join(repoRoot, "bin"), path.join(pluginRoot, "bin"), { recursive: true });
    await cp(path.join(repoRoot, "runtime"), path.join(pluginRoot, "runtime"), { recursive: true });

    const result = await run(path.join(pluginRoot, "bin", "leanrigor"), ["flow", "start", "Fix a typo in README documentation", "--provider", "deterministic", "--root", repo], {
      cwd: repo,
      env: { CLAUDE_PLUGIN_ROOT: pluginRoot }
    });

    expect(result.code).toBe(0);
    const state = JSON.parse(result.stdout) as { state: string; mode: string };
    expect(state).toMatchObject({ state: "awaiting_plan_approval", mode: "fast" });
    await expect(access(path.join(repo, ".leanrigor", "config.json"))).resolves.toBeUndefined();
    await expect(access(path.join(repo, ".leanrigor", "workflows"))).resolves.toBeUndefined();
    await expect(access(path.join(repo, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints a clear error when Node is unavailable", async () => {
    const result = await run("/bin/sh", [path.join(repoRoot, "bin", "leanrigor"), "--version"], {
      env: { PATH: "/tmp", CLAUDE_PLUGIN_ROOT: repoRoot }
    });

    expect(result.code).toBe(127);
    expect(result.stderr).toContain("Node.js 20 or newer is required");
  });

  it("coexists with project-local Claude asset installation", async () => {
    const repo = await tempDir("leanrigor-local-and-global-");
    await new ClaudeAdapter().install(repo, defaultConfig());
    await expect(access(path.join(repo, ".claude", "commands", "leanrigor.md"))).resolves.toBeUndefined();

    const result = await run(path.join(repoRoot, "bin", "leanrigor"), ["flow", "start", "Fix a typo in README documentation", "--provider", "deterministic", "--root", repo], {
      cwd: repo,
      env: { CLAUDE_PLUGIN_ROOT: repoRoot }
    });

    expect(result.code).toBe(0);
    await expect(access(path.join(repo, ".claude", "commands", "leanrigor.md"))).resolves.toBeUndefined();
    await expect(access(path.join(repo, ".leanrigor", "workflows"))).resolves.toBeUndefined();
  });
});

describe("Claude marketplace plugin package inclusion", () => {
  it("includes plugin files in npm package metadata", () => {
    expect(packageJson.files).toEqual(expect.arrayContaining([
      ".claude-plugin/",
      "commands/",
      "agents/",
      "hooks/",
      "bin/",
      "plugin-skills/",
      "runtime/"
    ]));
  });
});
