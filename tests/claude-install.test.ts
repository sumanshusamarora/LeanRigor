import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter, ASSET_VERSION } from "../src/adapters/claude/adapter.js";
import { defaultConfig } from "../src/config/defaults.js";
import { leanRigorConfigSchema } from "../src/config/schema.js";

const POSIX = process.platform !== "win32";

async function tempRepo(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "leanrigor-claude-test-"));
}

/** All target paths produced by a fresh install. */
const EXPECTED_DEST_PATHS = [
  path.join(".claude", "commands", "leanrigor.md"),
  path.join(".claude", "commands", "leanrigor-init.md"),
  path.join(".claude", "commands", "leanrigor-plan.md"),
  path.join(".claude", "commands", "leanrigor-status.md"),
  path.join(".claude", "commands", "leanrigor-review.md"),
  path.join(".claude", "commands", "leanrigor-commit.md"),
  path.join(".claude", "agents", "leanrigor-triage.md"),
  path.join(".claude", "leanrigor", "sequential-workflow.md"),
  path.join(".claude", "leanrigor", "protect-git.sh"),
  path.join(".claude", "settings.json"),
  path.join(".claude", "leanrigor", "methodology", "core.md"),
  path.join(".claude", "leanrigor", "methodology", "planning.md"),
  path.join(".claude", "leanrigor", "methodology", "design.md"),
  path.join(".claude", "leanrigor", "methodology", "implementation.md"),
  path.join(".claude", "leanrigor", "methodology", "debugging.md"),
  path.join(".claude", "leanrigor", "methodology", "testing.md"),
  path.join(".claude", "leanrigor", "methodology", "review.md"),
  path.join(".claude", "leanrigor", "methodology", "evidence.md"),
  path.join(".claude", "leanrigor", "methodology", "safeguards.md"),
  path.join(".claude", "leanrigor", "methodology", "modes", "fast.md"),
  path.join(".claude", "leanrigor", "methodology", "modes", "standard.md"),
  path.join(".claude", "leanrigor", "methodology", "modes", "rigorous.md"),
];

describe("Claude plugin clean installation", () => {
  it("installs all expected assets into an empty repository", async () => {
    const root = await tempRepo();
    const adapter = new ClaudeAdapter();
    const report = await adapter.install(root, defaultConfig());

    expect(report.installed).toHaveLength(EXPECTED_DEST_PATHS.length);
    expect(report.alreadyCurrent).toHaveLength(0);
    expect(report.skipped).toHaveLength(0);

    for (const dest of EXPECTED_DEST_PATHS) {
      const absPath = path.join(root, dest);
      const s = await stat(absPath);
      expect(s.isFile(), `expected file to exist: ${dest}`).toBe(true);
    }
  });

  it("creates an executable git protection hook on POSIX filesystems", async () => {
    if (!POSIX) return;
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    await expectExecutable(path.join(root, ".claude", "leanrigor", "protect-git.sh"));
  });

  it("each installed file contains the LeanRigor ownership token", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    for (const dest of EXPECTED_DEST_PATHS) {
      const content = await readFile(path.join(root, dest), "utf8");
      expect(content, `ownership token missing in: ${dest}`).toContain("generated_by: leanrigor");
    }
  });

  it("each command file contains the asset version", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    const commandFiles = EXPECTED_DEST_PATHS.filter(f => f.includes("commands"));
    for (const dest of commandFiles) {
      const content = await readFile(path.join(root, dest), "utf8");
      expect(content, `asset_version missing in: ${dest}`).toContain(`asset_version: ${ASSET_VERSION}`);
    }
  });

  it("creates required directories", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    const dirs = [
      path.join(root, ".claude", "commands"),
      path.join(root, ".claude", "agents"),
      path.join(root, ".claude", "leanrigor"),
      path.join(root, ".claude", "leanrigor", "methodology"),
      path.join(root, ".claude", "leanrigor", "methodology", "modes"),
    ];
    for (const dir of dirs) {
      const s = await stat(dir);
      expect(s.isDirectory(), `expected directory: ${dir}`).toBe(true);
    }
  });
});

describe("Claude plugin repeat-safe installation", () => {
  it("reports 'already current' on a second identical install", async () => {
    const root = await tempRepo();
    const adapter = new ClaudeAdapter();
    await adapter.install(root, defaultConfig());
    const secondReport = await adapter.install(root, defaultConfig());

    expect(secondReport.installed).toHaveLength(0);
    expect(secondReport.alreadyCurrent).toHaveLength(EXPECTED_DEST_PATHS.length);
    expect(secondReport.skipped).toHaveLength(0);
  });

  it("does not modify file content on repeated install", async () => {
    const root = await tempRepo();
    const adapter = new ClaudeAdapter();
    await adapter.install(root, defaultConfig());
    const contentsBefore = await Promise.all(
      EXPECTED_DEST_PATHS.map(dest => readFile(path.join(root, dest), "utf8"))
    );
    await adapter.install(root, defaultConfig());
    const contentsAfter = await Promise.all(
      EXPECTED_DEST_PATHS.map(dest => readFile(path.join(root, dest), "utf8"))
    );
    expect(contentsAfter).toEqual(contentsBefore);
  });

  it("repairs a missing executable bit when hook contents are unchanged", async () => {
    if (!POSIX) return;
    const root = await tempRepo();
    const adapter = new ClaudeAdapter();
    const hook = path.join(root, ".claude", "leanrigor", "protect-git.sh");
    await adapter.install(root, defaultConfig());
    await chmod(hook, 0o644);

    const report = await adapter.install(root, defaultConfig());

    expect(report.alreadyCurrent).toContain(path.join(".claude", "leanrigor", "protect-git.sh"));
    await expectExecutable(hook);
  });
});

describe("Claude plugin conflict handling", () => {
  it("does not overwrite a user-created file without LeanRigor ownership", async () => {
    const root = await tempRepo();
    await mkdir(path.join(root, ".claude", "commands"), { recursive: true });
    const commandPath = path.join(root, ".claude", "commands", "leanrigor.md");
    await writeFile(commandPath, "my custom content\n");

    const report = await new ClaudeAdapter().install(root, defaultConfig());

    expect(report.skipped).toContain(path.join(".claude", "commands", "leanrigor.md"));
    const content = await readFile(commandPath, "utf8");
    expect(content).toBe("my custom content\n");
  });

  it("does not overwrite a user-modified LeanRigor-owned file without --force", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    // User modifies an owned file
    const target = path.join(root, ".claude", "commands", "leanrigor-plan.md");
    const original = await readFile(target, "utf8");
    await writeFile(target, original + "\n## My custom addition\n");

    const secondReport = await new ClaudeAdapter().install(root, defaultConfig());

    expect(secondReport.skipped).toContain(path.join(".claude", "commands", "leanrigor-plan.md"));
    const after = await readFile(target, "utf8");
    expect(after).toContain("My custom addition");
  });

  it("replaces user-modified LeanRigor-owned files when force=true", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    const target = path.join(root, ".claude", "commands", "leanrigor-status.md");
    const original = await readFile(target, "utf8");
    await writeFile(target, original + "\n## My custom addition\n");

    const forceReport = await new ClaudeAdapter().install(root, defaultConfig(), true);

    expect(forceReport.installed).toContain(path.join(".claude", "commands", "leanrigor-status.md"));
    const after = await readFile(target, "utf8");
    expect(after).not.toContain("My custom addition");
    expect(after).toContain("generated_by: leanrigor");
  });

  it("does not silently overwrite a user-modified hook or repair its mode without force", async () => {
    if (!POSIX) return;
    const root = await tempRepo();
    const hook = path.join(root, ".claude", "leanrigor", "protect-git.sh");
    await new ClaudeAdapter().install(root, defaultConfig());
    const original = await readFile(hook, "utf8");
    await writeFile(hook, `${original}\n# user modification\n`, "utf8");
    await chmod(hook, 0o644);

    const report = await new ClaudeAdapter().install(root, defaultConfig());

    expect(report.skipped).toContain(path.join(".claude", "leanrigor", "protect-git.sh"));
    expect(await readFile(hook, "utf8")).toContain("user modification");
    expect(await executableMode(hook)).toBe(false);
  });

  it("force restores hook contents and executable mode", async () => {
    if (!POSIX) return;
    const root = await tempRepo();
    const hook = path.join(root, ".claude", "leanrigor", "protect-git.sh");
    await new ClaudeAdapter().install(root, defaultConfig());
    await writeFile(hook, `${await readFile(hook, "utf8")}\n# user modification\n`, "utf8");
    await chmod(hook, 0o644);

    const report = await new ClaudeAdapter().install(root, defaultConfig(), true);

    expect(report.installed).toContain(path.join(".claude", "leanrigor", "protect-git.sh"));
    expect(await readFile(hook, "utf8")).not.toContain("user modification");
    await expectExecutable(hook);
  });

  it("never overwrites a non-owned file even with force=true", async () => {
    const root = await tempRepo();
    await mkdir(path.join(root, ".claude", "commands"), { recursive: true });
    const commandPath = path.join(root, ".claude", "commands", "leanrigor-commit.md");
    await writeFile(commandPath, "user-created, no ownership marker\n");

    const forceReport = await new ClaudeAdapter().install(root, defaultConfig(), true);

    expect(forceReport.skipped).toContain(path.join(".claude", "commands", "leanrigor-commit.md"));
    const content = await readFile(commandPath, "utf8");
    expect(content).toBe("user-created, no ownership marker\n");
  });
});

describe("Claude plugin triage agent model tier", () => {
  it("embeds the configured Small tier model in the triage agent", async () => {
    const root = await tempRepo();
    // Use explicit model mapping to avoid environment-dependent resolution
    const config = leanRigorConfigSchema.parse({ models: { tiers: { small: { claude: "haiku" } } } });
    await new ClaudeAdapter().install(root, config);

    const agent = await readFile(path.join(root, ".claude", "agents", "leanrigor-triage.md"), "utf8");
    expect(agent).toContain("model: haiku");
    // Template variable should be fully substituted
    expect(agent).not.toContain("{{TRIAGE_MODEL}}");
  });

  it("omits explicit model from the triage agent when routing.triage is inherit", async () => {
    const root = await tempRepo();
    const config = leanRigorConfigSchema.parse({ routing: { triage: "inherit" }, models: { tiers: { small: { claude: "haiku" } } } });
    await new ClaudeAdapter().install(root, config);

    const agent = await readFile(path.join(root, ".claude", "agents", "leanrigor-triage.md"), "utf8");
    // 'inherit' tier has no explicit model — adapter should use "haiku" as safe fallback
    expect(agent).not.toContain("{{TRIAGE_MODEL}}");
    expect(agent).toContain("model: haiku");
  });

  it("uses a custom configured Small tier model", async () => {
    const root = await tempRepo();
    const config = leanRigorConfigSchema.parse({ models: { tiers: { small: { claude: "claude-haiku-custom-id" } } } });
    await new ClaudeAdapter().install(root, config);

    const agent = await readFile(path.join(root, ".claude", "agents", "leanrigor-triage.md"), "utf8");
    expect(agent).toContain("model: claude-haiku-custom-id");
  });

  it("triage agent specifies only read-only tools", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    const agent = await readFile(path.join(root, ".claude", "agents", "leanrigor-triage.md"), "utf8");
    expect(agent).toContain("tools: Read, Glob, Grep");
    expect(agent).not.toContain("Bash");
    expect(agent).not.toContain("Write");
    expect(agent).not.toContain("Edit");
  });
});

describe("Claude plugin uninstall", () => {
  it("removes all unmodified LeanRigor-owned files", async () => {
    const root = await tempRepo();
    const adapter = new ClaudeAdapter();
    await adapter.install(root, defaultConfig());
    const report = await adapter.uninstall(root);

    // settings.json is shared — it is handled via removeLeanRigorHooks, not removed as a file
    const fileDestPaths = EXPECTED_DEST_PATHS.filter(p => p !== path.join(".claude", "settings.json"));
    expect(report.removed).toHaveLength(fileDestPaths.length);
    expect(report.skipped).toHaveLength(0);

    for (const dest of fileDestPaths) {
      await expect(stat(path.join(root, dest))).rejects.toMatchObject({ code: "ENOENT" });
    }
    // settings.json should still exist (shared file, hooks removed)
    await expect(stat(path.join(root, ".claude", "settings.json"))).resolves.toBeDefined();
  });

  it("preserves user-modified owned files during uninstall", async () => {
    const root = await tempRepo();
    const adapter = new ClaudeAdapter();
    await adapter.install(root, defaultConfig());

    const target = path.join(root, ".claude", "commands", "leanrigor.md");
    const original = await readFile(target, "utf8");
    await writeFile(target, original + "\n## User addition\n");

    const report = await adapter.uninstall(root);

    expect(report.skipped).toContain(path.join(".claude", "commands", "leanrigor.md"));
    const content = await readFile(target, "utf8");
    expect(content).toContain("User addition");
  });

  it("preserves unrelated user .claude files during uninstall", async () => {
    const root = await tempRepo();
    const adapter = new ClaudeAdapter();
    await mkdir(path.join(root, ".claude", "commands"), { recursive: true });
    await writeFile(path.join(root, ".claude", "commands", "my-custom-command.md"), "custom\n");
    await adapter.install(root, defaultConfig());

    await adapter.uninstall(root);

    const content = await readFile(path.join(root, ".claude", "commands", "my-custom-command.md"), "utf8");
    expect(content).toBe("custom\n");
  });

  it("uninstall of a never-installed repository produces empty reports", async () => {
    const root = await tempRepo();
    const report = await new ClaudeAdapter().uninstall(root);
    expect(report.removed).toHaveLength(0);
    expect(report.skipped).toHaveLength(0);
  });
});

describe("Claude plugin doctor", () => {
  it("reports status 'current' after a fresh install", async () => {
    const root = await tempRepo();
    const adapter = new ClaudeAdapter();
    await adapter.install(root, defaultConfig());
    const output = await adapter.doctor(root, defaultConfig());
    const text = output.join("\n");

    expect(text).toContain("Status: current");
    expect(text).toContain("Git protection hook:");
    expect(text).toContain("current and executable");
    expect(text).toContain(`Package version:`);
    // settings.json is excluded from total (handled by settings-merger)
    const assetCount = EXPECTED_DEST_PATHS.filter(p => p !== path.join(".claude", "settings.json")).length;
    expect(text).toContain(`Fallback assets: ${assetCount}/${assetCount}`);
  });

  it("detects an installed but non-executable hook", async () => {
    if (!POSIX) return;
    const root = await tempRepo();
    const hook = path.join(root, ".claude", "leanrigor", "protect-git.sh");
    await new ClaudeAdapter().install(root, defaultConfig());
    await chmod(hook, 0o644);

    const text = (await new ClaudeAdapter().doctor(root, defaultConfig())).join("\n");

    expect(text).toContain("Git protection hook:");
    expect(text).toContain("installed but not executable");
  });

  it("reports missing assets when nothing is installed", async () => {
    const root = await tempRepo();
    const output = await new ClaudeAdapter().doctor(root, defaultConfig());
    const text = output.join("\n");

    expect(text).toContain("Fallback assets: 0/");
    expect(text).toContain("Missing");
    expect(text).not.toContain("Status: current");
  });

  it("reports modified owned files separately from missing files", async () => {
    const root = await tempRepo();
    const adapter = new ClaudeAdapter();
    await adapter.install(root, defaultConfig());

    const target = path.join(root, ".claude", "commands", "leanrigor-review.md");
    const original = await readFile(target, "utf8");
    await writeFile(target, original + "\n## Modified\n");

    const output = await adapter.doctor(root, defaultConfig());
    const text = output.join("\n");

    expect(text).toContain("Modified");
    expect(text).toContain("leanrigor-review.md");
  });

  it("reports model tier resolution in doctor output", async () => {
    const root = await tempRepo();
    // Use explicit model mappings for deterministic test output
    const config = leanRigorConfigSchema.parse({
      models: { tiers: { small: { claude: "haiku" }, medium: { claude: "sonnet" }, large: { claude: "opus" } } }
    });
    const output = await new ClaudeAdapter().doctor(root, config);
    const text = output.join("\n");

    expect(text).toContain("small:");
    expect(text).toContain("haiku");
    expect(text).toContain("medium:");
    expect(text).toContain("sonnet");
    expect(text).toContain("large:");
    expect(text).toContain("opus");
  });

  it("includes asset version in doctor output", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());
    const output = await new ClaudeAdapter().doctor(root, defaultConfig());
    const text = output.join("\n");

    expect(text).toContain(`Asset version: ${ASSET_VERSION}`);
  });
});

describe("Claude plugin asset structure validation", () => {
  it("all packaged command assets contain $ARGUMENTS", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    const commandsWithArgs = [
      path.join(".claude", "commands", "leanrigor.md"),
      path.join(".claude", "commands", "leanrigor-plan.md"),
    ];
    for (const dest of commandsWithArgs) {
      const content = await readFile(path.join(root, dest), "utf8");
      expect(content, `$ARGUMENTS missing in: ${dest}`).toContain("$ARGUMENTS");
    }
  });

  it("triage agent frontmatter contains required fields", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    const agent = await readFile(path.join(root, ".claude", "agents", "leanrigor-triage.md"), "utf8");
    expect(agent).toMatch(/name:\s*leanrigor-triage/);
    expect(agent).toMatch(/description:/);
    expect(agent).toMatch(/model:/);
    expect(agent).toMatch(/tools:/);
    expect(agent).toContain("generated_by: leanrigor");
  });

  it("settings.json is valid JSON", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    const content = await readFile(path.join(root, ".claude", "settings.json"), "utf8");
    expect(() => JSON.parse(content)).not.toThrow();
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed).toHaveProperty("hooks");
    // Ownership token is in the _leanrigor metadata field
    expect(content).toContain("generated_by: leanrigor");
  });

  it("protect-git.sh is executable or installable as a script", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    const scriptPath = path.join(root, ".claude", "leanrigor", "protect-git.sh");
    const content = await readFile(scriptPath, "utf8");
    expect(content).toMatch(/^#!\/bin\/sh/);
    expect(content).toContain("generated_by: leanrigor");
    if (POSIX) await expectExecutable(scriptPath);
    // Script should fail-open on empty input
    expect(content).toContain("exit 0");
  });

  it("allows ordinary Bash commands without hook errors", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());
    const hook = path.join(root, ".claude", "leanrigor", "protect-git.sh");

    const result = await runHook(hook, { command: "npm test" });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("blocks prohibited Git commands with the expected hook decision", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());
    const hook = path.join(root, ".claude", "leanrigor", "protect-git.sh");

    const result = await runHook(hook, { command: "git commit -m test" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("git commit");
    expect(result.stderr).toContain("blocked");
  });
});

async function executableMode(file: string): Promise<boolean> {
  return ((await stat(file)).mode & 0o111) !== 0;
}

async function expectExecutable(file: string): Promise<void> {
  expect(await executableMode(file), `${file} should have an executable bit`).toBe(true);
}

async function runHook(file: string, input: unknown): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [file], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

// ---------------------------------------------------------------------------
// Cleanup tests
// ---------------------------------------------------------------------------

import { cleanupProjectLocalAssets, detectInstallationMode, type CleanupScope } from "../src/adapters/claude/adapter.js";

describe("Cleanup — project-local assets", () => {
  it("dry-run lists exact paths for removal without modifying", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    const report = await cleanupProjectLocalAssets(root, {
      dryRun: true,
      scope: "project-local" as CleanupScope,
      force: false,
    });

    expect(report.dryRun).toBe(true);
    expect(report.items.length).toBeGreaterThan(0);
    expect(report.items.some(i => i.path.includes("leanrigor.md"))).toBe(true);

    // Files should still exist after dry-run
    await expect(access(path.join(root, ".claude", "commands", "leanrigor.md"))).resolves.toBeUndefined();
  });

  it("removes owned files when not dry-run", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    const report = await cleanupProjectLocalAssets(root, {
      dryRun: false,
      scope: "project-local" as CleanupScope,
      force: false,
    });

    expect(report.dryRun).toBe(false);
    expect(report.items.length).toBeGreaterThan(0);

    // Owned assets should be gone
    await expect(access(path.join(root, ".claude", "commands", "leanrigor.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(root, ".claude", "agents", "leanrigor-triage.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(root, ".claude", "leanrigor", "protect-git.sh"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves modified owned files without --force", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    // Modify an owned file
    const target = path.join(root, ".claude", "commands", "leanrigor-plan.md");
    const original = await readFile(target, "utf8");
    await writeFile(target, original + "\n# My changes\n");

    const report = await cleanupProjectLocalAssets(root, {
      dryRun: false,
      scope: "project-local" as CleanupScope,
      force: false,
    });

    // Modified file should be skipped
    const skipped = report.skipped.filter(s => s.path.includes("leanrigor-plan.md"));
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0].action).toBe("skip-modified");

    // File should still exist and contain our changes
    const content = await readFile(target, "utf8");
    expect(content).toContain("My changes");
  });

  it("removes modified owned files with --force", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());

    // Modify an owned file
    const target = path.join(root, ".claude", "commands", "leanrigor-review.md");
    const original = await readFile(target, "utf8");
    await writeFile(target, original + "\n# My changes\n");

    const report = await cleanupProjectLocalAssets(root, {
      dryRun: false,
      scope: "project-local" as CleanupScope,
      force: true,
    });

    // Modified file should be removed with force
    expect(report.skipped.filter(s => s.path.includes("leanrigor-review.md")).length).toBe(0);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves unrelated .claude/ files", async () => {
    const root = await tempRepo();
    await mkdir(path.join(root, ".claude", "commands"), { recursive: true });
    await writeFile(path.join(root, ".claude", "commands", "my-custom-command.md"), "custom\n");
    await writeFile(path.join(root, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Read"] } }), "utf8");
    await new ClaudeAdapter().install(root, defaultConfig());

    await cleanupProjectLocalAssets(root, {
      dryRun: false,
      scope: "project-local" as CleanupScope,
      force: false,
    });

    // Unrelated files should be preserved
    await expect(readFile(path.join(root, ".claude", "commands", "my-custom-command.md"), "utf8")).resolves.toBe("custom\n");
    await expect(access(path.join(root, ".claude", "settings.local.json"))).resolves.toBeUndefined();
  });

  it("preserves unrelated settings.json entries", async () => {
    const root = await tempRepo();
    const settingsPath = path.join(root, ".claude", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      permissions: { allow: ["Read", "Grep"] },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "sh .claude/leanrigor/protect-git.sh" }] }
        ]
      }
    }, null, 2), "utf8");

    await cleanupProjectLocalAssets(root, {
      dryRun: false,
      scope: "project-local" as CleanupScope,
      force: false,
    });

    // settings.json should still exist but without LR hooks
    const content = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed).toHaveProperty("permissions");
    expect(content).not.toContain("protect-git.sh");
  });

  it("runtime-state cleanup removes .leanrigor/", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());
    await mkdir(path.join(root, ".leanrigor"), { recursive: true });
    await writeFile(path.join(root, ".leanrigor", "config.json"), "{}", "utf8");

    const report = await cleanupProjectLocalAssets(root, {
      dryRun: false,
      scope: "runtime-state" as CleanupScope,
      force: false,
    });

    expect(report.items.some(i => i.path === ".leanrigor/")).toBe(true);
    await expect(access(path.join(root, ".leanrigor"))).rejects.toMatchObject({ code: "ENOENT" });
    // .claude/ should still exist (runtime-state only removes .leanrigor/)
    await expect(access(path.join(root, ".claude"))).resolves.toBeUndefined();
  });

  it("runtime-state dry-run shows what would be removed without touching", async () => {
    const root = await tempRepo();
    await mkdir(path.join(root, ".leanrigor"), { recursive: true });
    await writeFile(path.join(root, ".leanrigor", "config.json"), "{}", "utf8");

    const report = await cleanupProjectLocalAssets(root, {
      dryRun: true,
      scope: "runtime-state" as CleanupScope,
      force: false,
    });

    expect(report.dryRun).toBe(true);
    expect(report.items.some(i => i.path === ".leanrigor/")).toBe(true);
    // .leanrigor/ should still exist after dry-run
    await expect(access(path.join(root, ".leanrigor"))).resolves.toBeUndefined();
  });
});

describe("Migration — mixed to clean marketplace", () => {
  it("removes fallback assets while preserving .leanrigor/ state", async () => {
    const root = await tempRepo();
    // Seed mixed state
    await new ClaudeAdapter().install(root, defaultConfig());
    await mkdir(path.join(root, ".leanrigor", "workflows"), { recursive: true });
    await writeFile(path.join(root, ".leanrigor", ".gitignore"), "*\n!.gitignore\n", "utf8");

    // Cleanup only project-local assets (not runtime state)
    await cleanupProjectLocalAssets(root, {
      dryRun: false,
      scope: "project-local" as CleanupScope,
      force: false,
    });

    // .leanrigor/ should still exist
    await expect(access(path.join(root, ".leanrigor", ".gitignore"))).resolves.toBeUndefined();

    // .claude/ fallback assets should be gone
    await expect(access(path.join(root, ".claude", "commands", "leanrigor.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(root, ".claude", "agents", "leanrigor-triage.md"))).rejects.toMatchObject({ code: "ENOENT" });

    // After migration, detect as unknown (no marketplace env, no project-local assets)
    const mode = await detectInstallationMode(root);
    expect(mode).toBe("unknown");
  });

  it("full migration path: seed mixed -> dry-run -> cleanup -> verify", async () => {
    const root = await tempRepo();
    // 1. Seed mixed installation
    await new ClaudeAdapter().install(root, defaultConfig());
    await mkdir(path.join(root, ".leanrigor", "workflows"), { recursive: true });
    await writeFile(path.join(root, ".leanrigor", ".gitignore"), "*\n!.gitignore\n", "utf8");

    // 2. Dry-run
    const dryRun = await cleanupProjectLocalAssets(root, {
      dryRun: true,
      scope: "project-local" as CleanupScope,
      force: false,
    });
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.items.length).toBeGreaterThan(0);
    // Verify .claude/ assets still exist after dry-run
    await expect(access(path.join(root, ".claude", "commands", "leanrigor.md"))).resolves.toBeUndefined();

    // 3. Execute cleanup
    const live = await cleanupProjectLocalAssets(root, {
      dryRun: false,
      scope: "project-local" as CleanupScope,
      force: false,
    });
    expect(live.dryRun).toBe(false);
    expect(live.items.length).toBeGreaterThan(0);

    // 4. Verify only .leanrigor/ remains
    await expect(access(path.join(root, ".claude", "commands", "leanrigor.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(root, ".leanrigor", ".gitignore"))).resolves.toBeUndefined();
  });
});
