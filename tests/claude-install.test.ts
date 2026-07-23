import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter, ASSET_VERSION } from "../src/adapters/claude/adapter.js";
import { defaultConfig } from "../src/config/defaults.js";
import { leanRigorConfigSchema } from "../src/config/schema.js";

async function tempRepo(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "leanrigor-claude-test-"));
}

/** All target paths produced by a fresh install. */
const EXPECTED_DEST_PATHS = [
  path.join(".claude", "commands", "leanrigor.md"),
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
    await new ClaudeAdapter().install(root, defaultConfig());

    const agent = await readFile(path.join(root, ".claude", "agents", "leanrigor-triage.md"), "utf8");
    expect(agent).toContain("model: haiku");
  });

  it("omits explicit model from the triage agent when routing.triage is inherit", async () => {
    const root = await tempRepo();
    const config = leanRigorConfigSchema.parse({ routing: { triage: "inherit" } });
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

    expect(report.removed).toHaveLength(EXPECTED_DEST_PATHS.length);
    expect(report.skipped).toHaveLength(0);

    for (const dest of EXPECTED_DEST_PATHS) {
      await expect(stat(path.join(root, dest))).rejects.toMatchObject({ code: "ENOENT" });
    }
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
    expect(text).toContain(`LeanRigor CLI:`);
    expect(text).toContain(`Claude assets installed: ${EXPECTED_DEST_PATHS.length}/${EXPECTED_DEST_PATHS.length}`);
  });

  it("reports missing assets when nothing is installed", async () => {
    const root = await tempRepo();
    const output = await new ClaudeAdapter().doctor(root, defaultConfig());
    const text = output.join("\n");

    expect(text).toContain("Claude assets installed: 0/");
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
    const output = await new ClaudeAdapter().doctor(root, defaultConfig());
    const text = output.join("\n");

    expect(text).toContain("small: haiku");
    expect(text).toContain("medium: sonnet");
    expect(text).toContain("large: opus");
  });

  it("includes asset version in doctor output", async () => {
    const root = await tempRepo();
    await new ClaudeAdapter().install(root, defaultConfig());
    const output = await new ClaudeAdapter().doctor(root, defaultConfig());
    const text = output.join("\n");

    expect(text).toContain(`Claude assets available: ${ASSET_VERSION}`);
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
    expect(content).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(content).toContain("generated_by: leanrigor");
    // Script should fail-open on empty input
    expect(content).toContain("exit 0");
  });
});
